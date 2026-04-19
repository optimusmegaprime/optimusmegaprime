/**
 * OptimusMegaPrime — Debug Protocol
 *
 * Run this first when anything seems wrong.
 * Prints a full system snapshot: agent statuses, last signals, risk state,
 * live wallet balances on Base mainnet, and recent log entries for each agent.
 *
 * Run: npm run debug
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  white:  "\x1b[97m",
  bgRed:  "\x1b[41m",
};

const ok   = (s: string) => `${C.green}✓${C.reset} ${s}`;
const warn = (s: string) => `${C.yellow}⚠${C.reset} ${s}`;
const err  = (s: string) => `${C.red}✗${C.reset} ${s}`;
const hdr  = (s: string) => `\n${C.bold}${C.cyan}${"─".repeat(60)}\n  ${s}\n${"─".repeat(60)}${C.reset}`;
const kv   = (k: string, v: string, colour = C.white) =>
  `  ${C.dim}${k.padEnd(24)}${C.reset}${colour}${v}${C.reset}`;

// ── File paths ────────────────────────────────────────────────────────────────
const SHARED   = path.join(__dirname, "../shared");
const A_STATE  = path.join(SHARED, "analyst-state.json");
const T_STATE  = path.join(SHARED, "trade-state.json");
const R_STATE  = path.join(SHARED, "risk-state.json");

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJSON(p: string): any | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e: any) { return null; }
}

function agentAge(ts: string | undefined): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 0)    return "future?";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s ago`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m ago`;
}

function agentStatus(ts: string | undefined, staleMs: number): string {
  if (!ts) return err("NO DATA — agent has never written state");
  const age = Date.now() - new Date(ts).getTime();
  if (age < staleMs) return ok(`LIVE   (last write: ${agentAge(ts)})`);
  if (age < staleMs * 3) return warn(`SLOW   (last write: ${agentAge(ts)})`);
  return err(`STALE  (last write: ${agentAge(ts)})`);
}

function fmtPrice(n: number | undefined | null): string {
  if (n == null) return "--";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function httpGet(url: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET",
        headers: { "User-Agent": "OptimusMegaPrime-Debug/1.0" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── Live wallet balance via Base public RPC ───────────────────────────────────
async function fetchWalletBalances(address: string): Promise<{
  ethWei: bigint | null; usdcRaw: bigint | null; ethPrice: number | null;
}> {
  // Use Base's public RPC node — not the Paymaster URL (bundler, not full node)
  const RPC  = "https://mainnet.base.org";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  const rpcPost = (method: string, params: any[]) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    return new Promise<any>((resolve, reject) => {
      const u = new URL(RPC);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname, method: "POST",
          headers: { "Content-Type": "application/json",
                     "Content-Length": Buffer.byteLength(body),
                     "User-Agent": "OptimusMegaPrime-Debug/1.0" } },
        (res) => {
          let d = ""; res.on("data", (c) => (d += c));
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("parse error")); } });
        }
      );
      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("RPC timeout")); });
      req.end(body);
    });
  };

  // balanceOf(address): 4-byte selector + 32-byte padded address = 36 bytes
  const balOfData = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");

  try {
    const [ethRes, usdcRes] = await Promise.all([
      rpcPost("eth_getBalance", [address, "latest"]),
      rpcPost("eth_call", [{ to: USDC, data: balOfData }, "latest"]),
    ]);

    const ethWei  = ethRes.result  && ethRes.result !== "0x" ? BigInt(ethRes.result)  : BigInt(0);
    // eth_call returns 32-byte hex for uint256; empty result means 0
    const usdcHex = usdcRes.result && usdcRes.result !== "0x" ? usdcRes.result : "0x0";
    const usdcRaw = BigInt(usdcHex);

    // ETH price from analyst state (live, no extra fetch) with CoinGecko fallback
    const analyst  = readJSON(A_STATE);
    let ethPrice: number | null = analyst?.price ?? null;
    if (!ethPrice) {
      try {
        const cg = await httpGet(
          "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", 6000
        );
        ethPrice = JSON.parse(cg)?.ethereum?.usd ?? null;
      } catch { /* non-fatal */ }
    }

    return { ethWei, usdcRaw, ethPrice };
  } catch(e: any) {
    return { ethWei: null, usdcRaw: null, ethPrice: null, fetchError: e?.message ?? String(e) } as any;
  }
}

