/**
 * StrategyCannon — OptimusMegaPrime Meta-Strategic Mission Control
 *
 * Runs daily (or on-demand) to assess mission alignment, compute performance
 * metrics, generate 3-horizon market analysis, and update strategy parameters.
 * Uses claude-opus-4-6 via the Claude CLI subprocess for deep strategic reasoning.
 *
 * Outputs:
 *   shared/cannon-state.json      — alignment, directives, analyses, metrics
 *   shared/strategy-params.json   — tuned parameters consumed by AnalystClaw + TradeClaw
 *   Obsidian vault                — projections, daily report, alignment log entry
 *
 * Run:
 *   npm run cannon           — one-shot, run immediately + exit
 *   npm run cannon:daemon    — run immediately + schedule daily at 00:00 UTC
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { config as loadEnv } from "dotenv";
import {
  readNote,
  appendToNote,
  writeNote,
  writeDaily,
  listNotes,
  initVault,
  VAULT_PATH,
} from "./obsidian-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

// ── Mission ────────────────────────────────────────────────────────────────────

const MISSION_STATEMENT =
  "OptimusMegaPrime is a balanced growth autonomous trading system designed for " +
  "steady returns with controlled risk. Primary purpose is consistent compound " +
  "growth while respecting defined risk boundaries. Maximum acceptable drawdown is 30%.";

// ── Paths ──────────────────────────────────────────────────────────────────────

const SHARED_DIR      = path.join(__dirname, "../shared");
const CANNON_STATE    = path.join(SHARED_DIR, "cannon-state.json");
const STRATEGY_PARAMS = path.join(SHARED_DIR, "strategy-params.json");
const ANALYST_STATE   = path.join(SHARED_DIR, "analyst-state.json");
const RISK_STATE      = path.join(SHARED_DIR, "risk-state.json");
const TRADE_STATE     = path.join(SHARED_DIR, "trade-state.json");

// ── Types ──────────────────────────────────────────────────────────────────────

interface StrategyParams {
  timestamp: string;
  fibProximityThreshold: number;
  rsiOversoldThreshold: number;
  rsiOverboughtThreshold: number;
  volumeMultiplier: number;
  minSignalStrength: "STRONG" | "MODERATE";
  positionSizeMultiplier: number;
  marketRegime: "bullish" | "bearish" | "ranging" | "choppy";
  timeHorizonBias: "short" | "mid" | "long";
}

interface MetricsSnapshot {
  monthlyReturnPct: number | null;
  compoundGrowthPct: number | null;
  profitableDaysPct: number | null;
  sharpeEstimate: number | null;
  winRatePct: number | null;
}

interface CannonState {
  timestamp: string;
  missionStatement: string;
  currentAlignment: "ALIGNED" | "DRIFTING" | "MISALIGNED";
  alignmentReason: string;
  performanceScore: number;
  metricsSnapshot: MetricsSnapshot;
  drawdownStatus: { current: number; limit: number; ok: boolean };
  strategicDirectives: string[];
  shortTermAnalysis: string;
  midTermAnalysis: string;
  longTermAnalysis: string;
  marketRegime: string;
  projection30d: string;
  projection90d: string;
  lastRunAt: string;
  nextRunAt: string;
  runDurationMs: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_PARAMS: StrategyParams = {
  timestamp: new Date().toISOString(),
  fibProximityThreshold: 0.02,
  rsiOversoldThreshold: 30,
  rsiOverboughtThreshold: 70,
  volumeMultiplier: 1.0,
  minSignalStrength: "MODERATE",
  positionSizeMultiplier: 1.0,
  marketRegime: "ranging",
  timeHorizonBias: "mid",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function readSharedJSON(filename: string): any {
  try {
    const fp = path.join(SHARED_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function readCannonState(): CannonState | null {
  try {
    if (!fs.existsSync(CANNON_STATE)) return null;
    return JSON.parse(fs.readFileSync(CANNON_STATE, "utf8")) as CannonState;
  } catch {
    return null;
  }
}

function readStrategyParams(): StrategyParams {
  try {
    if (!fs.existsSync(STRATEGY_PARAMS)) return { ...DEFAULT_PARAMS };
    const raw = JSON.parse(fs.readFileSync(STRATEGY_PARAMS, "utf8"));
    // Fill in any missing fields with defaults
    return {
      timestamp:              raw.timestamp              ?? new Date().toISOString(),
      fibProximityThreshold:  typeof raw.fibProximityThreshold  === "number" ? raw.fibProximityThreshold  : DEFAULT_PARAMS.fibProximityThreshold,
      rsiOversoldThreshold:   typeof raw.rsiOversoldThreshold   === "number" ? raw.rsiOversoldThreshold   : DEFAULT_PARAMS.rsiOversoldThreshold,
      rsiOverboughtThreshold: typeof raw.rsiOverboughtThreshold === "number" ? raw.rsiOverboughtThreshold : DEFAULT_PARAMS.rsiOverboughtThreshold,
      volumeMultiplier:       typeof raw.volumeMultiplier       === "number" ? raw.volumeMultiplier       : DEFAULT_PARAMS.volumeMultiplier,
      minSignalStrength:      ["STRONG","MODERATE"].includes(raw.minSignalStrength) ? raw.minSignalStrength : DEFAULT_PARAMS.minSignalStrength,
      positionSizeMultiplier: typeof raw.positionSizeMultiplier === "number" ? raw.positionSizeMultiplier : DEFAULT_PARAMS.positionSizeMultiplier,
      marketRegime:           ["bullish","bearish","ranging","choppy"].includes(raw.marketRegime) ? raw.marketRegime : DEFAULT_PARAMS.marketRegime,
      timeHorizonBias:        ["short","mid","long"].includes(raw.timeHorizonBias) ? raw.timeHorizonBias : DEFAULT_PARAMS.timeHorizonBias,
    };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

/**
 * Clamps `proposed` within ±maxPct of `current`, then within optional absolute bounds.
 * Rounds to 4 decimal places.
 */
