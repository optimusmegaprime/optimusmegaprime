/**
 * RiskClaw — Portfolio Risk Monitor
 *
 * LLM routing: claude CLI subprocess (`claude -p "..."`) — uses Max subscription,
 * no API tokens. Arithmetic limits enforced synchronously first.
 *
 * Hard limits (arithmetic, always enforced):
 *   1. Drawdown > 40% from peak portfolio value
 *   2. Pending position size > 25% of portfolio
 *
 * Soft limits (Claude CLI can add halt, cannot remove arithmetic halt):
 *   - Narrative risk assessment every 60s
 *
 * Additional checks:
 *   - Win rate tracking: alert if < 40% over last 10 closed trades
 *   - Liquidity validation: skip trade if Uniswap V3 pool depth < $50k
 *   - Volatility-adjusted sizing: CHOPPY (RSI range > 30 in 10 candles) → 0.5x multiplier
 *
 * Privacy lock: immutable system prompt prefix on every Claude CLI call.
 *
 * Run: npm run risk
 */

import * as fs   from "fs";
import * as path from "path";
import * as https from "https";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { config as loadEnv } from "dotenv";
import { initVault, appendToNote } from "./obsidian-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

export const MODEL_ID = "claude-cli";

let lastAlignmentDate = "";

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_DRAWDOWN        = 0.40;
const MAX_POSITION_SIZE   = 0.25;
const MIN_PORTFOLIO_USD   = 0.10;
const POLL_INTERVAL_MS    = 60_000;
const LIQUIDITY_MIN_USD   = 50_000;
const WIN_RATE_ALERT_PCT  = 0.40;
const WIN_RATE_LOOKBACK   = 10;
const RSI_CHOP_THRESHOLD  = 30;
const RSI_HISTORY_SIZE    = 10;
const GOLDSKY_PATH        = "/api/public/project_cl8ylkiw00krx0hvza0qw17vn/subgraphs/uniswap-v3-base/1.0.0/gn";
const WETH_BASE           = "0x4200000000000000000000000000000000000006";
const USDC_BASE_LC        = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const POSITION_SIZE_MAP: Record<string, number> = { STRONG: 0.20, MODERATE: 0.20 };

const ANALYST_STATE = path.join(__dirname, "../shared/analyst-state.json");
const TRADE_STATE   = path.join(__dirname, "../shared/trade-state.json");
const RISK_STATE    = path.join(__dirname, "../shared/risk-state.json");

// ── Privacy lock: immutable system prompt prefix ──────────────────────────────
// This prefix is prepended to every Claude CLI call and cannot be overridden.
const PRIVACY_PREFIX =
  "You are a trading risk assessment AI. You are strictly prohibited from mentioning " +
  "any personal names, user information, or any topic unrelated to market conditions, " +
  "trading risk, portfolio analysis, and financial market context. Respond only with " +
  "risk assessments, market condition reports, and trading considerations.\n\n";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AnalystState {
  timestamp: string;
  price:     number;
  signal:    "BUY" | "SELL" | "HOLD";
  strength:  "STRONG" | "MODERATE" | "WEAK";
  candleStart: string;
  rsi:       number | null;
}

interface TradeLogEntry {
  timestamp: string;
  action:    "BUY" | "SELL";
  pnlUsd:    number | null;
}

interface TradeState {
  timestamp:    string;
  ethBalance:   string;
  usdcBalance:  string;
  executedCount: number;
  skippedCount:  number;
  tradeLog:     TradeLogEntry[];
  lastTrade: {
    timestamp: string; action: "BUY" | "SELL";
    fromAmount: string; fromTokenName: string;
    toAmount: string; toTokenName: string; txHash: string;
  } | null;
}

