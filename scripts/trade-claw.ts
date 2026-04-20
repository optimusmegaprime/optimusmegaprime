/**
 * TradeClaw — ETH/USDC Autonomous Trade Executor
 *
 * LLM routing: claude CLI subprocess (`claude -p "..."`) — uses Max subscription,
 * no API tokens. Spawned once per trade as Gate 5 (final approval before swap).
 *
 * Watches shared/analyst-state.json for BUY/SELL signals from AnalystClaw.
 * On STRONG or MODERATE signals that pass all 5 gates it executes a swap via
 * the CDP Smart Wallet action provider on Base mainnet.
 * Results are written to shared/trade-state.json for RiskClaw to consume.
 *
 * Gate sequence:
 *   0  RiskClaw HALT flag
 *   1  Signal strength (STRONG/MODERATE only)
 *   2  Signal freshness (< 20 min)
 *   3  Deduplication (one execution per candleStart)
 *   4  Cooldown (15 min between trades)
 *   5  Claude CLI approval (`claude -p`) — EXECUTE or SKIP with reason
 *
 * Run: npm run trade
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { config as loadEnv } from "dotenv";
import { erc20Abi, formatUnits } from "viem";
import {
  cdpSmartWalletActionProvider,
  CdpSmartWalletProvider,
} from "@coinbase/agentkit";
import { prepareAgentkitAndWalletProvider } from "../app/api/agent/prepare-agentkit.js";
import type { SignalState } from "./analyst-claw.js";
import type { RiskState } from "./risk-claw.js";
import { initVault, writeNote, appendToNote } from "./obsidian-writer.js";

// ── Strategy params (written by StrategyCannon, re-read every 5 min) ──────────

interface StrategyParams {
  timestamp?: string;
  fibProximityThreshold?: number;
  rsiOversoldThreshold?: number;
  rsiOverboughtThreshold?: number;
  volumeMultiplier?: number;
  minSignalStrength?: "STRONG" | "MODERATE";
  positionSizeMultiplier?: number;
  marketRegime?: string;
  timeHorizonBias?: string;
}

const STRATEGY_PARAMS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../shared/strategy-params.json",
);

function readStrategyParams(): StrategyParams {
  try {
    if (!fs.existsSync(STRATEGY_PARAMS_PATH)) return {};
    return JSON.parse(fs.readFileSync(STRATEGY_PARAMS_PATH, "utf8")) as StrategyParams;
  } catch {
    return {};
  }
}

let strategyParams: StrategyParams = readStrategyParams();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from project root (one level up from scripts/)
loadEnv({ path: path.join(__dirname, "../.env") });

// ── LLM routing ───────────────────────────────────────────────────────────────
// TradeClaw spawns `claude -p` (Claude Code CLI) for Gate 5 trade approval.
// This routes through the Max subscription instead of direct API tokens.
// The model used is whatever is configured in the user's Claude Code installation.
export const MODEL_ID = "claude-cli";

// ── Config ────────────────────────────────────────────────────────────────────

// Token addresses — Base mainnet
const NATIVE_ETH   = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Position sizing: fraction of available balance to commit per trade
const POSITION_SIZE: Record<"STRONG" | "MODERATE", number> = {
  STRONG:   0.20,
  MODERATE: 0.20,
};

const MIN_ETH_TRADE    = 0.0002; // ETH — below this, skip to avoid dust
const MIN_USDC_TRADE   = 0.50;  // USDC
const SLIPPAGE_BPS     = 100;   // 1% slippage tolerance
const MAX_SIGNAL_AGE_MS  = 20 * 60 * 1000; // 20 min — ignore stale signals
const TRADE_COOLDOWN_MS  = 15 * 60 * 1000; // 15 min between trades
const POLL_INTERVAL_MS   = 30_000;
const MAX_RISK_STATE_AGE_MS = 3 * 60 * 1000; // 3 min — stale risk-state treated as HALT

// File paths
const ANALYST_STATE = path.join(__dirname, "../shared/analyst-state.json");
const TRADE_STATE   = path.join(__dirname, "../shared/trade-state.json");
const RISK_STATE    = path.join(__dirname, "../shared/risk-state.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface LastTrade {
  timestamp: string;
  action: "BUY" | "SELL";
  fromToken: string;
  toToken: string;
  fromAmount: string;
  fromTokenName: string;
  toAmount: string;
  toTokenName: string;
  txHash: string;
  network: string;
  signalStrength: "STRONG" | "MODERATE";
  signalPrice: number;
  candleStart: string;
}

interface TradeLogEntry {
  timestamp: string;
  action: "BUY" | "SELL";
  entryPriceUsd: number;
  exitPriceUsd: number | null;
  fromAmount: string;
  fromTokenName: string;
  toAmount: string;
  toTokenName: string;
  pnlUsd: number | null;
  pnlPct: string | null;
  entryReason: string;
  txHash: string;
  fibLevelAtEntry: number | null;
  fibPriceAtEntry: number | null;
  rsiAtEntry: number;
  fearGreedAtEntry: number | null;
  fearGreedLabelAtEntry: string | null;
  signalStrength: "STRONG" | "MODERATE";
  claudeReason: string;
}

interface TradeState {
  timestamp: string;
  model: string;
  status: "IDLE" | "EXECUTING";
  walletAddress: string;
  ethBalance: string;
  usdcBalance: string;
  lastTrade: LastTrade | null;
  tradeLog: TradeLogEntry[];
  lastSignalSeen: {
    signal: string;
    strength: string;
    price: number;
    candleStart: string;
    action: "EXECUTED" | "SKIPPED" | "ERROR";
    skipReason?: string;
    error?: string;
  } | null;
  executedCount: number;
  skippedCount: number;
}

// ── Runtime state ─────────────────────────────────────────────────────────────

let isExecuting           = false;
let lastExecutedCandleStart = "";
let lastTradeTimestamp    = 0;
let executedCount         = 0;
let skippedCount          = 0;
let lastTrade: LastTrade | null = null;
let tradeLog: TradeLogEntry[] = [];

// P&L tracking — set on BUY, consumed on SELL
let lastBuyPriceUsd: number | null = null;
let lastBuyUsdcSpent: number | null = null;
let lastBuyEthReceived: number | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeTradeState(
  walletAddress: string,
  ethBalance: string,
  usdcBalance: string,
  status: "IDLE" | "EXECUTING",
  lastSignalSeen: TradeState["lastSignalSeen"],
): void {
  const state: TradeState = {
    timestamp: new Date().toISOString(),
    model: MODEL_ID,
    status,
    walletAddress,
    ethBalance,
    usdcBalance,
    lastTrade,
    tradeLog,
    lastSignalSeen,
    executedCount,
    skippedCount,
  };
  const dir = path.dirname(TRADE_STATE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRADE_STATE, JSON.stringify(state, null, 2));
}

function fmt(n: number, decimals = 6): string {
  return n.toFixed(decimals);
}

function sigColor(s: "BUY" | "SELL" | "HOLD"): string {
  return s === "BUY" ? "\x1b[32m" : s === "SELL" ? "\x1b[31m" : "\x1b[33m";
}
const RESET = "\x1b[0m";

// ── Claude CLI subprocess ─────────────────────────────────────────────────────

function callClaude(prompt: string, timeoutMs = 90_000): string | null {
  try {
    const result = spawnSync("claude", ["-p", prompt], {
      timeout:  timeoutMs,
      encoding: "utf8",
      stdio:    ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      console.warn("[TradeClaw] claude CLI error:", result.error.message);
      return null;
    }
    if (result.status !== 0) {
      console.warn(`[TradeClaw] claude CLI exited ${result.status}:`, (result.stderr ?? "").trim().substring(0, 200));
      return null;
    }
    return result.stdout?.trim() ?? null;
  } catch (err) {
    console.warn("[TradeClaw] claude CLI exception:", (err as Error).message);
    return null;
  }
}

function buildTradePrompt(
  signal: SignalState,
  ethBalance: string,
  usdcBalance: string,
  fromAmount: string,
  fromName:   string,
  toName:     string,
  log: TradeLogEntry[],
): string {
  const portVal  = parseFloat(usdcBalance) + parseFloat(ethBalance) * signal.price;
  const recent   = log.slice(-3);
  const network  = process.env.NETWORK_ID ?? "base-mainnet";

  return (
`You are TradeClaw, an autonomous ETH/USDC trade executor on ${network}.
AnalystClaw (algorithmic, no LLM) has generated the following signal.
Your job: approve or reject this specific trade. Be decisive.

── MARKET SIGNAL ──────────────────────────────────────────────────────────────
Signal     : ${signal.signal} (${signal.strength})
Price      : $${signal.price.toFixed(2)}
RSI-14     : ${signal.rsi.toFixed(2)}
EMA 9/21/50: $${signal.ema9.toFixed(2)} / $${signal.ema21.toFixed(2)} / $${signal.ema50.toFixed(2)}
Volume     : ${signal.volumeRatio.toFixed(3)}x (vs 20-bar avg)
Fib level  : ${signal.nearestFibLevel !== null ? `${(signal.nearestFibLevel * 100).toFixed(1)}% ($${(signal.nearestFibPrice ?? 0).toFixed(2)})` : "none nearby"}
Tick B/S   : ${signal.tickBuySellRatio !== null ? signal.tickBuySellRatio.toFixed(3) + "x" : "N/A"}
Tick mom   : ${signal.tickMomentumPct  !== null ? signal.tickMomentumPct.toFixed(3)  + "%" : "N/A"}
Fear/Greed : ${signal.fearGreedValue   !== null ? `${signal.fearGreedValue} (${signal.fearGreedLabel})` : "N/A"}
24h change : ${signal.marketChange24h  !== null ? signal.marketChange24h + "%" : "N/A"}
Gas (fast) : ${signal.gasGwei          !== null ? signal.gasGwei + " gwei" : "N/A"}
Reason     : ${signal.reason}

── PORTFOLIO ──────────────────────────────────────────────────────────────────
ETH        : ${ethBalance}
USDC       : ${usdcBalance}
~Value     : $${portVal.toFixed(2)}

── PROPOSED TRADE ─────────────────────────────────────────────────────────────
Action     : ${signal.signal}
Spend      : ${fromAmount} ${fromName}
Receive    : ${toName}

── RECENT TRADES (last ${recent.length}) ──────────────────────────────────────
${recent.length
  ? recent.map((t) =>
      `  ${t.timestamp.substring(11, 19)} ${t.action} ${t.fromAmount} ${t.fromTokenName}` +
      ` → ${t.toAmount} ${t.toTokenName}` +
      (t.pnlUsd !== null ? `  P&L: ${t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(4)} USDC` : "  (open)"),
    ).join("\n")
  : "  (none yet)"}

Respond ONLY with JSON — no markdown, no explanation outside it:
{"action":"EXECUTE"|"SKIP","reason":"<≤150 chars>"}`
  );
}

// ── Core: evaluate and execute ────────────────────────────────────────────────

async function evaluate(
  walletProvider: CdpSmartWalletProvider,
  swapProvider: ReturnType<typeof cdpSmartWalletActionProvider>,
): Promise<void> {
  if (isExecuting) {
    console.log("[TradeClaw] Already executing — skipping tick.");
    return;
  }

  const signal = readJson<SignalState>(ANALYST_STATE);
  if (!signal) {
    console.log("[TradeClaw] No analyst state found — waiting.");
    return;
  }

  const walletAddress = walletProvider.getAddress();
  const now = Date.now();

  // Read balances (needed for every gate's state write)
  const ethWei = await walletProvider.getBalance();
  const ethBalance = parseFloat(formatUnits(ethWei, 18));
  const usdcRaw = (await walletProvider.readContract({
    address: USDC_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  })) as bigint;
  const usdcBalance = parseFloat(formatUnits(usdcRaw, 6));
  const ethStr  = fmt(ethBalance, 6);
  const usdcStr = fmt(usdcBalance, 2);

  // ── Gate 0: RiskClaw HALT check (with freshness guard) ───────────────────
  const riskState = readJson<RiskState>(RISK_STATE);
  const riskAgeMs = riskState ? now - new Date(riskState.timestamp).getTime() : Infinity;
  if (!riskState || riskAgeMs > MAX_RISK_STATE_AGE_MS) {
    const reason = !riskState
      ? "risk-state.json missing — RiskClaw may not be running"
      : `risk-state.json stale (${Math.round(riskAgeMs / 1000)}s old) — RiskClaw may be down`;
    console.log(`[TradeClaw] \x1b[31mHALTED\x1b[0m: ${reason}`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "SKIPPED", skipReason: reason,
    });
    skippedCount++;
    return;
  }
  if (riskState.halted) {
    console.log(`[TradeClaw] \x1b[31mHALTED\x1b[0m by RiskClaw: ${riskState.haltReason}`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "SKIPPED",
      skipReason: `HALTED by RiskClaw: ${riskState.haltReason}`,
    });
    skippedCount++;
    return;
  }

  // ── Gate 0b: Liquidity warning check ─────────────────────────────────────
  if (riskState?.liquidityWarning) {
    const depthStr = riskState.liquidityDepthUsd !== null
      ? `$${riskState.liquidityDepthUsd.toFixed(0)}`
      : "unknown";
    console.log(`[TradeClaw] \x1b[33m⚠ LOW LIQUIDITY\x1b[0m (${depthStr} est. depth) — skipping trade`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "SKIPPED",
      skipReason: `Low liquidity: ${depthStr} estimated ±0.5% depth (min $50k)`,
    });
    skippedCount++;
    return;
  }

  // ── Gate 1: signal strength ───────────────────────────────────────────────
  const minRequired = strategyParams.minSignalStrength ?? "MODERATE";
  const strengthFail =
    signal.signal === "HOLD" ||
    signal.strength === "WEAK" ||
    (minRequired === "STRONG" && signal.strength !== "STRONG");

  if (strengthFail) {
    console.log(
      `[TradeClaw] ${signal.signal} (${signal.strength}) — does not meet min strength "${minRequired}".`,
    );
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "SKIPPED",
      skipReason: `${signal.strength} ${signal.signal} does not meet ${minRequired} threshold`,
    });
    skippedCount++;
    return;
  }

  // ── Gate 2: signal freshness ──────────────────────────────────────────────
  const signalAge = now - new Date(signal.timestamp).getTime();
  if (signalAge > MAX_SIGNAL_AGE_MS) {
    const ageMin = Math.round(signalAge / 60_000);
    console.log(`[TradeClaw] Signal is ${ageMin}m old — stale, skipping.`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "SKIPPED",
      skipReason: `Signal is ${ageMin} minutes old (max: ${MAX_SIGNAL_AGE_MS / 60_000}m)`,
    });
    skippedCount++;
    return;
  }

  // ── Gate 3: deduplication — same candle already executed ─────────────────
  if (signal.candleStart === lastExecutedCandleStart) {
    return; // silent — fires on every fs.watch event for the same candle
  }

  // ── Gate 4: trade cooldown ────────────────────────────────────────────────
  const cooldownRemaining = TRADE_COOLDOWN_MS - (now - lastTradeTimestamp);
  if (lastTradeTimestamp > 0 && cooldownRemaining > 0) {
    const remainMin = Math.ceil(cooldownRemaining / 60_000);
    console.log(`[TradeClaw] Cooldown active — ${remainMin}m remaining.`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "SKIPPED",
      skipReason: `Trade cooldown: ${remainMin}m remaining`,
    });
    skippedCount++;
    return;
  }

  // ── Position sizing (volatility-adjusted + strategy-cannon multiplier) ──────
  const volMultiplier = riskState?.volatilityMultiplier ?? 1.0;
  const cannonMultiplier = strategyParams.positionSizeMultiplier ?? 1.0;
  const rawPct = POSITION_SIZE[signal.strength as "STRONG" | "MODERATE"] * volMultiplier * cannonMultiplier;
  const pct = Math.min(0.30, rawPct); // hard cap at 30%
  if (volMultiplier < 1.0 || cannonMultiplier !== 1.0) {
    console.log(
      `[TradeClaw] \x1b[33m${riskState?.volatilityRegime ?? "CHOPPY"}\x1b[0m market — ` +
      `position size: ${(pct * 100).toFixed(1)}% (vol=${volMultiplier}x cannon=${cannonMultiplier}x)`,
    );
  }

  let fromToken: string;
  let toToken: string;
  let fromAmountNum: number;

  if (signal.signal === "BUY") {
    // BUY = accumulate ETH = spend USDC → receive ETH
    fromToken = USDC_ADDRESS;
    toToken   = NATIVE_ETH;
    fromAmountNum = usdcBalance * pct;

    if (fromAmountNum < MIN_USDC_TRADE) {
      console.log(
        `[TradeClaw] BUY skipped — trade size ${fmt(fromAmountNum, 2)} USDC < min ${MIN_USDC_TRADE} USDC. ` +
          `(Balance: ${usdcStr} USDC, ${pct * 100}% = ${fmt(fromAmountNum, 2)})`,
      );
      writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
        signal: signal.signal,
        strength: signal.strength,
        price: signal.price,
        candleStart: signal.candleStart,
        action: "SKIPPED",
        skipReason: `BUY size ${fmt(fromAmountNum, 2)} USDC below minimum ${MIN_USDC_TRADE} USDC`,
      });
      skippedCount++;
      return;
    }
  } else {
    // SELL = reduce ETH exposure = spend ETH → receive USDC
    fromToken = NATIVE_ETH;
    toToken   = USDC_ADDRESS;
    fromAmountNum = ethBalance * pct;

    if (fromAmountNum < MIN_ETH_TRADE) {
      console.log(
        `[TradeClaw] SELL skipped — trade size ${fmt(fromAmountNum, 6)} ETH < min ${MIN_ETH_TRADE} ETH. ` +
          `(Balance: ${ethStr} ETH, ${pct * 100}% = ${fmt(fromAmountNum, 6)})`,
      );
      writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
        signal: signal.signal,
        strength: signal.strength,
        price: signal.price,
        candleStart: signal.candleStart,
        action: "SKIPPED",
        skipReason: `SELL size ${fmt(fromAmountNum, 6)} ETH below minimum ${MIN_ETH_TRADE} ETH`,
      });
      skippedCount++;
      return;
    }
  }

  const fromAmount = signal.signal === "BUY"
    ? fmt(fromAmountNum, 2)
    : fmt(fromAmountNum, 6);
  const fromName = signal.signal === "BUY" ? "USDC" : "ETH";
  const toName   = signal.signal === "BUY" ? "ETH"  : "USDC";

  // ── Gate 5: Claude CLI trade approval ────────────────────────────────────
  const promptText = buildTradePrompt(signal, ethStr, usdcStr, fromAmount, fromName, toName, tradeLog);
  console.log("[TradeClaw] Gate 5 — consulting claude CLI for trade approval…");
  const t0c = Date.now();
  const claudeRaw = callClaude(promptText);
  const claudeMs  = Date.now() - t0c;

  if (claudeRaw === null) {
    console.warn(`[TradeClaw] Claude CLI unavailable (${claudeMs}ms) — skipping (safe default).`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "SKIPPED",
      skipReason: "Claude CLI unavailable",
    });
    skippedCount++;
    return;
  }

  let claudeDecision: { action: "EXECUTE" | "SKIP"; reason: string };
  try {
    const match = claudeRaw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("No JSON found");
    const parsed = JSON.parse(match[0]) as { action: string; reason: string };
    claudeDecision = {
      action: parsed.action === "EXECUTE" ? "EXECUTE" : "SKIP",
      reason: typeof parsed.reason === "string" ? parsed.reason.substring(0, 200) : "No reason",
    };
  } catch {
    console.warn("[TradeClaw] Failed to parse Claude response:", claudeRaw.substring(0, 300));
    claudeDecision = { action: "SKIP", reason: "Unparseable Claude response" };
  }

  if (claudeDecision.action === "SKIP") {
    console.log(`[TradeClaw] Claude SKIP (${claudeMs}ms): ${claudeDecision.reason}`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "SKIPPED",
      skipReason: `Claude: ${claudeDecision.reason}`,
    });
    skippedCount++;
    return;
  }
  console.log(`[TradeClaw] Claude EXECUTE (${claudeMs}ms): ${claudeDecision.reason}`);

  // ── Execute ───────────────────────────────────────────────────────────────
  isExecuting = true;

  const sigC = sigColor(signal.signal);
  console.log(`\n[TradeClaw] ${sigC}▶ EXECUTING ${signal.signal} (${signal.strength})${RESET}`);
  console.log(
    `  Swapping ${fromAmount} ${fromName} → ${toName}  |  price=$${signal.price.toFixed(2)}  |  RSI=${signal.rsi.toFixed(1)}`,
  );
  console.log(`  Balances: ${ethStr} ETH  |  ${usdcStr} USDC  |  Sizing: ${pct * 100}%`);
  console.log(`  Entry reason: ${signal.reason}`);

  writeTradeState(walletAddress, ethStr, usdcStr, "EXECUTING", {
    signal: signal.signal,
    strength: signal.strength,
    price: signal.price,
    candleStart: signal.candleStart,
    action: "EXECUTED",
  });

  try {
    const resultJson = await swapProvider.swap(walletProvider, {
      fromToken,
      toToken,
      fromAmount,
      slippageBps: SLIPPAGE_BPS,
    });

    const result = JSON.parse(resultJson) as {
      success: boolean;
      transactionHash?: string;
      toAmount?: string;
      network?: string;
      error?: string;
      approvalTxHash?: string;
    };

    if (!result.success) {
      throw new Error(result.error ?? "Swap returned success:false");
    }

    lastExecutedCandleStart = signal.candleStart;
    lastTradeTimestamp = Date.now();
    executedCount++;

    const toAmountNum = parseFloat(result.toAmount ?? "0");
    lastTrade = {
      timestamp:      new Date().toISOString(),
      action:         signal.signal as "BUY" | "SELL",
      fromToken,
      toToken,
      fromAmount,
      fromTokenName:  fromName,
      toAmount:       result.toAmount ?? "unknown",
      toTokenName:    toName,
      txHash:         result.transactionHash ?? "",
      network:        result.network ?? "base-mainnet",
      signalStrength: signal.strength as "STRONG" | "MODERATE",
      signalPrice:    signal.price,
      candleStart:    signal.candleStart,
    };

    // P&L tracking
    let pnlUsd: number | null = null;
    let pnlPct: string | null = null;

    if (signal.signal === "BUY") {
      lastBuyPriceUsd    = signal.price;
      lastBuyUsdcSpent   = fromAmountNum;
      lastBuyEthReceived = toAmountNum;
    } else if (signal.signal === "SELL" && lastBuyPriceUsd !== null && lastBuyUsdcSpent !== null) {
      const usdcReceived = toAmountNum;
      pnlUsd = usdcReceived - lastBuyUsdcSpent;
      pnlPct = `${((pnlUsd / lastBuyUsdcSpent) * 100).toFixed(2)}%`;
      const pnlColor = pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(`  P&L: ${pnlColor}${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(4)} USDC (${pnlPct})${RESET}  ` +
        `entry=$${lastBuyPriceUsd.toFixed(2)}  exit=$${signal.price.toFixed(2)}`);
      lastBuyPriceUsd = null;
      lastBuyUsdcSpent = null;
      lastBuyEthReceived = null;
    }

    // Append to rolling trade log (last 50)
    const logEntry: TradeLogEntry = {
      timestamp:    new Date().toISOString(),
      action:       signal.signal as "BUY" | "SELL",
      entryPriceUsd: signal.price,
      exitPriceUsd:  signal.signal === "SELL" ? signal.price : null,
      fromAmount,
      fromTokenName: fromName,
      toAmount:     result.toAmount ?? "0",
      toTokenName:  toName,
      pnlUsd,
      pnlPct,
      entryReason:  signal.reason,
      txHash:       result.transactionHash ?? "",
      fibLevelAtEntry:       signal.nearestFibLevel ?? null,
      fibPriceAtEntry:       signal.nearestFibPrice ?? null,
      rsiAtEntry:            signal.rsi,
      fearGreedAtEntry:      signal.fearGreedValue ?? null,
      fearGreedLabelAtEntry: signal.fearGreedLabel ?? null,
      signalStrength:        signal.strength as "STRONG" | "MODERATE",
      claudeReason:          claudeDecision.reason,
    };
    tradeLog.push(logEntry);
    if (tradeLog.length > 50) tradeLog.shift();

    // Write completed trade to Obsidian vault
    try {
      const ts   = new Date(logEntry.timestamp);
      const slug = ts.toISOString().substring(0, 16).replace("T", "-").replace(":", "") + "-" + logEntry.action;
      const pnl  = logEntry.pnlUsd !== null ? `$${logEntry.pnlUsd.toFixed(4)} (${logEntry.pnlPct ?? "?"})` : "open";
      const noteContent = `---
action: ${logEntry.action}
timestamp: ${logEntry.timestamp}
entry_price: ${logEntry.entryPriceUsd}
exit_price: ${logEntry.exitPriceUsd ?? null}
from: ${logEntry.fromAmount} ${logEntry.fromTokenName}
to: ${logEntry.toAmount} ${logEntry.toTokenName}
pnl_usd: ${logEntry.pnlUsd ?? null}
pnl_pct: ${logEntry.pnlPct ?? null}
rsi: ${logEntry.rsiAtEntry}
fib_level: ${logEntry.fibLevelAtEntry ?? null}
fib_price: ${logEntry.fibPriceAtEntry ?? null}
fear_greed: ${logEntry.fearGreedAtEntry ?? null}
strength: ${logEntry.signalStrength}
tx_hash: ${logEntry.txHash}
---

# ${logEntry.action} — ${ts.toISOString().substring(0, 19).replace("T", " ")} UTC

**P&L**: ${pnl}
**Entry price**: $${logEntry.entryPriceUsd.toFixed(2)}${logEntry.exitPriceUsd !== null ? `  →  **Exit**: $${logEntry.exitPriceUsd.toFixed(2)}` : ""}
**Size**: ${logEntry.fromAmount} ${logEntry.fromTokenName} → ${logEntry.toAmount} ${logEntry.toTokenName}
**Signal**: ${logEntry.signalStrength} · RSI ${logEntry.rsiAtEntry.toFixed(1)} · Fib ${logEntry.fibLevelAtEntry != null ? (logEntry.fibLevelAtEntry * 100).toFixed(1) + "%" : "--"} · F/G ${logEntry.fearGreedAtEntry ?? "--"}

**Analyst reason**: ${logEntry.entryReason}

**Claude Gate-5**: ${logEntry.claudeReason}

**Tx**: https://basescan.org/tx/${logEntry.txHash}
`;
      writeNote("Trades", slug + ".md", noteContent);

      if (logEntry.pnlUsd !== null && logEntry.pnlUsd !== 0) {
        const patternLine = `\n- **${ts.toISOString().substring(0,10)}** ${logEntry.action} ${pnl} — RSI ${logEntry.rsiAtEntry.toFixed(1)}, Fib ${logEntry.fibLevelAtEntry != null ? (logEntry.fibLevelAtEntry*100).toFixed(1)+"%" : "--"}: ${logEntry.entryReason.substring(0,120)}\n`;
        appendToNote("Insights", logEntry.pnlUsd > 0 ? "Winning-Patterns.md" : "Losing-Patterns.md", patternLine);
      }
    } catch { /* non-fatal */ }

    console.log(`${sigC}  ✓ Swap confirmed!${RESET}  ${fromAmount} ${fromName} → ${result.toAmount} ${toName}`);
    if (result.approvalTxHash) console.log(`  Permit2 approval tx: ${result.approvalTxHash}`);
    console.log(`  Tx hash: ${result.transactionHash}`);

    // Re-read balances post-trade
    const ethWeiPost = await walletProvider.getBalance();
    const ethPost    = fmt(parseFloat(formatUnits(ethWeiPost, 18)), 6);
    const usdcRawPost = (await walletProvider.readContract({
      address: USDC_ADDRESS as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    })) as bigint;
    const usdcPost = fmt(parseFloat(formatUnits(usdcRawPost, 6)), 2);

    writeTradeState(walletAddress, ethPost, usdcPost, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "EXECUTED",
    });
    console.log(`  Post-trade: ${ethPost} ETH  |  ${usdcPost} USDC\n`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TradeClaw] Swap failed: ${errMsg}`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal,
      strength: signal.strength,
      price: signal.price,
      candleStart: signal.candleStart,
      action: "ERROR",
      error: errMsg,
    });
  } finally {
    isExecuting = false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function restorePnlState(): void {
  const saved = readJson<TradeState>(TRADE_STATE);
  if (!saved?.tradeLog?.length) return;
  tradeLog = saved.tradeLog;
  executedCount = saved.executedCount ?? 0;
  skippedCount  = saved.skippedCount  ?? 0;
  lastTrade     = saved.lastTrade ?? null;
  // Restore open BUY position for P&L tracking (last BUY with no subsequent SELL)
  for (let i = tradeLog.length - 1; i >= 0; i--) {
    const entry = tradeLog[i];
    if (entry.action === "SELL") break;
    if (entry.action === "BUY") {
      lastBuyPriceUsd    = entry.entryPriceUsd;
      lastBuyUsdcSpent   = parseFloat(entry.fromAmount);
      lastBuyEthReceived = parseFloat(entry.toAmount);
      console.log(`[TradeClaw] Restored open BUY: $${lastBuyPriceUsd} entry, ${lastBuyUsdcSpent} USDC spent`);
      break;
    }
  }
}

async function main(): Promise<void> {
  initVault();
  restorePnlState();
  console.log("\n[TradeClaw] Starting trade executor");
  console.log(`  LLM routing:    claude CLI subprocess (Gate 5 approval)`);
  console.log(`  Analyst state:  ${ANALYST_STATE}`);
  console.log(`  Trade state:    ${TRADE_STATE}`);
  console.log(`  Risk state:     ${RISK_STATE}`);
  console.log(`  Position sizes: STRONG=${POSITION_SIZE.STRONG * 100}%  MODERATE=${POSITION_SIZE.MODERATE * 100}%`);
  console.log(`  Min sizes:      ${MIN_ETH_TRADE} ETH / ${MIN_USDC_TRADE} USDC`);
  console.log(`  Slippage:       ${SLIPPAGE_BPS} bps`);
  console.log(`  Cooldown:       ${TRADE_COOLDOWN_MS / 60_000}m\n`);

  console.log("[TradeClaw] Initializing AgentKit wallet…");
  const { walletProvider } = await prepareAgentkitAndWalletProvider();
  const wallet       = walletProvider as CdpSmartWalletProvider;
  const swapProvider = cdpSmartWalletActionProvider();

  console.log(`[TradeClaw] Wallet:  ${wallet.getAddress()}`);
  console.log(`[TradeClaw] Network: ${wallet.getNetwork().networkId}\n`);

  await evaluate(wallet, swapProvider);

  if (fs.existsSync(path.dirname(ANALYST_STATE))) {
    fs.watch(ANALYST_STATE, { persistent: true }, (eventType) => {
      if (eventType === "change") {
        evaluate(wallet, swapProvider).catch((e) =>
          console.error("[TradeClaw] Evaluation error:", e),
        );
      }
    });
    console.log("[TradeClaw] Watching analyst state file for changes…");
  }

  setInterval(() => {
    evaluate(wallet, swapProvider).catch((e) =>
      console.error("[TradeClaw] Poll error:", e),
    );
  }, POLL_INTERVAL_MS);

  // Re-read strategy params every 5 minutes (written by StrategyCannon)
  setInterval(() => {
    strategyParams = readStrategyParams();
  }, 5 * 60 * 1000);

  console.log("[TradeClaw] Ready. Waiting for signals…\n");
}

main().catch((err) => {
  console.error("[TradeClaw] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