function clampPct(
  proposed: number,
  current: number,
  maxPct = 0.20,
  absMin?: number,
  absMax?: number,
): number {
  const lo = current * (1 - maxPct);
  const hi = current * (1 + maxPct);
  let v = Math.max(lo, Math.min(hi, proposed));
  if (absMin !== undefined) v = Math.max(absMin, v);
  if (absMax !== undefined) v = Math.min(absMax, v);
  return Math.round(v * 10000) / 10000;
}

function validateAndClampParams(proposed: any, current: StrategyParams): StrategyParams {
  const fib = clampPct(
    typeof proposed.fibProximityThreshold === "number" ? proposed.fibProximityThreshold : current.fibProximityThreshold,
    current.fibProximityThreshold, 0.20, 0.005, 0.10
  );
  const rsiOversold = clampPct(
    typeof proposed.rsiOversoldThreshold === "number" ? proposed.rsiOversoldThreshold : current.rsiOversoldThreshold,
    current.rsiOversoldThreshold, 0.20, 15, 45
  );
  const rsiOverbought = clampPct(
    typeof proposed.rsiOverboughtThreshold === "number" ? proposed.rsiOverboughtThreshold : current.rsiOverboughtThreshold,
    current.rsiOverboughtThreshold, 0.20, 55, 85
  );
  const volMult = clampPct(
    typeof proposed.volumeMultiplier === "number" ? proposed.volumeMultiplier : current.volumeMultiplier,
    current.volumeMultiplier, 0.20, 0.5, 3.0
  );
  const posMult = clampPct(
    typeof proposed.positionSizeMultiplier === "number" ? proposed.positionSizeMultiplier : current.positionSizeMultiplier,
    current.positionSizeMultiplier, 0.20, 0.1, 2.0
  );

  const minSigStr: "STRONG" | "MODERATE" = ["STRONG","MODERATE"].includes(proposed.minSignalStrength)
    ? proposed.minSignalStrength as "STRONG" | "MODERATE"
    : current.minSignalStrength;

  const regime: StrategyParams["marketRegime"] = ["bullish","bearish","ranging","choppy"].includes(proposed.marketRegime)
    ? proposed.marketRegime as StrategyParams["marketRegime"]
    : current.marketRegime;

  const horizon: StrategyParams["timeHorizonBias"] = ["short","mid","long"].includes(proposed.timeHorizonBias)
    ? proposed.timeHorizonBias as StrategyParams["timeHorizonBias"]
    : current.timeHorizonBias;

  return {
    timestamp: new Date().toISOString(),
    fibProximityThreshold: fib,
    rsiOversoldThreshold: rsiOversold,
    rsiOverboughtThreshold: rsiOverbought,
    volumeMultiplier: volMult,
    minSignalStrength: minSigStr,
    positionSizeMultiplier: posMult,
    marketRegime: regime,
    timeHorizonBias: horizon,
  };
}