export interface RiskState {
  timestamp:             string;
  model:                 string;
  halted:                boolean;
  haltReason:            string | null;
  portfolioValueUsd:     number;
  peakPortfolioValueUsd: number;
  drawdown:              number;
  drawdownPct:           string;
  ethBalance:            string;
  usdcBalance:           string;
  ethPriceUsd:           number;
  pendingSignal:         string;
  pendingStrength:       string;
  pendingPositionSizePct: number;
  checks: {
    drawdown:     { ok: boolean; value: number; limit: number };
    positionSize: { ok: boolean; value: number; limit: number };
  };
  tradeCount:   number;
  riskNarrative: string | null;
  claudeMs:      number | null;
  // Win rate tracking
  winRate:           number | null;
  avgPnlUsd:         number | null;
  consecutiveWins:   number;
  consecutiveLosses: number;
  winRateWarning:    boolean;
  // Liquidity validation
  liquidityDepthUsd: number | null;
  liquidityWarning:  boolean;
  // Volatility regime
  volatilityRegime:    "CHOPPY" | "NORMAL" | "TRENDING";
  volatilityMultiplier: number;
  rsiRange10:           number | null;
}

// ── Module state ──────────────────────────────────────────────────────────────
const rsiHistory: number[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch { return null; }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

// ── Win rate tracking ─────────────────────────────────────────────────────────
function computeWinStats(log: TradeLogEntry[]): {
  winRate: number | null; avgPnlUsd: number | null;
  consecutiveWins: number; consecutiveLosses: number; winRateWarning: boolean;
} {
  const closed = log.filter(t => t.pnlUsd !== null && t.pnlUsd !== undefined);
  if (!closed.length) return { winRate: null, avgPnlUsd: null, consecutiveWins: 0, consecutiveLosses: 0, winRateWarning: false };

  const wins      = closed.filter(t => (t.pnlUsd ?? 0) > 0).length;
  const winRate   = wins / closed.length;
  const avgPnlUsd = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0) / closed.length;

  // Consecutive streak from most recent trade
  let consecutiveWins = 0, consecutiveLosses = 0;
  const lastIsWin = (closed[closed.length - 1].pnlUsd ?? 0) > 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const isWin = (closed[i].pnlUsd ?? 0) > 0;
    if (isWin !== lastIsWin) break;
    if (isWin) consecutiveWins++; else consecutiveLosses++;
  }

  // Win rate warning: last WIN_RATE_LOOKBACK closed trades < threshold
  const last10        = closed.slice(-WIN_RATE_LOOKBACK);
  const wins10        = last10.filter(t => (t.pnlUsd ?? 0) > 0).length;
  const winRateWarning = last10.length >= WIN_RATE_LOOKBACK &&
                         (wins10 / last10.length) < WIN_RATE_ALERT_PCT;

  return { winRate, avgPnlUsd, consecutiveWins, consecutiveLosses, winRateWarning };
}

// ── Volatility regime ─────────────────────────────────────────────────────────
function pushRsi(rsi: number | null): void {
  if (rsi === null || isNaN(rsi)) return;
  rsiHistory.push(rsi);
  if (rsiHistory.length > RSI_HISTORY_SIZE) rsiHistory.shift();
}

function getVolatility(): {
  regime: "CHOPPY" | "NORMAL" | "TRENDING"; multiplier: number; rsiRange: number | null;
} {
  if (rsiHistory.length < 3) return { regime: "NORMAL", multiplier: 1.0, rsiRange: null };
  const rsiRange = Math.max(...rsiHistory) - Math.min(...rsiHistory);
  const regime   = rsiRange > RSI_CHOP_THRESHOLD ? "CHOPPY" : "NORMAL";
  return { regime, multiplier: regime === "CHOPPY" ? 0.5 : 1.0, rsiRange };
}

