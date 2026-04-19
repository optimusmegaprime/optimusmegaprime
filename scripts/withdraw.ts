// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  MANUAL EXECUTION ONLY                                                       ║
// ║                                                                              ║
// ║  This script must NEVER be imported, called, or triggered by any other       ║
// ║  script, agent, or automated process.                                        ║
// ║                                                                              ║
// ║  Run only via:                                                               ║
// ║    npm run withdraw        — withdraw profit above WITHDRAWAL_KEEP_USD       ║
// ║    npm run withdraw:dry    — dry-run, no transaction sent                    ║
// ║    npm run withdraw:all    — sweep entire USDC balance                       ║
// ║                                                                              ║
// ║  DO NOT import this file. Any import will be treated as a bug.               ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

/**
 * OptimusMegaPrime — USDC Withdrawal Script
 *
 * Sends USDC from the trading wallet to WITHDRAWAL_ADDRESS (set in .env).
 *
 * Usage:
 *   npm run withdraw                  # withdraw all profit above WITHDRAWAL_KEEP_USD
 *   npm run withdraw -- --amount 50   # withdraw exactly $50 USDC
 *   npm run withdraw -- --all         # sweep entire USDC balance
 *   npm run withdraw -- --dry         # dry-run: print amounts, send nothing
 *
 * Required env:
 *   WITHDRAWAL_ADDRESS        — destination wallet on Base mainnet
 *
 * Optional env:
 *   WITHDRAWAL_KEEP_USD       — minimum USDC to leave in trading wallet (default: 10)
 *   WITHDRAWAL_THRESHOLD_USD  — auto-withdrawal triggers when USDC > this (default: 50)
 *
 * Run: npm run withdraw
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import { CdpSmartWalletProvider } from "@coinbase/agentkit";
import { prepareAgentkitAndWalletProvider } from "../app/api/agent/prepare-agentkit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

// ── Config ────────────────────────────────────────────────────────────────────
const USDC_ADDRESS       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const WITHDRAWAL_ADDRESS = (process.env.WITHDRAWAL_ADDRESS ?? "").trim() as `0x${string}`;
const KEEP_USD           = parseFloat(process.env.WITHDRAWAL_KEEP_USD      ?? "10");
export const THRESHOLD_USD = parseFloat(process.env.WITHDRAWAL_THRESHOLD_USD ?? "50");

// ── ANSI ──────────────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m",
      B = "\x1b[1m",  D = "\x1b[2m",  X = "\x1b[0m";

// ── Shared state path (used by auto-withdrawal notification) ──────────────────
const SHARED_DIR    = path.join(__dirname, "../shared");
const WITHDRAW_LOG  = path.join(SHARED_DIR, "withdraw-log.json");

// ── Read live USDC balance via Base public RPC ────────────────────────────────
export async function readUsdcBalance(address: string): Promise<number> {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: USDC_ADDRESS, data }, "latest"],
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "mainnet.base.org", path: "/", method: "POST",
      headers: { "Content-Type": "application/json",
                 "Content-Length": Buffer.byteLength(body),
                 "User-Agent": "OptimusMegaPrime/1.0" },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const hex = JSON.parse(d).result;
          resolve(hex && hex !== "0x" ? parseFloat(formatUnits(BigInt(hex), 6)) : 0);
        } catch { resolve(0); }
      });
    });
    req.on("error", () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
    req.end(body);
  });
}

// ── Append to withdrawal log ──────────────────────────────────────────────────
function logWithdrawal(entry: object): void {
  try {
    const existing = fs.existsSync(WITHDRAW_LOG)
      ? JSON.parse(fs.readFileSync(WITHDRAW_LOG, "utf8"))
      : [];
    existing.push(entry);
    if (existing.length > 100) existing.shift();
    fs.writeFileSync(WITHDRAW_LOG, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

// ── Core transfer function (shared by manual + auto) ─────────────────────────
export async function sendUsdc(
  walletProvider: CdpSmartWalletProvider,
  toAddress: `0x${string}`,
  amountUsdc: number,
  dry = false,
): Promise<{ txHash: string | null; amountUsdc: number }> {
  const amountRaw = parseUnits(amountUsdc.toFixed(6), 6);

  if (dry) {
    console.log(`${Y}[Withdraw] DRY RUN — would transfer ${amountUsdc.toFixed(2)} USDC → ${toAddress}${X}`);
    return { txHash: null, amountUsdc };
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [toAddress, amountRaw],
  });

  console.log(`${C}[Withdraw] Sending ${B}${amountUsdc.toFixed(2)} USDC${X}${C} → ${toAddress}${X}`);
  const txHash = await walletProvider.sendTransaction({
    to: USDC_ADDRESS,
    data,
    value: BigInt(0),
  });

  const receipt = await walletProvider.waitForTransactionReceipt(txHash as `0x${string}`);
  if (receipt.status !== "success" && receipt.status !== "complete") throw new Error(`Transfer reverted (status: ${receipt.status})`);

  return { txHash: txHash as string, amountUsdc };
}

// ── Auto-withdrawal: called by TradeClaw after SELL trades ───────────────────
export async function checkAutoWithdrawal(
  walletProvider: CdpSmartWalletProvider,
  walletAddress: string,
): Promise<void> {
  if (!WITHDRAWAL_ADDRESS || WITHDRAWAL_ADDRESS.length < 10) return;

  const usdcBalance = await readUsdcBalance(walletAddress);

  if (usdcBalance <= THRESHOLD_USD) {
    console.log(
      `${D}[Withdraw] Auto-check: $${usdcBalance.toFixed(2)} USDC ≤ threshold $${THRESHOLD_USD} — no withdrawal${X}`
    );
    return;
  }

  const withdrawAmount = parseFloat((usdcBalance - KEEP_USD).toFixed(6));
  if (withdrawAmount < 0.01) return;

  console.log(
    `\n${G}${B}[Withdraw] AUTO-WITHDRAWAL TRIGGERED${X}` +
    `\n  Balance:  $${usdcBalance.toFixed(2)} USDC > threshold $${THRESHOLD_USD}` +
    `\n  Sending:  $${withdrawAmount.toFixed(2)} USDC (keeping $${KEEP_USD.toFixed(2)})` +
    `\n  To:       ${WITHDRAWAL_ADDRESS}\n`
  );

  try {
    const { txHash } = await sendUsdc(
      walletProvider, WITHDRAWAL_ADDRESS, withdrawAmount
    );
    console.log(`${G}[Withdraw] ✓ Auto-withdrawal complete!${X}  tx: ${txHash}`);
    console.log(`  https://basescan.org/tx/${txHash}`);
    logWithdrawal({
      timestamp:     new Date().toISOString(),
      trigger:       "auto",
      amountUsdc:    withdrawAmount,
      toAddress:     WITHDRAWAL_ADDRESS,
      fromAddress:   walletAddress,
      txHash,
      balanceBefore: usdcBalance,
      balanceAfter:  KEEP_USD,
    });
  } catch (e: any) {
    console.error(`${R}[Withdraw] Auto-withdrawal failed: ${e.message}${X}`);
  }
}

// ── Manual CLI entry point ────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry  = args.includes("--dry");
  const all  = args.includes("--all");
  const amountFlag = args.indexOf("--amount");
  const specificAmount = amountFlag >= 0 ? parseFloat(args[amountFlag + 1]) : null;

  console.log(`\n${B}${C}⬡  OPTIMUSMEGAPRIME — USDC WITHDRAWAL${X}`);
  console.log(`${D}  ${new Date().toISOString()}${X}\n`);

  // Validate destination
  if (!WITHDRAWAL_ADDRESS || WITHDRAWAL_ADDRESS.length < 10) {
    console.error(`${R}✗ WITHDRAWAL_ADDRESS not set in .env${X}`);
    console.error(`  Add: WITHDRAWAL_ADDRESS=0xYourCoinbaseAddress`);
    process.exit(1);
  }

  if (specificAmount !== null && (isNaN(specificAmount) || specificAmount <= 0)) {
    console.error(`${R}✗ Invalid --amount value: ${args[amountFlag + 1]}${X}`);
    process.exit(1);
  }

  console.log(`  Destination : ${WITHDRAWAL_ADDRESS}`);
  console.log(`  Keep in wallet: $${KEEP_USD.toFixed(2)} USDC`);
  console.log(`  Auto-threshold: $${THRESHOLD_USD.toFixed(2)} USDC\n`);

  // Init wallet
  console.log("[Withdraw] Initializing wallet…");
  const { walletProvider } = await prepareAgentkitAndWalletProvider();
  const wallet = walletProvider as CdpSmartWalletProvider;
  const walletAddress = wallet.getAddress();

  console.log(`  Wallet:  ${walletAddress}`);
  console.log(`  Network: ${wallet.getNetwork().networkId}\n`);

  // Read live on-chain balance
  process.stdout.write("  Fetching live USDC balance…");
  const usdcBalance = await readUsdcBalance(walletAddress);
  process.stdout.write(`\r  Live USDC balance: ${B}$${usdcBalance.toFixed(2)}${X}\n\n`);

  if (usdcBalance < 0.01) {
    console.log(`${Y}⚠ No USDC balance to withdraw.${X}`);
    process.exit(0);
  }

  // Calculate withdrawal amount
  let withdrawAmount: number;
  if (specificAmount !== null) {
    withdrawAmount = specificAmount;
    if (withdrawAmount > usdcBalance) {
      console.error(`${R}✗ Requested $${withdrawAmount} exceeds balance $${usdcBalance.toFixed(2)}${X}`);
      process.exit(1);
    }
  } else if (all) {
    withdrawAmount = parseFloat(usdcBalance.toFixed(6));
  } else {
    // Default: withdraw profit above keep amount
    withdrawAmount = parseFloat((usdcBalance - KEEP_USD).toFixed(6));
    if (withdrawAmount <= 0) {
      console.log(
        `${Y}⚠ Balance $${usdcBalance.toFixed(2)} ≤ keep amount $${KEEP_USD.toFixed(2)} — nothing to withdraw.${X}\n` +
        `  Use --all to withdraw entire balance, or --amount N for a specific amount.`
      );
      process.exit(0);
    }
  }

  // Summary before sending
  console.log(`  ${B}Withdrawal plan:${X}`);
  console.log(`  ├ Send:      $${B}${withdrawAmount.toFixed(2)}${X} USDC`);
  console.log(`  ├ To:        ${WITHDRAWAL_ADDRESS}`);
  console.log(`  ├ Remaining: $${(usdcBalance - withdrawAmount).toFixed(2)} USDC in trading wallet`);
  console.log(`  └ Gas:       Paymaster sponsored (no ETH needed)\n`);

  if (dry) {
    console.log(`${Y}[DRY RUN] No transaction sent.${X}\n`);
    process.exit(0);
  }

  // Execute
  try {
    const { txHash } = await sendUsdc(wallet, WITHDRAWAL_ADDRESS, withdrawAmount);
    console.log(`\n${G}${B}✓ Withdrawal complete!${X}`);
    console.log(`  Tx hash:  ${txHash}`);
    console.log(`  Explorer: https://basescan.org/tx/${txHash}\n`);

    logWithdrawal({
      timestamp:     new Date().toISOString(),
      trigger:       "manual",
      amountUsdc:    withdrawAmount,
      toAddress:     WITHDRAWAL_ADDRESS,
      fromAddress:   walletAddress,
      txHash,
      balanceBefore: usdcBalance,
      balanceAfter:  usdcBalance - withdrawAmount,
    });
  } catch (e: any) {
    console.error(`\n${R}✗ Withdrawal failed: ${e.message}${X}`);
    process.exit(1);
  }
}

// Only run when invoked directly — never when imported
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`${R}[Withdraw] Fatal: ${e.message}${X}`);
    process.exit(1);
  });
}