function computeMetrics(risk: any, trade: any): MetricsSnapshot {
  const winRatePct = typeof risk?.winRate === "number" ? risk.winRate * 100 : null;
  const tradeLog: any[] = trade?.tradeLog ?? [];
  const tradeCount = tradeLog.length;
  const avgPnlUsd: number | null = typeof risk?.avgPnlUsd === "number" ? risk.avgPnlUsd : null;

  // Monthly return: rough estimate
  let monthlyReturnPct: number | null = null;
  if (tradeCount >= 5 && avgPnlUsd !== null) {
    const initialPortfolio = risk?.peakPortfolioValueUsd ?? risk?.portfolioValueUsd ?? 1000;
    if (initialPortfolio > 0) {
      // Scale to 30-day equivalent (rough: assume trades over a 30-day window)
      monthlyReturnPct = Math.round(((avgPnlUsd * tradeCount) / initialPortfolio) * 10000) / 100;
    }
  }

  // Profitable days percentage from tradeLog
  let profitableDaysPct: number | null = null;
  if (tradeCount >= 3) {
    const dayMap: Record<string, number> = {};
    for (const entry of tradeLog) {
      if (typeof entry.pnlUsd !== "number") continue;
      const day = (entry.timestamp ?? "").substring(0, 10);
      if (!day) continue;
      dayMap[day] = (dayMap[day] ?? 0) + entry.pnlUsd;
    }
    const days = Object.values(dayMap);
    if (days.length > 0) {
      const profDays = days.filter((d) => d > 0).length;
      profitableDaysPct = Math.round((profDays / days.length) * 10000) / 100;
    }
  }

  // Sharpe estimate: null if < 10 trades
  const sharpeEstimate: number | null = null; // requires volatility data we don't have yet

  // Compound growth: requires peak vs. initial data
  let compoundGrowthPct: number | null = null;
  if (risk?.portfolioValueUsd && risk?.peakPortfolioValueUsd) {
    // Use current vs peak as a proxy (if peak > initial, we've compounded)
    const initialGuess = trade?.tradeLog?.[0]
      ? null
      : null; // can't determine initial without history
    // Rough: if portfolio > some baseline
    compoundGrowthPct = null;
  }

  return {
    monthlyReturnPct,
    compoundGrowthPct,
    profitableDaysPct,
    sharpeEstimate,
    winRatePct,
  };
}