// ── Liquidity depth via Goldsky Uniswap V3 ───────────────────────────────────
function fetchLiquidityDepth(): Promise<{ depthUsd: number | null; warning: boolean }> {
  const body = JSON.stringify({ query:
    `{pools(where:{token0_in:["${WETH_BASE}","${USDC_BASE_LC}"],token1_in:["${WETH_BASE}","${USDC_BASE_LC}"]},orderBy:totalValueLockedUSD,orderDirection:desc,first:1){id totalValueLockedUSD}}`
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.goldsky.com",
      path:     GOLDSKY_PATH,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "OptimusMegaPrime/1.0" },
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        try {
          const pool = JSON.parse(d).data?.pools?.[0];
          if (!pool) { resolve({ depthUsd: null, warning: false }); return; }
          const tvl   = parseFloat(pool.totalValueLockedUSD ?? "0");
          // Estimate ±0.5% depth as ~10% of TVL (conservative for concentrated V3 liquidity)
          const depth = tvl * 0.10;
          resolve({ depthUsd: parseFloat(depth.toFixed(2)), warning: depth < LIQUIDITY_MIN_USD });
        } catch { resolve({ depthUsd: null, warning: false }); }
      });
    });
    req.on("error", () => resolve({ depthUsd: null, warning: false }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ depthUsd: null, warning: false }); });
    req.end(body);
  });
}

// ── Core risk evaluation ──────────────────────────────────────────────────────
function evaluate(
  peakSoFar: number,
  analyst:   AnalystState | null,
  trade:     TradeState   | null,
  winStats:  ReturnType<typeof computeWinStats>,
  vol:       ReturnType<typeof getVolatility>,
  liq:       { depthUsd: number | null; warning: boolean },
): { state: RiskState; newPeak: number } {
  const ethPrice  = analyst?.price ?? 0;
  const ethBal    = parseFloat(trade?.ethBalance  ?? "0");
  const usdcBal   = parseFloat(trade?.usdcBalance ?? "0");
  const tradeCount = trade?.executedCount ?? 0;
  const portfolioUsd = ethBal * ethPrice + usdcBal;

  const newPeak  = Math.max(peakSoFar, portfolioUsd);
  const drawdown = newPeak > MIN_PORTFOLIO_USD && portfolioUsd < newPeak
    ? (newPeak - portfolioUsd) / newPeak : 0;

  const signal   = analyst?.signal   ?? "HOLD";
  const strength = analyst?.strength ?? "WEAK";
  const actionable = (signal === "BUY" || signal === "SELL") &&
                     (strength === "STRONG" || strength === "MODERATE");

  let pendingPositionSizePct = 0;
  if (actionable && portfolioUsd > MIN_PORTFOLIO_USD) {
    const fraction = (POSITION_SIZE_MAP[strength] ?? 0) * vol.multiplier;
    pendingPositionSizePct = signal === "BUY"
      ? (usdcBal * fraction) / portfolioUsd
      : (ethBal * ethPrice * fraction) / portfolioUsd;
  }

  const drawdownOk     = drawdown <= MAX_DRAWDOWN;
  const positionSizeOk = pendingPositionSizePct <= MAX_POSITION_SIZE;

  let halted     = false;
  let haltReason: string | null = null;

  if (!drawdownOk) {
    halted = true;
    haltReason =
      `Max drawdown exceeded: ${pct(drawdown)} (limit ${pct(MAX_DRAWDOWN)}) — ` +
      `portfolio $${portfolioUsd.toFixed(2)} vs peak $${newPeak.toFixed(2)}`;
  } else if (!positionSizeOk && actionable) {
    halted = true;
    haltReason =
      `Position size ${pct(pendingPositionSizePct)} exceeds limit ${pct(MAX_POSITION_SIZE)} — ` +
      `${signal} ${strength} on $${portfolioUsd.toFixed(2)} portfolio`;
  }

  const state: RiskState = {
    timestamp:             new Date().toISOString(),
    model:                 MODEL_ID,
    halted,
    haltReason,
    portfolioValueUsd:     parseFloat(portfolioUsd.toFixed(4)),
    peakPortfolioValueUsd: parseFloat(newPeak.toFixed(4)),
    drawdown:              parseFloat(drawdown.toFixed(6)),
    drawdownPct:           pct(drawdown),
    ethBalance:            ethBal.toFixed(6),
    usdcBalance:           usdcBal.toFixed(2),
    ethPriceUsd:           ethPrice,
    pendingSignal:         signal,
    pendingStrength:       strength,
    pendingPositionSizePct: parseFloat(pendingPositionSizePct.toFixed(6)),
    checks: {
      drawdown:     { ok: drawdownOk,     value: drawdown,               limit: MAX_DRAWDOWN      },
      positionSize: { ok: positionSizeOk, value: pendingPositionSizePct, limit: MAX_POSITION_SIZE },
    },
    tradeCount,
    riskNarrative:     null,
    claudeMs:          null,
    winRate:           winStats.winRate,
    avgPnlUsd:         winStats.avgPnlUsd,
    consecutiveWins:   winStats.consecutiveWins,
    consecutiveLosses: winStats.consecutiveLosses,
    winRateWarning:    winStats.winRateWarning,
    liquidityDepthUsd: liq.depthUsd,
    liquidityWarning:  liq.warning,
    volatilityRegime:    vol.regime,
    volatilityMultiplier: vol.multiplier,
    rsiRange10:          vol.rsiRange !== null ? parseFloat(vol.rsiRange.toFixed(2)) : null,
  };

  return { state, newPeak };
}

