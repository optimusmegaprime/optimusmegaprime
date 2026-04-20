/**
 * TradeClaw — ETH/USDC Autonomous Trade Executor
 *
 * LLM routing: claude CLI subprocess (`claude -p "..."`) — uses Max subscription,
 * no API tokens. Spawned once per trade as Gate 5 (final approval before swap).
 *
 * Watches shared/analyst-state.json for BUY/SELL signals from AnalystClaw.
 * On STRONG or MODERATE signals that pass all gates it executes a swap via
 * the CDP Smart Wallet action provider on Base mainnet.
 * Results are written to shared/trade-state.json for RiskClaw to consume.
 *
 * Gate sequence:
 *   0   RiskClaw HALT flag
 *   0b  Liquidity warning (Uniswap V3 depth < $50k)
 *   0c  Stop-loss forced close (lot below stopLossPct — executes before signal eval)
 *   1   Signal strength (STRONG/MODERATE only)
 *   2   Signal freshness (< 20 min)
 *   3   Deduplication (one execution per candleStart)
 *   4   Cooldown (15 min between trades)
 *   5   Claude CLI approval (`claude -p`) — EXECUTE or SKIP with reason
 *
 * Per-lot position tracking (Appendix A):
 *   Every BUY creates a Lot keyed by txHash. SELLs close lots FIFO.
 *   Legacy pre-system ETH represented as a named lot with verified cost basis.
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

loadEnv({ path: path.join(__dirname, "../.env") });

// ── LLM routing ───────────────────────────────────────────────────────────────
export const MODEL_ID = "claude-cli";

// ── Config ────────────────────────────────────────────────────────────────────

const NATIVE_ETH   = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const POSITION_SIZE: Record<"STRONG" | "MODERATE", number> = {
  STRONG:   0.20,
  MODERATE: 0.20,
};

// Per-lot risk defaults (global, tunable by StrategyCannon in future)
const DEFAULT_PROFIT_TARGET_PCT = 0.05; // 5% — close lot when +5% on entry price
const DEFAULT_STOP_LOSS_PCT     = 0.04; // 4% — close lot when -4% on entry price

const MIN_ETH_TRADE      = 0.0002;
const MIN_USDC_TRADE     = 0.50;
const SLIPPAGE_BPS       = 100;
const MAX_SIGNAL_AGE_MS  = 20 * 60 * 1000;
const TRADE_COOLDOWN_MS  = 15 * 60 * 1000;
const POLL_INTERVAL_MS   = 30_000;
const MAX_RISK_STATE_AGE_MS = 3 * 60 * 1000;

const ANALYST_STATE = path.join(__dirname, "../shared/analyst-state.json");
const TRADE_STATE   = path.join(__dirname, "../shared/trade-state.json");
const RISK_STATE    = path.join(__dirname, "../shared/risk-state.json");

// ── Types ─────────────────────────────────────────────────────────────────────

// Per-lot position record. One created per BUY swap, closed on SELL or stop-loss.
export interface Lot {
  id: string;                             // txHash of BUY (or "legacy-preexisting-YYYYMMDD")
  status: "OPEN" | "PARTIAL" | "CLOSED";

  // Entry
  openedAt: string;                       // ISO timestamp of BUY
  entryPriceUsd: number;                  // ETH/USD at open
  ethBought: number;                      // total ETH received at open
  usdcSpent: number;                      // total USDC paid at open
  ethRemaining: number;                   // ETH still held in this lot
  usdcCostRemaining: number;              // cost basis of remaining ETH

  fibLevelAtEntry: number | null;
  rsiAtEntry: number | null;
  signalStrength: "STRONG" | "MODERATE" | null;

  // Exit (populated on close or partial close)
  closedAt: string | null;
  exitPriceUsd: number | null;
  ethSold: number | null;                 // cumulative ETH closed from this lot
  usdcReceived: number | null;            // cumulative USDC received from closing
  realizedPnlUsd: number | null;
  realizedPnlPct: string | null;
  closeReason: "SIGNAL" | "STOP_LOSS" | "PROFIT_TARGET" | "MANUAL" | null;

  // Risk thresholds (global defaults, future: per-lot overridable by StrategyCannon)
  profitTargetPct: number;
  stopLossPct: number | null;             // null = stop-loss disabled

  // Chain references
  txHashOpen: string | null;             // null for legacy lot
  txHashClose: string | null;
  notes: string | null;
}

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
  lots: Lot[];
  // Backward-compat WACB fields — computed from lots, read-only
  openPositionUsdcSpent: number;
  openPositionEthHeld: number;
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

let isExecuting             = false;
let lastExecutedCandleStart = "";
let lastTradeTimestamp      = 0;
let executedCount           = 0;
let skippedCount            = 0;
let lastTrade: LastTrade | null = null;
let tradeLog: TradeLogEntry[]   = [];
let lots: Lot[]                 = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

// Compute backward-compat WACB fields from current lots array
function computeWacb(): { openPositionUsdcSpent: number; openPositionEthHeld: number } {
  const openLots = lots.filter(l => l.status !== "CLOSED");
  return {
    openPositionEthHeld:   openLots.reduce((s, l) => s + l.ethRemaining, 0),
    openPositionUsdcSpent: openLots.reduce((s, l) => s + l.usdcCostRemaining, 0),
  };
}

function writeTradeState(
  walletAddress: string,
  ethBalance: string,
  usdcBalance: string,
  status: "IDLE" | "EXECUTING",
  lastSignalSeen: TradeState["lastSignalSeen"],
): void {
  const { openPositionUsdcSpent, openPositionEthHeld } = computeWacb();
  const state: TradeState = {
    timestamp: new Date().toISOString(),
    model: MODEL_ID,
    status,
    walletAddress,
    ethBalance,
    usdcBalance,
    lastTrade,
    tradeLog,
    lots,
    openPositionUsdcSpent,
    openPositionEthHeld,
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

// ── Lot management ────────────────────────────────────────────────────────────

function createLot(
  txHash: string,
  entryPriceUsd: number,
  ethBought: number,
  usdcSpent: number,
  fibLevelAtEntry: number | null,
  rsiAtEntry: number | null,
  signalStrength: "STRONG" | "MODERATE" | null,
  openedAt: string,
  notes: string | null = null,
  stopLossPct: number | null = DEFAULT_STOP_LOSS_PCT,
): Lot {
  return {
    id: txHash,
    status: "OPEN",
    openedAt,
    entryPriceUsd,
    ethBought,
    usdcSpent,
    ethRemaining: ethBought,
    usdcCostRemaining: usdcSpent,
    fibLevelAtEntry,
    rsiAtEntry,
    signalStrength,
    closedAt: null,
    exitPriceUsd: null,
    ethSold: null,
    usdcReceived: null,
    realizedPnlUsd: null,
    realizedPnlPct: null,
    closeReason: null,
    profitTargetPct: DEFAULT_PROFIT_TARGET_PCT,
    stopLossPct,
    txHashOpen: txHash.startsWith("legacy") ? null : txHash,
    txHashClose: null,
    notes,
  };
}

// Close lots FIFO. Distributes usdcReceived proportionally by ETH contributed.
// Returns aggregate realized P&L across all affected lots.
function closeLotsFifo(
  ethToSell: number,
  totalUsdcReceived: number,
  exitPrice: number,
  txHash: string,
  closedAt: string,
  closeReason: "SIGNAL" | "STOP_LOSS" | "PROFIT_TARGET",
): { totalRealizedPnlUsd: number; affectedLotIds: string[] } {
  const eligible = lots
    .filter(l => l.status !== "CLOSED" && l.ethRemaining > 0.000000001)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));

  let ethLeft = ethToSell;
  let totalPnl = 0;
  const affected: string[] = [];

  for (const lot of eligible) {
    if (ethLeft <= 0.000000001) break;

    const ethFromLot     = Math.min(ethLeft, lot.ethRemaining);
    const fracOfSale     = ethFromLot / ethToSell;
    const usdcForLot     = totalUsdcReceived * fracOfSale;
    const fracOfLot      = ethFromLot / lot.ethRemaining;
    const costForLot     = lot.usdcCostRemaining * fracOfLot;
    const pnl            = usdcForLot - costForLot;

    lot.ethRemaining      = Math.max(0, lot.ethRemaining - ethFromLot);
    lot.usdcCostRemaining = Math.max(0, lot.usdcCostRemaining - costForLot);
    lot.ethSold           = (lot.ethSold ?? 0) + ethFromLot;
    lot.usdcReceived      = (lot.usdcReceived ?? 0) + usdcForLot;
    lot.realizedPnlUsd    = (lot.realizedPnlUsd ?? 0) + pnl;

    totalPnl += pnl;
    ethLeft  -= ethFromLot;
    affected.push(lot.id);

    if (lot.ethRemaining < 0.000001) {
      lot.status         = "CLOSED";
      lot.closedAt       = closedAt;
      lot.exitPriceUsd   = exitPrice;
      lot.closeReason    = closeReason;
      lot.txHashClose    = txHash;
      lot.realizedPnlPct = lot.usdcSpent > 0
        ? `${(((lot.realizedPnlUsd ?? 0) / lot.usdcSpent) * 100).toFixed(2)}%`
        : null;
    } else {
      lot.status = "PARTIAL";
    }
  }

  return { totalRealizedPnlUsd: totalPnl, affectedLotIds: affected };
}

// ── Obsidian lot notes ────────────────────────────────────────────────────────

function writeLotOpenNote(lot: Lot): void {
  try {
    const date = lot.openedAt.substring(0, 10);
    const shortId = lot.txHashOpen ? lot.txHashOpen.substring(2, 14) : lot.id.substring(0, 12);
    const filename = `${shortId}-${date}.md`;
    const content =
`---
lot_id: ${lot.id}
status: ${lot.status}
opened: ${lot.openedAt}
entry_price: ${lot.entryPriceUsd}
eth_bought: ${lot.ethBought.toFixed(8)}
usdc_spent: ${lot.usdcSpent.toFixed(4)}
fib_at_entry: ${lot.fibLevelAtEntry !== null ? (lot.fibLevelAtEntry * 100).toFixed(1) + "%" : "null"}
rsi_at_entry: ${lot.rsiAtEntry ?? "null"}
signal_strength: ${lot.signalStrength ?? "null"}
profit_target: ${(lot.profitTargetPct * 100).toFixed(0)}%
stop_loss: ${lot.stopLossPct !== null ? (lot.stopLossPct * 100).toFixed(0) + "%" : "disabled"}
tx_hash_open: ${lot.txHashOpen ?? "null"}
---

# LOT OPEN — ${date}

**Entry**: $${lot.entryPriceUsd.toFixed(2)}/ETH
**Size**: ${lot.ethBought.toFixed(8)} ETH (cost ${lot.usdcSpent.toFixed(4)} USDC)
**Targets**: TP +${(lot.profitTargetPct * 100).toFixed(0)}% / SL -${lot.stopLossPct !== null ? (lot.stopLossPct * 100).toFixed(0) + "%" : "disabled"}
${lot.notes ? "\n**Notes**: " + lot.notes : ""}
${lot.txHashOpen ? "\n**Tx**: https://basescan.org/tx/" + lot.txHashOpen : ""}
`;
    writeNote("Lots", filename, content);
  } catch { /* non-fatal */ }
}