function gatherContext(lastRunAt: string | null): string {
  const parts: string[] = [];

  // ── Vault notes ────────────────────────────────────────────────────────────
  try {
    const mission = readNote("", "Mission.md");
    if (mission) parts.push(`=== MISSION.MD ===\n${mission}\n`);
  } catch { /* non-fatal */ }

  try {
    const alignLog = readNote("", "Alignment-Log.md");
    if (alignLog) parts.push(`=== ALIGNMENT-LOG.MD (last 2500 chars) ===\n${alignLog.slice(-2500)}\n`);
  } catch { /* non-fatal */ }

  try {
    const journal = readNote("", "System-Journal.md");
    if (journal) parts.push(`=== SYSTEM-JOURNAL.MD (last 3000 chars) ===\n${journal.slice(-3000)}\n`);
  } catch { /* non-fatal */ }

  try {
    const winning = readNote("Insights", "Winning-Patterns.md");
    if (winning) parts.push(`=== WINNING-PATTERNS.MD (last 2000 chars) ===\n${winning.slice(-2000)}\n`);
  } catch { /* non-fatal */ }

  try {
    const losing = readNote("Insights", "Losing-Patterns.md");
    if (losing) parts.push(`=== LOSING-PATTERNS.MD (last 2000 chars) ===\n${losing.slice(-2000)}\n`);
  } catch { /* non-fatal */ }

  // Last 3 daily notes
  try {
    const dailyFiles = listNotes("Daily").sort().reverse().slice(0, 3);
    for (const f of dailyFiles) {
      const content = readNote("Daily", f);
      if (content) parts.push(`=== DAILY/${f} (up to 1500 chars) ===\n${content.slice(0, 1500)}\n`);
    }
  } catch { /* non-fatal */ }

  // New trade notes since lastRunAt
  try {
    const tradeFiles = listNotes("Trades").sort();
    let newTrades = tradeFiles;
    if (lastRunAt) {
      const cutoffDate = lastRunAt.substring(0, 10).replace(/-/g, "");
      newTrades = tradeFiles.filter((f) => {
        const match = f.match(/^(\d{4}-\d{2}-\d{2})/);
        if (!match) return false;
        const fileDate = match[1].replace(/-/g, "");
        return fileDate >= cutoffDate;
      });
    }
    const recentTrades = newTrades.slice(-10);
    for (const f of recentTrades) {
      const content = readNote("Trades", f);
      if (content) parts.push(`=== TRADE/${f} ===\n${content.slice(0, 600)}\n`);
    }
  } catch { /* non-fatal */ }

  // ── Current state JSON ─────────────────────────────────────────────────────
  try {
    const analyst = readSharedJSON("analyst-state.json");
    if (analyst) {
      const summary = {
        signal: analyst.signal,
        strength: analyst.strength,
        price: analyst.price,
        rsi: analyst.rsi,
        ema9: analyst.ema9,
        ema21: analyst.ema21,
        ema50: analyst.ema50,
        fearGreedValue: analyst.fearGreedValue,
        fearGreedLabel: analyst.fearGreedLabel,
        marketChange24h: analyst.marketChange24h,
        reason: analyst.reason,
        timestamp: analyst.timestamp,
      };
      parts.push(`=== ANALYST-STATE (key fields) ===\n${JSON.stringify(summary, null, 2)}\n`);
    }
  } catch { /* non-fatal */ }

  try {
    const risk = readSharedJSON("risk-state.json");
    if (risk) {
      const summary = {
        halted: risk.halted,
        haltReason: risk.haltReason,
        portfolioValueUsd: risk.portfolioValueUsd,
        peakPortfolioValueUsd: risk.peakPortfolioValueUsd,
        drawdownPct: risk.drawdownPct,
        winRate: risk.winRate,
        avgPnlUsd: risk.avgPnlUsd,
        tradeCount: risk.tradeCount,
        riskNarrative: risk.riskNarrative,
        volatilityRegime: risk.volatilityRegime,
        liquidityWarning: risk.liquidityWarning,
        timestamp: risk.timestamp,
      };
      parts.push(`=== RISK-STATE (key fields) ===\n${JSON.stringify(summary, null, 2)}\n`);
    }
  } catch { /* non-fatal */ }

  try {
    const trade = readSharedJSON("trade-state.json");
    if (trade) {
      const today = new Date().toISOString().substring(0, 10);
      const todayTrades = (trade.tradeLog ?? []).filter(
        (t: any) => (t.timestamp ?? "").startsWith(today),
      );
      const summary = {
        status: trade.status,
        executedCount: trade.executedCount,
        skippedCount: trade.skippedCount,
        ethBalance: trade.ethBalance,
        usdcBalance: trade.usdcBalance,
        lastTrade: trade.lastTrade,
        todaysTrades: todayTrades.slice(-5),
        timestamp: trade.timestamp,
      };
      parts.push(`=== TRADE-STATE (today) ===\n${JSON.stringify(summary, null, 2)}\n`);
    }
  } catch { /* non-fatal */ }

  const full = parts.join("\n");
  return full.slice(0, 40000);
}