// ── ENV key audit ─────────────────────────────────────────────────────────────
function checkEnv(): { label: string; status: string }[] {
  const required: [string, string][] = [
    ["ANTHROPIC_API_KEY",  "AnalystClaw LLM + chat UI"],
    ["CDP_API_KEY_ID",     "AgentKit wallet auth"],
    ["CDP_API_KEY_SECRET", "AgentKit wallet auth"],
    ["CDP_WALLET_SECRET",  "Smart wallet decryption"],
    ["NETWORK_ID",         "Chain selection"],
    ["PAYMASTER_URL",      "Gas sponsorship"],
    ["ETHERSCAN_API_KEY",  "Gas oracle / onchain data"],
    ["BASE_API_KEY",       "Base developer platform"],
  ];
  return required.map(([key, label]) => {
    const val = process.env[key];
    const status = val
      ? ok(`SET   ${C.dim}(${val.substring(0, 14)}...)${C.reset}   ${label}`)
      : err(`MISSING   ${label}`);
    return { label: key, status };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toISOString();
  console.log(`\n${C.bold}${C.white}⬡  OPTIMUSMEGAPRIME — DEBUG PROTOCOL${C.reset}  ${C.dim}${now}${C.reset}`);

  // ── 1. ENV ────────────────────────────────────────────────────────────────
  console.log(hdr("1/6  ENVIRONMENT KEYS"));
  const envChecks = checkEnv();
  for (const { label, status } of envChecks) {
    console.log(`  ${label.padEnd(24)} ${status}`);
  }
  const networkId = process.env.NETWORK_ID ?? "(not set)";
  const networkOk = networkId === "base-mainnet";
  console.log(`\n  ${networkOk ? ok("NETWORK: base-mainnet  ✓ mainnet") : err(`NETWORK: ${networkId}  ← should be base-mainnet`)}`);

  // ── 2. AGENT STATUS ───────────────────────────────────────────────────────
  console.log(hdr("2/6  AGENT STATUS"));
  const a = readJSON(A_STATE);
  const t = readJSON(T_STATE);
  const r = readJSON(R_STATE);

  console.log(kv("AnalystClaw",  agentStatus(a?.timestamp, 3 * 60_000)));   // stale > 3 min
  console.log(kv("TradeClaw",    agentStatus(t?.timestamp, 5 * 60_000)));   // stale > 5 min
  console.log(kv("RiskClaw",     agentStatus(r?.timestamp, 5 * 60_000)));   // stale > 5 min

  // ── 3. LAST ANALYST SIGNAL ────────────────────────────────────────────────
  console.log(hdr("3/6  LAST ANALYST SIGNAL"));
  if (!a) {
    console.log(err("  analyst-state.json not found or unreadable"));
  } else {
    const sigCol = a.signal === "BUY" ? C.green : a.signal === "SELL" ? C.red : C.yellow;
    const strCol = a.strength === "STRONG" ? C.green : a.strength === "MODERATE" ? C.yellow : C.dim;
    console.log(kv("Signal",       `${a.signal} · ${a.strength}`, sigCol + C.bold));
    console.log(kv("Strength col", a.strength ?? "--", strCol));
    console.log(kv("Price",        fmtPrice(a.price)));
    console.log(kv("RSI-14",       a.rsi != null ? a.rsi.toFixed(2) : "--"));
    console.log(kv("EMA 9/21/50",  a.ema9 ? `$${a.ema9.toFixed(0)} / $${a.ema21?.toFixed(0)} / $${a.ema50?.toFixed(0)}` : "--"));
    console.log(kv("Fib level",    a.nearestFibLevel != null ? `${(a.nearestFibLevel*100).toFixed(1)}%  $${a.nearestFibPrice?.toFixed(2) ?? "--"}` : "--"));
    console.log(kv("Fear/Greed",   a.fearGreedValue != null ? `${a.fearGreedValue} (${a.fearGreedLabel})` : "--",
      a.fearGreedValue <= 25 ? C.red : a.fearGreedValue >= 75 ? C.green : C.white));
    console.log(kv("Volume ratio", a.volumeRatio != null ? `${a.volumeRatio.toFixed(4)}x` : "--"));
    console.log(kv("Tick B/S",     a.tickBuySellRatio != null ? `${a.tickBuySellRatio.toFixed(3)}x` : "--"));
    console.log(kv("LLM analysis", a.llmAnalysis ? ok("true") : warn("false — algorithmic only")));
    console.log(kv("Analysis ms",  a.analysisMs != null ? `${a.analysisMs} ms` : "--"));
    console.log(kv("Data sources", (a.dataSourcesActive ?? []).join(", ") || "--"));
    console.log(kv("Candle start", a.candleStart ?? "--"));
    console.log(kv("Signal age",   agentAge(a.timestamp)));
    console.log(kv("Reason",       ""));
    console.log(`  ${C.dim}${a.reason ?? "--"}${C.reset}`);
  }

  // ── 4. RISK STATE ─────────────────────────────────────────────────────────
  console.log(hdr("4/6  RISK STATE"));
  if (!r) {
    console.log(err("  risk-state.json not found or unreadable"));
  } else {
    const haltCol = r.halted ? C.bgRed + C.white + C.bold : C.green;
    console.log(kv("HALT",          r.halted ? "⚠  HALTED" : "CLEAR", haltCol));
    if (r.halted && r.haltReason) {
      console.log(`  ${C.red}  Reason: ${r.haltReason}${C.reset}`);
    }
    console.log(kv("Portfolio",     r.portfolioValueUsd != null ? fmtPrice(r.portfolioValueUsd) : "--"));
    console.log(kv("Peak",          r.peakPortfolioValueUsd != null ? fmtPrice(r.peakPortfolioValueUsd) : "--"));
    console.log(kv("Drawdown",      r.drawdownPct ?? "--",
      parseFloat(r.drawdownPct ?? "0") > 20 ? C.red : C.white));
    console.log(kv("DD limit",      "40%  (hard arithmetic)"));
    console.log(kv("DD check",      r.checks?.drawdown?.ok    ? ok("PASS") : err("FAIL")));
    console.log(kv("Position check",r.checks?.positionSize?.ok ? ok("PASS") : err("FAIL")));
    console.log(kv("Trade count",   String(r.tradeCount ?? 0)));
    console.log(kv("Pending signal",r.pendingSignal ? `${r.pendingSignal} · ${r.pendingStrength}` : "--"));
    console.log(kv("Pos size pct",  r.pendingPositionSizePct != null
      ? `${(r.pendingPositionSizePct * 100).toFixed(1)}%` : "--"));
    if (r.riskNarrative) {
      console.log(kv("Risk narrative",""));
      console.log(`  ${C.dim}${r.riskNarrative}${C.reset}`);
    }
    console.log(kv("Claude ms",     r.claudeMs != null ? `${r.claudeMs} ms` : "N/A"));
    console.log(kv("Last eval",     agentAge(r.timestamp)));
  }

  // ── 5. TRADE STATE + LAST TRADES ─────────────────────────────────────────
  console.log(hdr("5/6  TRADE STATE  +  LAST 5 TRADES"));
  if (!t) {
    console.log(err("  trade-state.json not found or unreadable"));
  } else {
    const statusCol = t.status === "EXECUTING" ? C.green + C.bold : C.white;
    console.log(kv("Status",        t.status ?? "--", statusCol));
    console.log(kv("Wallet",        t.walletAddress ?? "--"));
    console.log(kv("ETH balance",   t.ethBalance ?? "--"));
    console.log(kv("USDC balance",  t.usdcBalance ? `$${parseFloat(t.usdcBalance).toFixed(2)}` : "--"));
    console.log(kv("Executed",      String(t.executedCount ?? 0)));
    console.log(kv("Skipped",       String(t.skippedCount ?? 0)));

    if (t.lastSignalSeen) {
      const ls = t.lastSignalSeen;
      const skipCol = ls.action === "EXECUTED" ? C.green : C.yellow;
      console.log(kv("Last signal",   `${ls.signal} · ${ls.strength}  →  ${ls.action}`, skipCol));
      if (ls.skipReason) console.log(kv("Skip reason",  ls.skipReason, C.dim));
    }

    if (t.lastTrade) {
      const lt = t.lastTrade;
      console.log(`\n  ${C.bold}Last trade:${C.reset}`);
      console.log(kv("  Action",      lt.action ?? "--", lt.action === "BUY" ? C.green : C.red));
      console.log(kv("  From",        `${lt.fromAmount} ${lt.fromTokenName}`));
      console.log(kv("  To",          `${lt.toAmount} ${lt.toTokenName}`));
      console.log(kv("  Network",     lt.network ?? "--"));
      console.log(kv("  Tx hash",     lt.txHash ? lt.txHash.substring(0, 20) + "..." : "none"));
      if (lt.txHash) {
        console.log(kv("  Explorer",  `https://basescan.org/tx/${lt.txHash}`));
      }
    }

    const tradeLog: any[] = t.tradeLog ?? [];
    if (tradeLog.length === 0) {
      console.log(`\n  ${C.dim}No trades in log yet.${C.reset}`);
    } else {
      console.log(`\n  ${C.bold}Last ${Math.min(5, tradeLog.length)} trade log entries:${C.reset}`);
      const recent = tradeLog.slice(-5).reverse();
      for (const tr of recent) {
        const ac  = tr.action === "BUY" ? C.green : C.red;
        const pnl = tr.pnlUsd != null
          ? (tr.pnlUsd >= 0 ? `${C.green}+$${tr.pnlUsd.toFixed(4)}${C.reset}` : `${C.red}-$${Math.abs(tr.pnlUsd).toFixed(4)}${C.reset}`)
          : `${C.dim}open${C.reset}`;
        const ts  = tr.timestamp ? new Date(tr.timestamp).toISOString().replace("T"," ").substring(0,19) : "--";
        console.log(`  ${C.dim}${ts}${C.reset}  ${ac}${tr.action}${C.reset}  ${tr.fromAmount} ${tr.fromTokenName} → ${tr.toAmount} ${tr.toTokenName}  pnl:${pnl}`);
        if (tr.claudeReason) console.log(`  ${C.dim}  ↳ ${tr.claudeReason.substring(0, 100)}${C.reset}`);
      }
    }
  }

  // ── 6. LIVE WALLET BALANCE ────────────────────────────────────────────────
  console.log(hdr("6/6  LIVE WALLET BALANCE  (mainnet.base.org RPC)"));
  const walletAddr = t?.walletAddress ?? process.env.WALLET_ADDRESS ?? null;
  if (!walletAddr) {
    console.log(warn("  No wallet address found in trade-state.json"));
  } else {
    console.log(kv("Wallet address", walletAddr));
    process.stdout.write(`  ${C.dim}Fetching live balances...${C.reset}`);
    try {
      const balances = await fetchWalletBalances(walletAddr);
      const { ethWei, usdcRaw, ethPrice } = balances;
      process.stdout.write("\r" + " ".repeat(40) + "\r");

      const fetchError = (balances as any).fetchError;
      if (ethWei === null) {
        console.log(warn(`  Etherscan fetch failed${fetchError ? ': ' + fetchError : ' — check ETHERSCAN_API_KEY / internet'}`));
      } else {
        const ethBal   = Number(ethWei) / 1e18;
        const usdcBal  = Number(usdcRaw) / 1e6;
        const ethUsd   = ethPrice ? ethBal * ethPrice : null;
        const portVal  = ethPrice ? ethBal * ethPrice + usdcBal : null;

        console.log(kv("ETH balance",  `${ethBal.toFixed(6)} ETH${ethUsd ? `  (${fmtPrice(ethUsd)})` : ""}`,
          ethBal < 0.001 ? C.yellow : C.white));
        console.log(kv("USDC balance", fmtPrice(usdcBal),
          usdcBal < 5 ? C.yellow : C.white));
        console.log(kv("ETH price",    ethPrice ? fmtPrice(ethPrice) : "unavailable"));
        console.log(kv("Portfolio USD",portVal ? fmtPrice(portVal) : "unavailable",
          portVal && portVal < 5 ? C.red : C.white));
        console.log(kv("Explorer",     `https://basescan.org/address/${walletAddr}`));

        if (usdcBal < 5) {
          console.log(`\n  ${warn("USDC balance < $5 — wallet needs funding before trades can execute")}`);
        }
        if (ethBal < 0.0001 && !process.env.PAYMASTER_URL) {
          console.log(`  ${warn("ETH balance near zero and no PAYMASTER_URL — gas will fail")}`);
        }
      }
    } catch (e: any) {
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      console.log(err(`  RPC fetch failed: ${e.message}`));
    }
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}${C.cyan}${"─".repeat(60)}${C.reset}`);
  const issues: string[] = [];
  if (!a) issues.push("analyst-state.json missing");
  else if (Date.now() - new Date(a.timestamp).getTime() > 3 * 60_000)
    issues.push(`AnalystClaw stale (${agentAge(a.timestamp)})`);
  if (!t) issues.push("trade-state.json missing");
  if (!r) issues.push("risk-state.json missing");
  if (r?.halted) issues.push(`RiskClaw HALTED: ${r.haltReason}`);
  if (networkId !== "base-mainnet") issues.push(`NETWORK_ID=${networkId} — should be base-mainnet`);
  if (!process.env.PAYMASTER_URL) issues.push("PAYMASTER_URL not set");

  if (issues.length === 0) {
    console.log(`  ${ok("All systems nominal")}\n`);
  } else {
    console.log(`  ${C.bold}${C.red}Issues detected:${C.reset}`);
    for (const i of issues) console.log(`  ${err(i)}`);
    console.log();
  }
}

main().catch((e) => {
  console.error(`\n${C.red}Debug script crashed: ${e.message}${C.reset}`);
  process.exit(1);
});