function writeLotCloseNote(lot: Lot): void {
  try {
    const date = lot.openedAt.substring(0, 10);
    const shortId = lot.txHashOpen ? lot.txHashOpen.substring(2, 14) : lot.id.substring(0, 12);
    const filename = `${shortId}-${date}.md`;
    const pnl = lot.realizedPnlUsd !== null
      ? `${lot.realizedPnlUsd >= 0 ? "+" : ""}${lot.realizedPnlUsd.toFixed(4)} USDC (${lot.realizedPnlPct ?? "?"})`
      : "unknown";
    const content =
`---
lot_id: ${lot.id}
status: ${lot.status}
opened: ${lot.openedAt}
closed: ${lot.closedAt ?? "null"}
entry_price: ${lot.entryPriceUsd}
exit_price: ${lot.exitPriceUsd ?? "null"}
eth_bought: ${lot.ethBought.toFixed(8)}
eth_sold: ${(lot.ethSold ?? 0).toFixed(8)}
eth_remaining: ${lot.ethRemaining.toFixed(8)}
usdc_spent: ${lot.usdcSpent.toFixed(4)}
usdc_received: ${(lot.usdcReceived ?? 0).toFixed(4)}
realized_pnl_usd: ${lot.realizedPnlUsd?.toFixed(4) ?? "null"}
realized_pnl_pct: ${lot.realizedPnlPct ?? "null"}
close_reason: ${lot.closeReason ?? "null"}
tx_hash_open: ${lot.txHashOpen ?? "null"}
tx_hash_close: ${lot.txHashClose ?? "null"}
---

# LOT ${lot.status} — ${date}

**Entry**: $${lot.entryPriceUsd.toFixed(2)}/ETH
**Exit**: $${(lot.exitPriceUsd ?? 0).toFixed(2)}/ETH
**P&L**: ${pnl}
**ETH sold**: ${(lot.ethSold ?? 0).toFixed(8)} / ${lot.ethBought.toFixed(8)} ETH
**Close reason**: ${lot.closeReason ?? "—"}
${lot.notes ? "\n**Notes**: " + lot.notes : ""}
${lot.txHashClose ? "\n**Close Tx**: https://basescan.org/tx/" + lot.txHashClose : ""}
`;
    writeNote("Lots", filename, content);

    if (lot.realizedPnlUsd !== null) {
      const patternLine = `\n- **${(lot.closedAt ?? lot.openedAt).substring(0, 10)}** ` +
        `LOT-${shortId} ${lot.closeReason} ${pnl} — ` +
        `entry $${lot.entryPriceUsd.toFixed(2)} Fib ${lot.fibLevelAtEntry !== null ? (lot.fibLevelAtEntry * 100).toFixed(1) + "%" : "--"} ` +
        `RSI ${lot.rsiAtEntry?.toFixed(1) ?? "--"}\n`;
      appendToNote(
        "Insights",
        (lot.realizedPnlUsd >= 0 ? "Winning-Patterns.md" : "Losing-Patterns.md"),
        patternLine,
      );
    }
  } catch { /* non-fatal */ }
}

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
  const portVal = parseFloat(usdcBalance) + parseFloat(ethBalance) * signal.price;
  const recent  = log.slice(-3);
  const network = process.env.NETWORK_ID ?? "base-mainnet";
  const openLots = lots.filter(l => l.status !== "CLOSED");

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

