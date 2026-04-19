/**
 * mint-usdc — Request 1000 testnet USDC from CDP faucet on Base Sepolia.
 *
 * The CDP faucet for base-sepolia dispenses USDC to the smart wallet address.
 * Run once to fund the wallet before starting TradeClaw.
 *
 * Run: npm run mint-usdc
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";
import { erc20Abi, formatUnits } from "viem";
import { cdpApiActionProvider, CdpSmartWalletProvider } from "@coinbase/agentkit";
import { prepareAgentkitAndWalletProvider } from "../app/api/agent/prepare-agentkit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

async function getUsdcBalance(wallet: CdpSmartWalletProvider): Promise<number> {
  const raw = (await wallet.readContract({
    address: USDC_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.getAddress() as `0x${string}`],
  })) as bigint;
  return parseFloat(formatUnits(raw, 6));
}

async function mintOnce(
  wallet: CdpSmartWalletProvider,
  faucet: ReturnType<typeof cdpApiActionProvider>,
): Promise<number> {
  const before = await getUsdcBalance(wallet);
  const result = await faucet.faucet(wallet, { assetId: "usdc" });
  // Extract tx hash from result string for display
  const txMatch = result.match(/0x[0-9a-fA-F]{64}/);
  const txHash = txMatch ? txMatch[0].slice(0, 12) + "…" : "submitted";
  process.stdout.write(`  faucet tx ${txHash} — waiting for confirmation`);

  // Poll up to 60s for balance to increase
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const after = await getUsdcBalance(wallet);
    if (after > before) {
      const received = after - before;
      console.log(` +${received.toFixed(2)} USDC  →  balance: ${after.toFixed(2)} USDC`);
      return after;
    }
    process.stdout.write(".");
  }
  // Timed out — return current balance anyway
  const current = await getUsdcBalance(wallet);
  console.log(` (timed out)  →  balance: ${current.toFixed(2)} USDC`);
  return current;
}

// ── Single mint ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("[mint-usdc] Initializing wallet…");
  const { walletProvider } = await prepareAgentkitAndWalletProvider();
  const wallet = walletProvider as CdpSmartWalletProvider;
  console.log(`[mint-usdc] Wallet:  ${wallet.getAddress()}`);
  console.log(`[mint-usdc] Network: ${wallet.getNetwork().networkId}`);

  const before = await getUsdcBalance(wallet);
  console.log(`[mint-usdc] USDC before: ${before.toFixed(2)} USDC`);
  console.log("[mint-usdc] Requesting USDC from CDP faucet…");

  const faucet = cdpApiActionProvider();
  const after = await mintOnce(wallet, faucet);
  const received = after - before;
  console.log(`[mint-usdc] Received: +${received.toFixed(2)} USDC`);
  console.log("[mint-usdc] Done.");
}

// ── Loop mint ─────────────────────────────────────────────────────────────────
async function mainLoop(): Promise<void> {
  const TARGET_USDC = 1000;
  const DELAY_MS    = 10_000;

  console.log("[mint-usdc:loop] Initializing wallet…");
  const { walletProvider } = await prepareAgentkitAndWalletProvider();
  const wallet = walletProvider as CdpSmartWalletProvider;
  console.log(`[mint-usdc:loop] Wallet:  ${wallet.getAddress()}`);
  console.log(`[mint-usdc:loop] Network: ${wallet.getNetwork().networkId}`);
  console.log(`[mint-usdc:loop] Target:  ${TARGET_USDC} USDC\n`);

  const faucet = cdpApiActionProvider();
  let balance  = await getUsdcBalance(wallet);
  let round    = 0;

  console.log(`[mint-usdc:loop] Starting balance: ${balance.toFixed(2)} USDC`);

  while (balance < TARGET_USDC) {
    round++;
    console.log(`\n[mint-usdc:loop] Round ${round} — balance ${balance.toFixed(2)} / ${TARGET_USDC} USDC`);

    try {
      balance = await mintOnce(wallet, faucet);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mint-usdc:loop] Faucet error: ${msg} — retrying after ${DELAY_MS / 1000}s`);
    }

    if (balance < TARGET_USDC) {
      process.stdout.write(`[mint-usdc:loop] Waiting ${DELAY_MS / 1000}s before next call…`);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      console.log();
    }
  }

  console.log(`\n[mint-usdc:loop] ✓ Target reached: ${balance.toFixed(2)} USDC in wallet.`);
  console.log("[mint-usdc:loop] TradeClaw is now ready to execute BUY trades.");
}

// Dispatch based on which npm script invoked us
const isLoop = process.argv.includes("--loop") || process.env.npm_lifecycle_event === "mint-usdc:loop";

(isLoop ? mainLoop() : main()).catch((err) => {
  console.error("[mint-usdc] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