function buildCannonPrompt(context: string, currentParams: StrategyParams): string {
  return `You are StrategyCannon, the meta-strategic mission control layer for OptimusMegaPrime.

MISSION STATEMENT:
${MISSION_STATEMENT}

HARD CONSTRAINTS (IMMUTABLE):
- Maximum drawdown limit: 30% — this is absolute and cannot be changed
- Parameter changes per run: ±20% maximum change from current values per field
- System is live on Base mainnet with real funds

CURRENT STRATEGY PARAMS:
${JSON.stringify(currentParams, null, 2)}

SYSTEM CONTEXT (vault notes + current state):
${context}

YOUR TASK:
Perform a deep strategic analysis across three time horizons:
1. SHORT-TERM (next 24 hours): immediate market conditions, signals, risks
2. MID-TERM (7-30 days): trend analysis, regime assessment, parameter tuning
3. LONG-TERM (30+ days): strategic alignment, growth trajectory, structural factors

Assess mission alignment, compute a performance score (0-100), identify patterns, and propose adjusted strategy parameters.

RESPOND ONLY WITH VALID JSON (no markdown, no explanation outside JSON):
{
  "currentAlignment": "ALIGNED" | "DRIFTING" | "MISALIGNED",
  "alignmentReason": "<string, 1-2 sentences explaining alignment status>",
  "performanceScore": <number 0-100>,
  "metricsSnapshot": {
    "monthlyReturnPct": <number or null>,
    "compoundGrowthPct": <number or null>,
    "profitableDaysPct": <number or null>,
    "sharpeEstimate": <number or null>,
    "winRatePct": <number or null>
  },
  "shortTermAnalysis": "<string: 2-4 sentences on 24h outlook>",
  "midTermAnalysis": "<string: 2-4 sentences on 7-30d outlook>",
  "longTermAnalysis": "<string: 2-4 sentences on 30d+ strategic view>",
  "strategicDirectives": ["<directive 1>", "<directive 2>", ...],
  "proposedParams": {
    "fibProximityThreshold": <number>,
    "rsiOversoldThreshold": <number>,
    "rsiOverboughtThreshold": <number>,
    "volumeMultiplier": <number>,
    "minSignalStrength": "STRONG" | "MODERATE",
    "positionSizeMultiplier": <number>,
    "marketRegime": "bullish" | "bearish" | "ranging" | "choppy",
    "timeHorizonBias": "short" | "mid" | "long"
  },
  "projection30d": "<string: 2-4 sentences on 30-day projection>",
  "projection90d": "<string: 2-4 sentences on 90-day projection>",
  "patterns": {
    "winning": "<string: observed winning pattern summary>",
    "losing": "<string: observed losing pattern summary>"
  }
}

Keep strategicDirectives to max 5 items. Be specific and actionable. Base decisions on evidence from the context provided.`;
}

function queryClaudeOpus(prompt: string): Promise<any | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", ["-p", prompt, "--model", "claude-opus-4-6"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      proc.kill();
      console.warn("[StrategyCannon] Claude Opus timed out after 5 minutes.");
      resolve(null);
    }, 5 * 60 * 1000);

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code: number) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[StrategyCannon] Claude Opus exited ${code}: ${stderr.trim().substring(0, 200)}`);
        resolve(null);
        return;
      }
      try {
        const match = stdout.match(/\{[\s\S]+\}/);
        if (!match) {
          console.warn("[StrategyCannon] No JSON found in Claude response.");
          resolve(null);
          return;
        }
        const parsed = JSON.parse(match[0]);
        resolve(parsed);
      } catch (e) {
        console.warn("[StrategyCannon] Failed to parse Claude response:", (e as Error).message);
        resolve(null);
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      console.warn("[StrategyCannon] Claude CLI subprocess error:", err.message);
      resolve(null);
    });
  });
}

function writeObsidianOutputs(result: any, today: string): void {
  try {
    // 30-day projection note
    if (result.projection30d) {
      const content30 = `---
date: ${today}
type: projection
horizon: 30d
alignment: ${result.currentAlignment}
performanceScore: ${result.performanceScore}
---

# 30-Day Projection — ${today}

**Mission Alignment**: ${result.currentAlignment}
**Performance Score**: ${result.performanceScore}/100

## Projection

${result.projection30d}

## Strategic Directives
${(result.strategicDirectives ?? []).map((d: string) => `- ${d}`).join("\n")}