── OPEN LOTS (${openLots.length}) ──────────────────────────────────────────────
${openLots.length
  ? openLots.map(l => {
      const unrealizedPct = ((signal.price - l.entryPriceUsd) / l.entryPriceUsd * 100).toFixed(1);
      return `  ${l.id.substring(0, 14)}.. ${l.ethRemaining.toFixed(6)} ETH @ $${l.entryPriceUsd.toFixed(2)} → ${parseFloat(unrealizedPct) >= 0 ? "+" : ""}${unrealizedPct}% unrealized`;
    }).join("\n")
  : "  (none)"}

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

  // ── Gate 0c: Stop-loss forced close ──────────────────────────────────────
  // RiskClaw writes stopLossFlags[] when any lot breaches its threshold.
  // We execute forced closes here before normal signal evaluation.
  const stopFlags = (riskState as unknown as { stopLossFlags?: Array<{ lotId: string; triggerPrice: number }> })
    .stopLossFlags ?? [];

  for (const flag of stopFlags) {
    const lot = lots.find(l => l.id === flag.lotId && l.status !== "CLOSED" && l.ethRemaining > 0.000001);
    if (!lot) continue;

    console.log(
      `[TradeClaw] \x1b[31m⚠ STOP-LOSS TRIGGER\x1b[0m — lot ${lot.id.substring(0, 16)}... ` +
      `entry $${lot.entryPriceUsd.toFixed(2)} threshold $${flag.triggerPrice.toFixed(2)} current $${signal.price.toFixed(2)}`,
    );

    isExecuting = true;
    try {
      const slEthToSell = lot.ethRemaining;
      const slFromAmount = fmt(slEthToSell, 6);
      if (slEthToSell < MIN_ETH_TRADE) {
        console.log(`[TradeClaw] Stop-loss skipped — lot too small (${slEthToSell.toFixed(8)} ETH < min)`);
        continue;
      }

      writeTradeState(walletAddress, ethStr, usdcStr, "EXECUTING", {
        signal: "SELL", strength: "STRONG", price: signal.price,
        candleStart: signal.candleStart, action: "EXECUTED",
      });

      const slResult = JSON.parse(await swapProvider.swap(walletProvider, {
        fromToken: NATIVE_ETH, toToken: USDC_ADDRESS,
        fromAmount: slFromAmount, slippageBps: SLIPPAGE_BPS,
      })) as { success: boolean; transactionHash?: string; toAmount?: string; error?: string };

      if (!slResult.success) throw new Error(slResult.error ?? "Stop-loss swap failed");

      const slUsdcReceived = parseFloat(slResult.toAmount ?? "0");
      const slTxHash       = slResult.transactionHash ?? "";
      const slNow          = new Date().toISOString();

      const { totalRealizedPnlUsd, affectedLotIds } = closeLotsFifo(
        slEthToSell, slUsdcReceived, signal.price, slTxHash, slNow, "STOP_LOSS",
      );

      for (const id of affectedLotIds) {
        const closed = lots.find(l => l.id === id);
        if (closed) writeLotCloseNote(closed);
      }

      lastTradeTimestamp = Date.now();
      executedCount++;
      const pnlColor = totalRealizedPnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `[TradeClaw] Stop-loss closed ${slFromAmount} ETH → ${slUsdcReceived.toFixed(4)} USDC  ` +
        `P&L: ${pnlColor}${totalRealizedPnlUsd >= 0 ? "+" : ""}${totalRealizedPnlUsd.toFixed(4)} USDC${RESET}`,
      );

      lastTrade = {
        timestamp: slNow, action: "SELL",
        fromToken: NATIVE_ETH, toToken: USDC_ADDRESS,
        fromAmount: slFromAmount, fromTokenName: "ETH",
        toAmount: slResult.toAmount ?? "0", toTokenName: "USDC",
        txHash: slTxHash, network: "base-mainnet",
        signalStrength: "STRONG", signalPrice: signal.price,
        candleStart: signal.candleStart,
      };

      const slEntry: TradeLogEntry = {
        timestamp: slNow, action: "SELL",
        entryPriceUsd: signal.price, exitPriceUsd: signal.price,
        fromAmount: slFromAmount, fromTokenName: "ETH",
        toAmount: slResult.toAmount ?? "0", toTokenName: "USDC",
        pnlUsd: parseFloat(totalRealizedPnlUsd.toFixed(4)),
        pnlPct: null,
        entryReason: `STOP-LOSS: lot ${lot.id.substring(0, 14)} breached ${((lot.stopLossPct ?? 0) * 100).toFixed(0)}% threshold`,
        txHash: slTxHash,
        fibLevelAtEntry: null, fibPriceAtEntry: null,
        rsiAtEntry: signal.rsi, fearGreedAtEntry: null, fearGreedLabelAtEntry: null,
        signalStrength: "STRONG",
        claudeReason: `Automatic stop-loss — no Claude approval required`,
      };
      tradeLog.push(slEntry);
      if (tradeLog.length > 50) tradeLog.shift();

    } catch (err) {
      console.error(`[TradeClaw] Stop-loss execution failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isExecuting = false;
    }
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

  // ── Gate 3: deduplication ─────────────────────────────────────────────────
  if (signal.candleStart === lastExecutedCandleStart) {
    return;
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

  // ── Position sizing ───────────────────────────────────────────────────────
  const volMultiplier    = riskState?.volatilityMultiplier ?? 1.0;
  const cannonMultiplier = strategyParams.positionSizeMultiplier ?? 1.0;
  const rawPct  = POSITION_SIZE[signal.strength as "STRONG" | "MODERATE"] * volMultiplier * cannonMultiplier;
  const pct     = Math.min(0.30, rawPct);
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
    fromToken     = USDC_ADDRESS;
    toToken       = NATIVE_ETH;
    fromAmountNum = usdcBalance * pct;

    if (fromAmountNum < MIN_USDC_TRADE) {
      console.log(
        `[TradeClaw] BUY skipped — trade size ${fmt(fromAmountNum, 2)} USDC < min ${MIN_USDC_TRADE} USDC.`,
      );
      writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
        signal: signal.signal, strength: signal.strength, price: signal.price,
        candleStart: signal.candleStart, action: "SKIPPED",
        skipReason: `BUY size ${fmt(fromAmountNum, 2)} USDC below minimum ${MIN_USDC_TRADE} USDC`,
      });
      skippedCount++;
      return;
    }
  } else {
    fromToken     = NATIVE_ETH;
    toToken       = USDC_ADDRESS;
    fromAmountNum = ethBalance * pct;

    if (fromAmountNum < MIN_ETH_TRADE) {
      console.log(
        `[TradeClaw] SELL skipped — trade size ${fmt(fromAmountNum, 6)} ETH < min ${MIN_ETH_TRADE} ETH.`,
      );
      writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
        signal: signal.signal, strength: signal.strength, price: signal.price,
        candleStart: signal.candleStart, action: "SKIPPED",
        skipReason: `SELL size ${fmt(fromAmountNum, 6)} ETH below minimum ${MIN_ETH_TRADE} ETH`,
      });
      skippedCount++;
      return;
    }
  }

  const fromAmount = signal.signal === "BUY" ? fmt(fromAmountNum, 2) : fmt(fromAmountNum, 6);
  const fromName   = signal.signal === "BUY" ? "USDC" : "ETH";
  const toName     = signal.signal === "BUY" ? "ETH"  : "USDC";

  // ── Gate 5: Claude CLI trade approval ────────────────────────────────────
  const promptText = buildTradePrompt(signal, ethStr, usdcStr, fromAmount, fromName, toName, tradeLog);
  console.log("[TradeClaw] Gate 5 — consulting claude CLI for trade approval…");
  const t0c      = Date.now();
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

  writeTradeState(walletAddress, ethStr, usdcStr, "EXECUTING", {
    signal: signal.signal, strength: signal.strength, price: signal.price,
    candleStart: signal.candleStart, action: "EXECUTED",
  });

  try {
    const resultJson = await swapProvider.swap(walletProvider, {
      fromToken, toToken, fromAmount, slippageBps: SLIPPAGE_BPS,
    });

    const result = JSON.parse(resultJson) as {
      success: boolean;
      transactionHash?: string;
      toAmount?: string;
      network?: string;
      error?: string;
      approvalTxHash?: string;
    };

    if (!result.success) throw new Error(result.error ?? "Swap returned success:false");

    lastExecutedCandleStart = signal.candleStart;
    lastTradeTimestamp = Date.now();
    executedCount++;

    const toAmountNum = parseFloat(result.toAmount ?? "0");
    const txHash      = result.transactionHash ?? "";
    const tradeNow    = new Date().toISOString();

    lastTrade = {
      timestamp: tradeNow, action: signal.signal as "BUY" | "SELL",
      fromToken, toToken, fromAmount, fromTokenName: fromName,
      toAmount: result.toAmount ?? "unknown", toTokenName: toName,
      txHash, network: result.network ?? "base-mainnet",
      signalStrength: signal.strength as "STRONG" | "MODERATE",
      signalPrice: signal.price, candleStart: signal.candleStart,
    };

    // ── Per-lot accounting ──────────────────────────────────────────────────
    let pnlUsd: number | null = null;
    let pnlPct: string | null = null;

    if (signal.signal === "BUY") {
      const newLot = createLot(
        txHash, signal.price, toAmountNum, fromAmountNum,
        signal.nearestFibLevel ?? null, signal.rsi,
        signal.strength as "STRONG" | "MODERATE",
        tradeNow,
      );
      lots.push(newLot);
      writeLotOpenNote(newLot);

      const { openPositionEthHeld, openPositionUsdcSpent } = computeWacb();
      console.log(
        `  New lot: ${txHash.substring(0, 18)}...  ${toAmountNum.toFixed(6)} ETH @ $${signal.price.toFixed(2)}`,
      );
      console.log(
        `  Open position: ${lots.filter(l => l.status !== "CLOSED").length} lots | ` +
        `${openPositionEthHeld.toFixed(6)} ETH | $${openPositionUsdcSpent.toFixed(2)} cost`,
      );

    } else if (signal.signal === "SELL") {
      const { totalRealizedPnlUsd, affectedLotIds } = closeLotsFifo(
        fromAmountNum, toAmountNum, signal.price, txHash, tradeNow, "SIGNAL",
      );
      pnlUsd = parseFloat(totalRealizedPnlUsd.toFixed(4));
      const costBasis = lots
        .filter(l => affectedLotIds.includes(l.id))
        .reduce((s, l) => s + l.usdcSpent, 0);
      pnlPct = costBasis > 0 ? `${((pnlUsd / costBasis) * 100).toFixed(2)}%` : null;

      for (const id of affectedLotIds) {
        const closed = lots.find(l => l.id === id);
        if (closed) writeLotCloseNote(closed);
      }

      const pnlColor = pnlUsd >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(
        `  FIFO close: ${affectedLotIds.length} lots  ` +
        `P&L: ${pnlColor}${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(4)} USDC` +
        (pnlPct ? ` (${pnlPct})` : "") + RESET,
      );
    }

    // Append to trade log
    const logEntry: TradeLogEntry = {
      timestamp: tradeNow, action: signal.signal as "BUY" | "SELL",
      entryPriceUsd: signal.price, exitPriceUsd: signal.signal === "SELL" ? signal.price : null,
      fromAmount, fromTokenName: fromName,
      toAmount: result.toAmount ?? "0", toTokenName: toName,
      pnlUsd, pnlPct,
      entryReason: signal.reason,
      txHash,
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

    // Write completed trade to Obsidian Trades/ vault
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
    console.log(`  Tx hash: ${txHash}`);

    const ethWeiPost  = await walletProvider.getBalance();
    const ethPost     = fmt(parseFloat(formatUnits(ethWeiPost, 18)), 6);
    const usdcRawPost = (await walletProvider.readContract({
      address: USDC_ADDRESS as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress as `0x${string}`],
    })) as bigint;
    const usdcPost = fmt(parseFloat(formatUnits(usdcRawPost, 6)), 2);

    writeTradeState(walletAddress, ethPost, usdcPost, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "EXECUTED",
    });
    console.log(`  Post-trade: ${ethPost} ETH  |  ${usdcPost} USDC\n`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TradeClaw] Swap failed: ${errMsg}`);
    writeTradeState(walletAddress, ethStr, usdcStr, "IDLE", {
      signal: signal.signal, strength: signal.strength, price: signal.price,
      candleStart: signal.candleStart, action: "ERROR", error: errMsg,
    });
  } finally {
    isExecuting = false;
  }
}