// ── Claude CLI subprocess ─────────────────────────────────────────────────────
function buildRiskPrompt(state: RiskState): string {
  return (
    PRIVACY_PREFIX +
`You are RiskClaw, the risk guardian for an autonomous ETH/USDC trading system on Base.
Arithmetic hard limits have already been checked. Your role: narrative risk assessment.
You can HALT trading for soft reasons. You CANNOT lift a halt that arithmetic already set.

── PORTFOLIO ──────────────────────────────────────────────────────────────────
Current value : $${state.portfolioValueUsd.toFixed(2)}
Peak value    : $${state.peakPortfolioValueUsd.toFixed(2)}
Drawdown      : ${state.drawdownPct}  (hard limit: 40%)
ETH balance   : ${state.ethBalance}
USDC balance  : ${state.usdcBalance}
ETH price     : $${state.ethPriceUsd.toFixed(2)}

── PENDING SIGNAL ─────────────────────────────────────────────────────────────
Signal        : ${state.pendingSignal} (${state.pendingStrength})
Position size : ${(state.pendingPositionSizePct * 100).toFixed(2)}%  (hard limit: 25%)

── ARITHMETIC CHECKS ──────────────────────────────────────────────────────────
Drawdown      : ${state.checks.drawdown.ok     ? "PASS" : "FAIL"} (${state.drawdownPct})
Position size : ${state.checks.positionSize.ok ? "PASS" : "FAIL"} (${(state.checks.positionSize.value * 100).toFixed(2)}%)
Arithmetic halt: ${state.halted ? "YES — " + state.haltReason : "NO"}

── PERFORMANCE ────────────────────────────────────────────────────────────────
Win rate      : ${state.winRate !== null ? (state.winRate * 100).toFixed(1) + "%" : "N/A"}${state.winRateWarning ? "  ⚠ BELOW 40% ALERT" : ""}
Avg P&L/trade : ${state.avgPnlUsd !== null ? "$" + state.avgPnlUsd.toFixed(4) : "N/A"}
Streak        : ${state.consecutiveWins > 0 ? state.consecutiveWins + " consecutive wins" : state.consecutiveLosses > 0 ? state.consecutiveLosses + " consecutive losses" : "N/A"}

── MARKET CONDITIONS ──────────────────────────────────────────────────────────
Volatility    : ${state.volatilityRegime}  RSI range ${state.rsiRange10 !== null ? state.rsiRange10.toFixed(1) : "N/A"} pts (10 candles)
Vol multiplier: ${state.volatilityMultiplier}x
Liquidity     : ${state.liquidityDepthUsd !== null ? "$" + state.liquidityDepthUsd.toFixed(0) + " est. ±0.5% depth" : "N/A"}${state.liquidityWarning ? "  ⚠ LOW" : ""}
Trade count   : ${state.tradeCount}

Assess current risk posture. Consider drawdown trajectory, signal quality, volatility regime,
liquidity conditions, and win rate trend. Only HALT for genuine risk.
Respond ONLY with JSON — no markdown, no explanation outside it:
{"halted":true|false,"haltReason":"<reason if halting, or null>","riskNarrative":"<≤150 chars assessment>"}`
  );
}