---
*Generated by StrategyCannon on ${new Date().toISOString()}*
`;
      writeNote("Projections", `${today}-30day.md`, content30);
    }
  } catch { /* non-fatal */ }

  try {
    // 90-day projection note
    if (result.projection90d) {
      const content90 = `---
date: ${today}
type: projection
horizon: 90d
alignment: ${result.currentAlignment}
---

# 90-Day Projection — ${today}

## Projection

${result.projection90d}

## Long-Term Analysis

${result.longTermAnalysis ?? "--"}

---
*Generated by StrategyCannon on ${new Date().toISOString()}*
`;
      writeNote("Projections", `${today}-90day.md`, content90);
    }
  } catch { /* non-fatal */ }

  try {
    // Daily note — cannon report
    const metrics = result.metricsSnapshot ?? {};
    const fmtPct = (v: number | null) => v !== null && v !== undefined ? `${v.toFixed(1)}%` : "--";
    const dailyContent = `---
date: ${today}
cannon_run: true
alignment: ${result.currentAlignment}
performance_score: ${result.performanceScore}
market_regime: ${result.proposedParams?.marketRegime ?? "--"}
---

# StrategyCannon Daily Report — ${today}

## Mission Alignment: ${result.currentAlignment}

${result.alignmentReason ?? "--"}

## Performance Score: ${result.performanceScore}/100

| Metric | Value |
|--------|-------|
| Monthly Return | ${fmtPct(metrics.monthlyReturnPct)} |
| Compound Growth | ${fmtPct(metrics.compoundGrowthPct)} |
| Profitable Days | ${fmtPct(metrics.profitableDaysPct)} |
| Win Rate | ${fmtPct(metrics.winRatePct)} |
| Sharpe (est.) | ${metrics.sharpeEstimate !== null ? (metrics.sharpeEstimate ?? "--") : "--"} |

## Three-Horizon Analysis

### SHORT-TERM (24H)
${result.shortTermAnalysis ?? "--"}

### MID-TERM (7-30D)
${result.midTermAnalysis ?? "--"}

### LONG-TERM (30D+)
${result.longTermAnalysis ?? "--"}

## Strategic Directives
${(result.strategicDirectives ?? []).map((d: string, i: number) => `${i + 1}. ${d}`).join("\n")}

## Pattern Recognition

**Winning Patterns**: ${result.patterns?.winning ?? "--"}

**Losing Patterns**: ${result.patterns?.losing ?? "--"}

---
*StrategyCannon run complete. Next scheduled: 00:00 UTC.*
`;
    writeDaily(dailyContent);
  } catch { /* non-fatal */ }

  try {
    // Append to Alignment-Log.md
    const alignEntry = `
## ${today} — ${result.currentAlignment}

**Score**: ${result.performanceScore}/100
**Regime**: ${result.proposedParams?.marketRegime ?? "--"}

${result.alignmentReason ?? "--"}

**Directives**:
${(result.strategicDirectives ?? []).map((d: string) => `- ${d}`).join("\n")}