// ── Startup: restore lots state with migration ────────────────────────────────

function restoreLotsState(): void {
  const saved = readJson<TradeState>(TRADE_STATE);

  tradeLog      = saved?.tradeLog      ?? [];
  executedCount = saved?.executedCount ?? 0;
  skippedCount  = saved?.skippedCount  ?? 0;
  lastTrade     = saved?.lastTrade     ?? null;

  // ── Fast path: lots already persisted ─────────────────────────────────────
  if (saved?.lots?.length) {
    lots = saved.lots;
    const open = lots.filter(l => l.status !== "CLOSED");
    const { openPositionEthHeld, openPositionUsdcSpent } = computeWacb();
    console.log(
      `[TradeClaw] Restored ${lots.length} lots (${open.length} open) — ` +
      `${openPositionEthHeld.toFixed(6)} ETH / $${openPositionUsdcSpent.toFixed(2)} USDC cost basis`,
    );
    for (const lot of open) {
      console.log(
        `  Lot ${lot.id.substring(0, 18)}..  ${lot.status}  ` +
        `${lot.ethRemaining.toFixed(6)} ETH @ $${lot.entryPriceUsd.toFixed(2)} ` +
        `(cost $${lot.usdcCostRemaining.toFixed(2)})`,
      );
    }
    return;
  }

  // ── Migration path: reconstruct lots from tradeLog + create legacy lot ────
  console.log("[TradeClaw] No lots[] found — running migration from tradeLog...");
  const tempLots: Lot[] = [];

  // STEP A: Create legacy lot for pre-system ETH (verified on-chain 2026-04-20)
  // Source: ORION investigation — 5 USDC→ETH swaps + 1 CEX deposit on April 19
  // net of 2 ETH→USDC sells. WACB $2305.55/ETH, $172.60 USDC, 0.074162 ETH.
  const legacyLot = createLot(
    "legacy-preexisting-20260419",
    2305.55,
    0.074162,
    172.60,
    null, null, null,
    "2026-04-19T00:00:00.000Z",
    "Pre-system manual trades April 19 2026. Cost basis verified on-chain via Blockscout: " +
    "5 USDC→ETH swaps + 1 Coinbase CEX deposit, net of 2 ETH→USDC sells. " +
    "WACB $2305.55/ETH, total cost $172.60 USDC, 0.074162 ETH.",
  );
  tempLots.push(legacyLot);

  // STEP B: Reconstruct lots from tradeLog BUYs, then apply SELL entries FIFO
  for (const entry of tradeLog) {
    if (entry.action === "BUY") {
      const lot = createLot(
        entry.txHash || `reconstructed-${entry.timestamp}`,
        entry.entryPriceUsd,
        parseFloat(entry.toAmount),   // ETH received
        parseFloat(entry.fromAmount), // USDC spent
        entry.fibLevelAtEntry ?? null,
        entry.rsiAtEntry,
        entry.signalStrength,
        entry.timestamp,
      );
      tempLots.push(lot);
      console.log(
        `  [migrate] BUY lot ${lot.id.substring(0, 18)}...  ` +
        `${lot.ethBought.toFixed(6)} ETH @ $${lot.entryPriceUsd.toFixed(2)}`,
      );

    } else if (entry.action === "SELL") {
      const ethToSell       = parseFloat(entry.fromAmount);
      const totalUsdcRecvd  = parseFloat(entry.toAmount);
      const closedAt        = entry.timestamp;
      const exitPrice       = entry.entryPriceUsd;
      const sellTxHash      = entry.txHash;

      // FIFO close across tempLots (skip legacy lot — use signal lots only)
      const eligible = tempLots
        .filter(l => l.status !== "CLOSED" && l.ethRemaining > 0.000000001 &&
                     !l.id.startsWith("legacy"))
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt));

      let ethLeft = ethToSell;
      for (const lot of eligible) {
        if (ethLeft <= 0.000000001) break;
        const ethFromLot  = Math.min(ethLeft, lot.ethRemaining);
        const fracOfSale  = ethFromLot / ethToSell;
        const usdcForLot  = totalUsdcRecvd * fracOfSale;
        const fracOfLot   = ethFromLot / lot.ethRemaining;
        const costForLot  = lot.usdcCostRemaining * fracOfLot;
        const pnl         = usdcForLot - costForLot;

        lot.ethRemaining      = Math.max(0, lot.ethRemaining - ethFromLot);
        lot.usdcCostRemaining = Math.max(0, lot.usdcCostRemaining - costForLot);
        lot.ethSold           = (lot.ethSold ?? 0) + ethFromLot;
        lot.usdcReceived      = (lot.usdcReceived ?? 0) + usdcForLot;
        lot.realizedPnlUsd    = (lot.realizedPnlUsd ?? 0) + pnl;
        ethLeft              -= ethFromLot;

        if (lot.ethRemaining < 0.000001) {
          lot.status         = "CLOSED";
          lot.closedAt       = closedAt;
          lot.exitPriceUsd   = exitPrice;
          lot.closeReason    = "SIGNAL";
          lot.txHashClose    = sellTxHash;
          lot.realizedPnlPct = lot.usdcSpent > 0
            ? `${(((lot.realizedPnlUsd ?? 0) / lot.usdcSpent) * 100).toFixed(2)}%` : null;
          console.log(
            `  [migrate] CLOSED lot ${lot.id.substring(0, 18)}...  ` +
            `P&L: ${(lot.realizedPnlUsd ?? 0) >= 0 ? "+" : ""}${(lot.realizedPnlUsd ?? 0).toFixed(4)} USDC (${lot.realizedPnlPct ?? "?"})`,
          );
        } else {
          lot.status = "PARTIAL";
          console.log(
            `  [migrate] PARTIAL lot ${lot.id.substring(0, 18)}...  ` +
            `${lot.ethRemaining.toFixed(6)} ETH remaining`,
          );
        }
      }
    }
  }

  lots = tempLots;

  const open = lots.filter(l => l.status !== "CLOSED");
  const { openPositionEthHeld, openPositionUsdcSpent } = computeWacb();
  console.log(
    `[TradeClaw] Migration complete: ${lots.length} lots (${open.length} open) — ` +
    `${openPositionEthHeld.toFixed(6)} ETH / $${openPositionUsdcSpent.toFixed(2)} cost basis`,
  );

  // Verify reconciliation
  const totalOpenEth = open.reduce((s, l) => s + l.ethRemaining, 0);
  console.log(`[TradeClaw] Open ETH reconciliation: ${totalOpenEth.toFixed(8)} ETH in lots`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initVault();
  restoreLotsState();
  console.log("\n[TradeClaw] Starting trade executor — per-lot tracking active");
  console.log(`  LLM routing:    claude CLI subprocess (Gate 5 approval)`);
  console.log(`  Analyst state:  ${ANALYST_STATE}`);
  console.log(`  Trade state:    ${TRADE_STATE}`);
  console.log(`  Risk state:     ${RISK_STATE}`);
  console.log(`  Position sizes: STRONG=${POSITION_SIZE.STRONG * 100}%  MODERATE=${POSITION_SIZE.MODERATE * 100}%`);
  console.log(`  Lot defaults:   TP +${DEFAULT_PROFIT_TARGET_PCT * 100}%  SL -${DEFAULT_STOP_LOSS_PCT * 100}%`);
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

  setInterval(() => {
    strategyParams = readStrategyParams();
  }, 5 * 60 * 1000);

  console.log("[TradeClaw] Ready. Waiting for signals…\n");
}

main().catch((err) => {
  console.error("[TradeClaw] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