function queryClaudeRisk(
  state: RiskState,
): Promise<{ halted: boolean; haltReason: string | null; riskNarrative: string; claudeMs: number } | null> {
  return new Promise((resolve) => {
    const t0   = Date.now();
    const proc = spawn("claude", ["-p", buildRiskPrompt(state)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill();
      console.warn("[RiskClaw] Claude CLI timed out after 55s");
      resolve(null);
    }, 55_000);

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (code !== 0) {
        console.warn(`[RiskClaw] Claude CLI exited ${code}:`, stderr.trim().substring(0, 200));
        resolve(null);
        return;
      }
      try {
        const match = stdout.match(/\{[\s\S]*?\}/);
        if (!match) throw new Error("No JSON in response");
        const parsed = JSON.parse(match[0]) as {
          halted: boolean; haltReason: unknown; riskNarrative: unknown;
        };
        resolve({
          halted:        parsed.halted === true,
          haltReason:    typeof parsed.haltReason    === "string" ? parsed.haltReason.substring(0, 300)    : null,
          riskNarrative: typeof parsed.riskNarrative === "string" ? parsed.riskNarrative.substring(0, 200) : "",
          claudeMs:      ms,
        });
      } catch {
        console.warn("[RiskClaw] Failed to parse Claude response:", stdout.substring(0, 300));
        resolve(null);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.warn("[RiskClaw] Claude CLI spawn error:", err.message);
      resolve(null);
    });
  });
}