---
`;
    appendToNote("", "Alignment-Log.md", alignEntry);
  } catch { /* non-fatal */ }
}

async function runCannon(trigger: "startup" | "scheduled" | "manual"): Promise<void> {
  console.log(`\n[StrategyCannon] Running cannon (trigger: ${trigger})...`);
  const startTime = Date.now();

  // Ensure shared/ dir exists
  if (!fs.existsSync(SHARED_DIR)) {
    fs.mkdirSync(SHARED_DIR, { recursive: true });
  }

  // Init vault
  initVault();

  // Read current state
  const prevCannonState = readCannonState();
  const currentParams = readStrategyParams();
  const lastRunAt = prevCannonState?.lastRunAt ?? null;

  console.log(`[StrategyCannon] Gathering context (lastRunAt: ${lastRunAt ?? "never"})...`);
  const context = gatherContext(lastRunAt);
  console.log(`[StrategyCannon] Context gathered: ${context.length} chars`);

  const prompt = buildCannonPrompt(context, currentParams);

  console.log(`[StrategyCannon] Querying Claude Opus (this may take up to 5 minutes)...`);
  const opusResult = await queryClaudeOpus(prompt);

  const today = new Date().toISOString().substring(0, 10);
  const now = new Date().toISOString();

  // Compute nextRunAt (next 00:00 UTC)
  const nextMidnight = new Date();
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  nextMidnight.setUTCHours(0, 0, 0, 0);
  const nextRunAt = nextMidnight.toISOString();

  // Read state files for metrics
  const riskState  = readSharedJSON("risk-state.json");
  const tradeState = readSharedJSON("trade-state.json");
  const computedMetrics = computeMetrics(riskState, tradeState);
  const drawdownCurrent = riskState?.drawdown ?? 0;

  let cannonState: CannonState;
  let finalParams: StrategyParams;

  if (opusResult === null) {
    console.warn("[StrategyCannon] Claude Opus failed — writing fallback DRIFTING state, keeping current params.");
    cannonState = {
      timestamp: now,
      missionStatement: MISSION_STATEMENT,
      currentAlignment: "DRIFTING",
      alignmentReason: "StrategyCannon could not reach Claude Opus. Keeping current parameters unchanged.",
      performanceScore: 50,
      metricsSnapshot: computedMetrics,
      drawdownStatus: { current: drawdownCurrent, limit: 0.30, ok: drawdownCurrent < 0.30 },
      strategicDirectives: ["Monitor system — Claude Opus unavailable for strategic assessment"],
      shortTermAnalysis: "Analysis unavailable — Claude Opus subprocess failed.",
      midTermAnalysis: "Analysis unavailable — Claude Opus subprocess failed.",
      longTermAnalysis: "Analysis unavailable — Claude Opus subprocess failed.",
      marketRegime: currentParams.marketRegime,
      projection30d: "Projection unavailable.",
      projection90d: "Projection unavailable.",
      lastRunAt: now,
      nextRunAt,
      runDurationMs: Date.now() - startTime,
    };
    finalParams = { ...currentParams, timestamp: now };
  } else {
    console.log(`[StrategyCannon] Claude Opus responded. Alignment: ${opusResult.currentAlignment}, Score: ${opusResult.performanceScore}`);

    // Validate and clamp proposed params
    const proposedParams = opusResult.proposedParams ?? {};
    finalParams = validateAndClampParams(proposedParams, currentParams);

    // Merge metrics (prefer Claude's assessment if available, else use computed)
    const mergedMetrics: MetricsSnapshot = {
      monthlyReturnPct:   opusResult.metricsSnapshot?.monthlyReturnPct   ?? computedMetrics.monthlyReturnPct,
      compoundGrowthPct:  opusResult.metricsSnapshot?.compoundGrowthPct  ?? computedMetrics.compoundGrowthPct,
      profitableDaysPct:  opusResult.metricsSnapshot?.profitableDaysPct  ?? computedMetrics.profitableDaysPct,
      sharpeEstimate:     opusResult.metricsSnapshot?.sharpeEstimate      ?? computedMetrics.sharpeEstimate,
      winRatePct:         opusResult.metricsSnapshot?.winRatePct         ?? computedMetrics.winRatePct,
    };

    cannonState = {
      timestamp: now,
      missionStatement: MISSION_STATEMENT,
      currentAlignment: ["ALIGNED","DRIFTING","MISALIGNED"].includes(opusResult.currentAlignment)
        ? opusResult.currentAlignment
        : "DRIFTING",
      alignmentReason: typeof opusResult.alignmentReason === "string"
        ? opusResult.alignmentReason.substring(0, 500)
        : "No reason provided.",
      performanceScore: typeof opusResult.performanceScore === "number"
        ? Math.max(0, Math.min(100, Math.round(opusResult.performanceScore)))
        : 50,
      metricsSnapshot: mergedMetrics,
      drawdownStatus: { current: drawdownCurrent, limit: 0.30, ok: drawdownCurrent < 0.30 },
      strategicDirectives: Array.isArray(opusResult.strategicDirectives)
        ? opusResult.strategicDirectives.slice(0, 5).map((d: any) => String(d).substring(0, 200))
        : [],
      shortTermAnalysis: typeof opusResult.shortTermAnalysis === "string"
        ? opusResult.shortTermAnalysis.substring(0, 1000)
        : "--",
      midTermAnalysis: typeof opusResult.midTermAnalysis === "string"
        ? opusResult.midTermAnalysis.substring(0, 1000)
        : "--",
      longTermAnalysis: typeof opusResult.longTermAnalysis === "string"
        ? opusResult.longTermAnalysis.substring(0, 1000)
        : "--",
      marketRegime: finalParams.marketRegime,
      projection30d: typeof opusResult.projection30d === "string"
        ? opusResult.projection30d.substring(0, 1000)
        : "--",
      projection90d: typeof opusResult.projection90d === "string"
        ? opusResult.projection90d.substring(0, 1000)
        : "--",
      lastRunAt: now,
      nextRunAt,
      runDurationMs: Date.now() - startTime,
    };
  }

  // Write cannon state
  try {
    fs.writeFileSync(CANNON_STATE, JSON.stringify(cannonState, null, 2));
    console.log(`[StrategyCannon] Wrote cannon-state.json`);
  } catch (e) {
    console.error("[StrategyCannon] Failed to write cannon-state.json:", (e as Error).message);
  }

  // Write strategy params
  try {
    fs.writeFileSync(STRATEGY_PARAMS, JSON.stringify(finalParams, null, 2));
    console.log(`[StrategyCannon] Wrote strategy-params.json`);
  } catch (e) {
    console.error("[StrategyCannon] Failed to write strategy-params.json:", (e as Error).message);
  }

  // Write Obsidian outputs
  writeObsidianOutputs(opusResult ?? { currentAlignment: "DRIFTING", performanceScore: 50, strategicDirectives: [] }, today);
  console.log(`[StrategyCannon] Wrote Obsidian outputs`);

  const durationMs = Date.now() - startTime;
  console.log(`\n[StrategyCannon] ─── RUN COMPLETE ───────────────────────────`);
  console.log(`  Alignment:   ${cannonState.currentAlignment}`);
  console.log(`  Score:       ${cannonState.performanceScore}/100`);
  console.log(`  Regime:      ${cannonState.marketRegime}`);
  console.log(`  Next run:    ${nextRunAt}`);
  console.log(`  Duration:    ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Directives:  ${cannonState.strategicDirectives.length}`);
  cannonState.strategicDirectives.forEach((d, i) => console.log(`    ${i + 1}. ${d}`));
  console.log(`[StrategyCannon] ──────────────────────────────────────────────\n`);
}

function scheduleNextRun(): void {
  const now = Date.now();
  const nextMidnight = new Date();
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  nextMidnight.setUTCHours(0, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now;

  console.log(`[StrategyCannon] Next scheduled run at ${nextMidnight.toISOString()} (in ${Math.round(msUntilMidnight / 60000)}m)`);

  setTimeout(() => {
    runCannon("scheduled").catch((e) =>
      console.error("[StrategyCannon] Scheduled run error:", (e as Error).message),
    );
    // After first scheduled run, repeat every 24h
    setInterval(() => {
      runCannon("scheduled").catch((e) =>
        console.error("[StrategyCannon] Interval run error:", (e as Error).message),
      );
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  STRATEGYCANNON // OPTIMUSMEGAPRIME MISSION CONTROL          ║");
  console.log("║  Meta-strategic layer — claude-opus-4-6 — daily cadence      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const args = process.argv.slice(2);
  const isDaemon = args.includes("--daemon");
  const isScheduleOnly = args.includes("--schedule");

  if (isScheduleOnly) {
    // Just schedule, no immediate run (for external orchestration)
    scheduleNextRun();
    return;
  }

  // Run immediately (startup or manual trigger)
  const trigger = isDaemon ? "startup" : "manual";
  await runCannon(trigger);

  if (isDaemon) {
    // Keep process alive and schedule future runs
    scheduleNextRun();
    console.log("[StrategyCannon] Daemon mode — waiting for next 00:00 UTC run...");
  } else {
    // One-shot — exit after run
    process.exit(0);
  }
}

if (isMain) {
  main().catch((err) => {
    console.error("[StrategyCannon] Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { readStrategyParams, StrategyParams, DEFAULT_PARAMS };