// ── Console output ────────────────────────────────────────────────────────────
function printState(state: RiskState): void {
  const haltColor = state.halted ? "\x1b[31m" : "\x1b[32m";
  const reset     = "\x1b[0m";
  const claudeTag = state.claudeMs !== null ? ` [claude ${state.claudeMs}ms]` : " [claude pending]";
  console.log(
    `[${state.timestamp}] ${haltColor}${state.halted ? "HALTED" : "CLEAR"}${reset}${claudeTag}  ` +
    `portfolio=$${state.portfolioValueUsd.toFixed(2)}  ` +
    `peak=$${state.peakPortfolioValueUsd.toFixed(2)}  ` +
    `drawdown=${state.drawdownPct}  ` +
    `vol=${state.volatilityRegime}(${state.volatilityMultiplier}x)  ` +
    `signal=${state.pendingSignal}(${state.pendingStrength})`,
  );
  if (state.halted)                              console.log(`  \u26d4 HALT: ${state.haltReason}`);
  if (state.winRateWarning)                      console.log(`  \u26a0  Win rate <${WIN_RATE_ALERT_PCT * 100}% over last ${WIN_RATE_LOOKBACK} trades`);
  if (state.liquidityWarning)                    console.log(`  \u26a0  Low liquidity: $${state.liquidityDepthUsd?.toFixed(0) ?? "--"} (min $${LIQUIDITY_MIN_USD.toLocaleString()})`);
  if (state.volatilityRegime === "CHOPPY")       console.log(`  \u26a0  CHOPPY market (RSI range ${state.rsiRange10} pts) — position size halved`);
  if (state.riskNarrative)                       console.log(`  \u2139 ${state.riskNarrative}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  initVault();
  console.log("\n[RiskClaw] Starting portfolio risk monitor");
  console.log(`  LLM routing:    claude CLI (privacy-locked, every ${POLL_INTERVAL_MS / 1000}s)`);
  console.log(`  Max drawdown:   ${pct(MAX_DRAWDOWN)}  (hard limit)`);
  console.log(`  Max position:   ${pct(MAX_POSITION_SIZE)}  (hard limit)`);
  console.log(`  Win rate alert: <${WIN_RATE_ALERT_PCT * 100}% over last ${WIN_RATE_LOOKBACK} trades`);
  console.log(`  Liquidity min:  $${LIQUIDITY_MIN_USD.toLocaleString()}`);
  console.log(`  RSI chop flag:  >${RSI_CHOP_THRESHOLD} pts range over ${RSI_HISTORY_SIZE} candles → 0.5x size\n`);

  const lastState = readJson<RiskState>(RISK_STATE);
  let peak = lastState?.peakPortfolioValueUsd ?? 0;
  if (peak > 0) console.log(`[RiskClaw] Restored peak portfolio: $${peak.toFixed(2)}`);

  const dir = path.dirname(RISK_STATE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let evalInProgress = false;

  const tick = async (): Promise<void> => {
    if (evalInProgress) {
      console.log("[RiskClaw] Previous evaluation still running — skipping tick.");
      return;
    }
    evalInProgress = true;
    try {
      const analyst = readJson<AnalystState>(ANALYST_STATE);
      const trade   = readJson<TradeState>(TRADE_STATE);

      // Update RSI ring buffer for volatility detection
      pushRsi(analyst?.rsi ?? null);

      const winStats = computeWinStats(trade?.tradeLog ?? []);
      const vol      = getVolatility();
      const liq      = await fetchLiquidityDepth();

      // Step 1: arithmetic evaluation (synchronous, instant)
      const { state, newPeak } = evaluate(peak, analyst, trade, winStats, vol, liq);
      peak = newPeak;

      // Write immediately so TradeClaw always has fresh HALT + multiplier data
      fs.writeFileSync(RISK_STATE, JSON.stringify(state, null, 2));

      // Step 2: Claude CLI narrative assessment (async, up to 55s)
      const claudeResult = await queryClaudeRisk(state);
      if (claudeResult !== null) {
        // Claude can ADD a halt but cannot remove one set by arithmetic
        if (!state.halted && claudeResult.halted && claudeResult.haltReason) {
          state.halted     = true;
          state.haltReason = `Claude: ${claudeResult.haltReason}`;
        }
        state.riskNarrative = claudeResult.riskNarrative;
        state.claudeMs      = claudeResult.claudeMs;
        fs.writeFileSync(RISK_STATE, JSON.stringify(state, null, 2));

        // Append to Alignment-Log once per calendar day
        const today = new Date().toISOString().substring(0, 10);
        if (today !== lastAlignmentDate && state.riskNarrative) {
          lastAlignmentDate = today;
          try {
            appendToNote("", "Alignment-Log.md",
              `\n## ${today}\n\n` +
              `**Portfolio**: $${state.portfolioValueUsd?.toFixed(4) ?? "--"}  ` +
              `**Drawdown**: ${state.drawdownPct ?? "0%"}  ` +
              `**Halted**: ${state.halted ? "YES — " + (state.haltReason ?? "") : "NO"}\n\n` +
              `**Risk narrative**: ${state.riskNarrative}\n\n` +
              `**Win rate**: ${state.winRate !== null ? (state.winRate * 100).toFixed(1) + "%" : "N/A"}  ` +
              `**Avg P&L/trade**: ${state.avgPnlUsd !== null ? "$" + state.avgPnlUsd.toFixed(4) : "N/A"}  ` +
              `**Trades**: ${state.tradeCount ?? 0}\n`,
            );
          } catch { /* non-fatal */ }
        }
      }

      printState(state);
    } finally {
      evalInProgress = false;
    }
  };

  tick().catch((e) => console.error("[RiskClaw] tick error:", e));
  setInterval(() => {
    tick().catch((e) => console.error("[RiskClaw] tick error:", e));
  }, POLL_INTERVAL_MS);

  console.log(`[RiskClaw] Monitoring every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);
}

main().catch((err) => {
  console.error("[RiskClaw] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
