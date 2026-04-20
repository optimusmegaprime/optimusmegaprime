/**
 * AnalystClaw — ETH/USDC Algorithmic Signal Engine
 *
 * No LLM calls. Pure indicator-based signal generation every 1-min candle.
 * Writes analyst-state.json for TradeClaw + RiskClaw to consume.
 *
 * Timeframe:  ONE_MINUTE candles + live market_trades tick stream
 *
 * Signal logic (scored, no LLM):
 *   RSI oversold/overbought, EMA trend alignment, Fibonacci confluence,
 *   volume surge, tick microstructure (B/S ratio, momentum), Fear & Greed
 *   contrarian bias. Net score → BUY/SELL/HOLD at STRONG/MODERATE/WEAK.
 *
 * Data sources (fetched in parallel, written to state for TradeClaw):
 *   Coinbase candles      — 1-min OHLCV, 200-bar rolling window
 *   Coinbase trades       — live tick stream, 200-trade rolling buffer
 *   Fear & Greed Index    — alternative.me/fng, no key (15-min TTL)
 *   CoinGecko             — market cap, volume, dominance (5-min TTL)
 *   Etherscan V2          — L1 gas oracle + network stats (3-min TTL)
 *
 * Required env:  ETHERSCAN_API_KEY
 * Optional env:  COINGECKO_API_KEY
 *
 * Run: npm run analyst
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { config as loadEnv } from "dotenv";
import { initVault, appendToNote } from "./obsidian-writer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

// ── Strategy params (written by StrategyCannon, re-read every 5 min) ──────────

interface AnalystStrategyParams {
  rsiOversoldThreshold: number;
  rsiOverboughtThreshold: number;
  volumeMultiplier: number;
  [key: string]: unknown;
}

const STRATEGY_PARAMS_PATH = path.join(__dirname, "../shared/strategy-params.json");
const STRATEGY_PARAMS_DEFAULTS: AnalystStrategyParams = {
  rsiOversoldThreshold: 30,
  rsiOverboughtThreshold: 70,
  volumeMultiplier: 1.0,
};

function readStrategyParams(): AnalystStrategyParams {
  try {
    if (!fs.existsSync(STRATEGY_PARAMS_PATH)) return { ...STRATEGY_PARAMS_DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(STRATEGY_PARAMS_PATH, "utf8"));
    return {
      rsiOversoldThreshold:   typeof raw.rsiOversoldThreshold   === "number" ? raw.rsiOversoldThreshold   : STRATEGY_PARAMS_DEFAULTS.rsiOversoldThreshold,
      rsiOverboughtThreshold: typeof raw.rsiOverboughtThreshold === "number" ? raw.rsiOverboughtThreshold : STRATEGY_PARAMS_DEFAULTS.rsiOverboughtThreshold,
      volumeMultiplier:       typeof raw.volumeMultiplier       === "number" ? raw.volumeMultiplier       : STRATEGY_PARAMS_DEFAULTS.volumeMultiplier,
    };
  } catch {
    return { ...STRATEGY_PARAMS_DEFAULTS };
  }
}

let strategyParams: AnalystStrategyParams = readStrategyParams();
setInterval(() => { strategyParams = readStrategyParams(); }, 5 * 60 * 1000);

// ── Signal mode ───────────────────────────────────────────────────────────────
export const MODEL_ID = "algorithmic"; // no LLM — TradeClaw/RiskClaw use claude CLI

// ── Config ────────────────────────────────────────────────────────────────────
const PRODUCT_ID       = "ETH-USDC";
const WS_URL           = "wss://advanced-trade-ws.coinbase.com";
const REST_URL         = "https://api.coinbase.com/api/v3/brokerage/market/products";
const GRANULARITY      = "ONE_MINUTE";
const CANDLE_WINDOW    = 200;  // rolling candle history
const SEED_CANDLES     = 200;
const TICK_BUFFER_SIZE = 200;  // rolling live trade history
const STATE_FILE       = path.join(__dirname, "../shared/analyst-state.json");
const RECONNECT_MS     = 5_000;

// External API TTLs
const FEAR_GREED_TTL = 15 * 60 * 1000;
const MARKET_TTL     =  5 * 60 * 1000;
const ONCHAIN_TTL    =  3 * 60 * 1000;

// RSI / EMA periods — scoring inputs for algorithmic signal
const RSI_PERIOD = 14;
const EMA_FAST   = 9;
const EMA_MID    = 21;
const EMA_SLOW   = 50;
const VOL_LOOKBACK = 20;

// ── Types ─────────────────────────────────────────────────────────────────────
interface Candle {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Tick {
  price: number;
  size: number;
  side: "BUY" | "SELL";
  time: string;
}

interface FearGreedData {
  value: number;
  label: string;
  timestamp: string;
  history: { value: number; label: string; timestamp: string }[];
}

interface MarketData {
  ethPriceUsd: number;
  ethMarketCapUsd: number;
  ethVolume24hUsd: number;
  ethChange24h: number;
  ethChange7d: number | null;
  btcChange24h: number | null;
  totalMarketCapUsd: number | null;
  ethDominancePct: number | null;
}

interface OnchainData {
  safeGasGwei: number;
  proposeGasGwei: number;
  fastGasGwei: number;
  gasUsedRatio: string | null;
  lastBlock: number | null;
}

interface WhaleData {
  direction: "BUY" | "SELL" | "NONE";
  amountUsd: number;
  count: number;
  buyCount: number;
  sellCount: number;
  recentSwaps: { direction: "BUY" | "SELL"; amountUsd: number; timestamp: number }[];
  fetchedAt: string;
}

interface OrderBookData {
  bidWall: number;    // USD value of bids within 0.5% below mid
  askWall: number;    // USD value of asks within 0.5% above mid
  ratio: number;      // bidWall / askWall
  midPrice: number;
  updatedAt: string;
}

interface LargeTxData {
  inflow: number;     // ETH flowing into Uniswap (sells)
  outflow: number;    // ETH flowing out of Uniswap (buys)
  count: number;
  fetchedAt: string;
}

interface NansenSmartMoneyData {
  netflow1hUsd: number | null;    // positive = smart money net buying ETH
  netflow24hUsd: number | null;
  labeledBuyUsd: number;          // labeled wallet buys in last 15 min
  labeledSellUsd: number;
  labeledBuyCount: number;
  labeledSellCount: number;
  direction: "BUY" | "SELL" | "NEUTRAL";
  fetchedAt: string;
}

export interface SignalState {
  // Whale & order flow
  whaleActivity?: WhaleData | null;
  orderBook?: OrderBookData | null;
  largeTransactions?: LargeTxData | null;
  nansenSmartMoney?: NansenSmartMoneyData | null;

  timestamp: string;
  product: string;
  candleStart: string;
  granularity: string;
  price: number;
  signal: "BUY" | "SELL" | "HOLD";
  strength: "STRONG" | "MODERATE" | "WEAK";
  // Computed indicators (reference only — included in prompt but not rule-based)
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  nearestFibLevel: number | null;
  nearestFibPrice: number | null;
  volumeRatio: number;
  swingHigh: number;
  swingLow: number;
  windowSize: number;
  // Tick stream stats
  tickCount: number;
  tickBuySellRatio: number | null;
  tickMomentumPct: number | null;
  latestTickPrice: number | null;
  // Signal metadata
  reason: string;
  llmAnalysis: boolean;
  analysisMs: number;
  // External data availability
  fearGreedValue: number | null;
  fearGreedLabel: string | null;
  marketChange24h: number | null;
  gasGwei: number | null;
  dataSourcesActive: string[];
}

// ── TTL Cache ─────────────────────────────────────────────────────────────────
class TTLCache<T> {
  private store = new Map<string, { data: T; expires: number }>();
  get(key: string): T | null {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expires) return null;
    return e.data;
  }
  set(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expires: Date.now() + ttlMs });
  }
}

const fearGreedCache = new TTLCache<FearGreedData>();
const marketCache    = new TTLCache<MarketData>();
const onchainCache   = new TTLCache<OnchainData>();
const whaleCache     = new TTLCache<WhaleData>();
const largeTxCache   = new TTLCache<LargeTxData>();
const nansenCache    = new TTLCache<NansenSmartMoneyData>();

const WHALE_TTL    = 2 * 60 * 1000;  // 2 min — whale swaps
const LARGE_TX_TTL = 30 * 1000;      // 30 sec — large tx polling
const NANSEN_TTL   = 5 * 60 * 1000;  // 5 min — smart money netflow (hourly snapshots)

const NANSEN_URL      = "https://api.nansen.ai";
const WETH_ETHEREUM   = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const UNISWAP_ROUTERS = [
  "0xE592427A0AEce92De3Edee1F18E0157C05861564",  // SwapRouter
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",  // SwapRouter02
].map((a) => a.toLowerCase());

// ── CandleWindow ──────────────────────────────────────────────────────────────
class CandleWindow {
  private candles: Candle[] = [];

  seed(candles: Candle[]): void {
    this.candles = [...candles].sort((a, b) => a.start - b.start).slice(-CANDLE_WINDOW);
  }

  // Returns true only on a new candle close (not mid-candle updates)
  upsert(candle: Candle): boolean {
    const idx = this.candles.findIndex((c) => c.start === candle.start);
    if (idx === -1) {
      this.candles.push(candle);
      if (this.candles.length > CANDLE_WINDOW) this.candles.shift();
      return true;
    }
    this.candles[idx] = candle;
    return false;
  }

  get(): Candle[]  { return this.candles; }
  size(): number   { return this.candles.length; }
}

// ── TickBuffer ────────────────────────────────────────────────────────────────
class TickBuffer {
  private ticks: Tick[] = [];

  add(tick: Tick): void {
    this.ticks.push(tick);
    if (this.ticks.length > TICK_BUFFER_SIZE) this.ticks.shift();
  }

  addBatch(ticks: Tick[]): void {
    for (const t of ticks) this.add(t);
  }

  get(n?: number): Tick[] {
    return n ? this.ticks.slice(-n) : this.ticks;
  }

  size(): number { return this.ticks.length; }

  stats(): {
    count: number;
    buyVol: number;
    sellVol: number;
    buySellRatio: number | null;
    priceHigh: number | null;
    priceLow: number | null;
    momentumPct: number | null;
    latestPrice: number | null;
  } {
    if (this.ticks.length === 0) {
      return { count: 0, buyVol: 0, sellVol: 0, buySellRatio: null,
               priceHigh: null, priceLow: null, momentumPct: null, latestPrice: null };
    }
    const buys  = this.ticks.filter((t) => t.side === "BUY");
    const sells = this.ticks.filter((t) => t.side === "SELL");
    const buyVol  = buys.reduce((a, t) => a + t.size, 0);
    const sellVol = sells.reduce((a, t) => a + t.size, 0);
    const prices  = this.ticks.map((t) => t.price);
    const latest  = prices[prices.length - 1];
    const first   = prices[0];
    return {
      count:       this.ticks.length,
      buyVol,
      sellVol,
      buySellRatio:  sellVol > 0 ? buyVol / sellVol : null,
      priceHigh:     Math.max(...prices),
      priceLow:      Math.min(...prices),
      momentumPct:   first > 0 ? ((latest - first) / first) * 100 : null,
      latestPrice:   latest,
    };
  }
}

// ── OrderBook ─────────────────────────────────────────────────────────────────
class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private _updatedAt: string = new Date().toISOString();

  applyUpdates(updates: { side: string; price_level: string; new_quantity: string }[]): void {
    for (const u of updates) {
      const price = parseFloat(u.price_level);
      const size  = parseFloat(u.new_quantity);
      const book  = u.side === "bid" ? this.bids : this.asks;
      if (size === 0) book.delete(price);
      else            book.set(price, size);
    }
    this._updatedAt = new Date().toISOString();
  }

  getDepth(midPrice: number, rangePct = 0.005): OrderBookData {
    const lo = midPrice * (1 - rangePct);
    const hi = midPrice * (1 + rangePct);
    let bidWall = 0;
    Array.from(this.bids.entries()).forEach(([p, s]) => { if (p >= lo && p <= midPrice) bidWall += s * p; });
    let askWall = 0;
    Array.from(this.asks.entries()).forEach(([p, s]) => { if (p >= midPrice && p <= hi)  askWall += s * p; });
    const ratio = askWall > 0 ? bidWall / askWall : (bidWall > 0 ? 99 : 1);
    return { bidWall: parseFloat(bidWall.toFixed(2)), askWall: parseFloat(askWall.toFixed(2)),
             ratio: parseFloat(ratio.toFixed(3)), midPrice, updatedAt: this._updatedAt };
  }

  size(): number { return this.bids.size + this.asks.size; }
}

const orderBook = new OrderBook();

// ── Indicators (reference computations — presented to LLM, not rule-based) ───

function calcRSI(closes: number[], period = RSI_PERIOD): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function calcEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

function swingRange(candles: Candle[], lookback = 50) {
  const w = candles.slice(-Math.min(lookback, candles.length));
  return { high: Math.max(...w.map((c) => c.high)), low: Math.min(...w.map((c) => c.low)) };
}

function nearestFibRef(price: number, high: number, low: number) {
  const LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
  const range  = high - low;
  let best: { level: number; price: number; distPct: number } | null = null;
  for (const lvl of LEVELS) {
    const fp  = high - range * lvl;
    const d   = Math.abs(price - fp) / price;
    if (!best || d < best.distPct) best = { level: lvl, price: fp, distPct: d };
  }
  return best && best.distPct <= 0.005 ? best : null;
}

// ── External Data Fetchers ────────────────────────────────────────────────────

async function fetchFearGreed(): Promise<FearGreedData | null> {
  const cached = fearGreedCache.get("fng");
  if (cached) return cached;
  try {
    const res = await fetch(
      "https://api.alternative.me/fng/?limit=3",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`Fear & Greed ${res.status}`);
    const json = await res.json() as {
      data?: { value: string; value_classification: string; timestamp: string }[];
    };
    const rows = json.data ?? [];
    if (rows.length === 0) throw new Error("Empty Fear & Greed response");
    const [latest, ...rest] = rows;
    const data: FearGreedData = {
      value:     parseInt(latest.value),
      label:     latest.value_classification,
      timestamp: latest.timestamp,
      history:   rest.map((r) => ({ value: parseInt(r.value), label: r.value_classification, timestamp: r.timestamp })),
    };
    fearGreedCache.set("fng", data, FEAR_GREED_TTL);
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] Fear & Greed failed:", (err as Error).message);
    return null;
  }
}

async function fetchMarket(): Promise<MarketData | null> {
  const cached = marketCache.get("eth");
  if (cached) return cached;
  try {
    const headers: Record<string, string> = {};
    if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
    const [priceRes, globalRes] = await Promise.allSettled([
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_7d_change=true",
            { headers, signal: AbortSignal.timeout(8_000) }),
      fetch("https://api.coingecko.com/api/v3/global",
            { headers, signal: AbortSignal.timeout(8_000) }),
    ]);
    if (priceRes.status !== "fulfilled" || !priceRes.value.ok)
      throw new Error(`CoinGecko price HTTP ${priceRes.status === "fulfilled" ? priceRes.value.status : "err"}`);
    const pj = await priceRes.value.json() as {
      ethereum: { usd: number; usd_market_cap: number; usd_24h_vol: number; usd_24h_change: number; usd_7d_change?: number };
      bitcoin:  { usd_24h_change: number };
    };
    let totalMcap: number | null = null, ethDom: number | null = null;
    if (globalRes.status === "fulfilled" && globalRes.value.ok) {
      const g = await globalRes.value.json() as { data?: { total_market_cap?: { usd?: number }; market_cap_percentage?: { eth?: number } } };
      totalMcap = g.data?.total_market_cap?.usd ?? null;
      ethDom    = g.data?.market_cap_percentage?.eth ?? null;
    }
    const data: MarketData = {
      ethPriceUsd:       pj.ethereum.usd,
      ethMarketCapUsd:   pj.ethereum.usd_market_cap,
      ethVolume24hUsd:   pj.ethereum.usd_24h_vol,
      ethChange24h:      pj.ethereum.usd_24h_change,
      ethChange7d:       pj.ethereum.usd_7d_change ?? null,
      btcChange24h:      pj.bitcoin?.usd_24h_change ?? null,
      totalMarketCapUsd: totalMcap,
      ethDominancePct:   ethDom,
    };
    marketCache.set("eth", data, MARKET_TTL);
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] CoinGecko failed:", (err as Error).message);
    return null;
  }
}

async function fetchOnchain(): Promise<OnchainData | null> {
  const cached = onchainCache.get("eth");
  if (cached) return cached;
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  try {
    const [gasRes, blockRes] = await Promise.allSettled([
      fetch(
        `https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
      fetch(
        `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${key}`,
        { signal: AbortSignal.timeout(8_000) },
      ),
    ]);
    if (gasRes.status !== "fulfilled" || !gasRes.value.ok) throw new Error(`Etherscan gas HTTP ${gasRes.status}`);
    const gasJson = await gasRes.value.json() as {
      status: string;
      result?: { SafeGasPrice: string; ProposeGasPrice: string; FastGasPrice: string; gasUsedRatio?: string };
    };
    if (gasJson.status !== "1" || !gasJson.result) throw new Error("Etherscan gas bad response");

    let lastBlock: number | null = null;
    if (blockRes.status === "fulfilled" && blockRes.value.ok) {
      const bj = await blockRes.value.json() as { result?: string };
      if (bj.result) lastBlock = parseInt(bj.result, 16);
    }

    const data: OnchainData = {
      safeGasGwei:    parseFloat(gasJson.result.SafeGasPrice),
      proposeGasGwei: parseFloat(gasJson.result.ProposeGasPrice),
      fastGasGwei:    parseFloat(gasJson.result.FastGasPrice),
      gasUsedRatio:   gasJson.result.gasUsedRatio ?? null,
      lastBlock,
    };
    onchainCache.set("eth", data, ONCHAIN_TTL);
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] Etherscan failed:", (err as Error).message);
    return null;
  }
}

// ── Whale Swap Detector — Uniswap V3 via The Graph ───────────────────────────
const WETH_BASE  = "0x4200000000000000000000000000000000000006";
const USDC_BASE  = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const GRAPH_URL  = "https://api.goldsky.com/api/public/project_cl8ylkiw00krx0hvza0qw17vn/subgraphs/uniswap-v3-base/1.0.0/gn";
const WHALE_MIN_USD = 50_000;

async function fetchWhaleSwaps(): Promise<WhaleData | null> {
  const cached = whaleCache.get("whale");
  if (cached) return cached;
  try {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    const query = `{
      swaps(first:50 orderBy:timestamp orderDirection:desc
        where:{timestamp_gte:"${fiveMinAgo}"}) {
        timestamp amountInUSD amountOutUSD
        tokenIn{id} tokenOut{id}
      }
    }`;
    const res = await fetch(GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OptimusMegaPrime/1.0" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Goldsky HTTP ${res.status}`);
    const json = await res.json() as { data?: { swaps?: {
      timestamp: string; amountInUSD: string; amountOutUSD: string;
      tokenIn: { id: string }; tokenOut: { id: string };
    }[] }; errors?: unknown };
    if (json.errors) throw new Error("Goldsky errors: " + JSON.stringify(json.errors));
    const swaps = json.data?.swaps ?? [];

    // Filter for ETH/USDC pairs only and above threshold
    const ethSwaps = swaps.filter((s) => {
      const ti = s.tokenIn.id.toLowerCase();
      const to = s.tokenOut.id.toLowerCase();
      const hasEth  = ti === WETH_BASE  || to === WETH_BASE;
      const hasUsdc = ti === USDC_BASE  || to === USDC_BASE;
      const amt = Math.max(parseFloat(s.amountInUSD), parseFloat(s.amountOutUSD));
      return hasEth && hasUsdc && amt >= WHALE_MIN_USD;
    });

    const recentSwaps: WhaleData["recentSwaps"] = [];
    let buyUsd = 0, sellUsd = 0, buyCount = 0, sellCount = 0;

    for (const s of ethSwaps) {
      const amt = Math.max(parseFloat(s.amountInUSD), parseFloat(s.amountOutUSD));
      // tokenIn = USDC → buying ETH (BUY). tokenIn = WETH → selling ETH (SELL).
      const dir: "BUY" | "SELL" = s.tokenIn.id.toLowerCase() === USDC_BASE ? "BUY" : "SELL";
      if (dir === "BUY") { buyUsd += amt; buyCount++; }
      else               { sellUsd += amt; sellCount++; }
      recentSwaps.push({ direction: dir, amountUsd: parseFloat(amt.toFixed(0)), timestamp: parseInt(s.timestamp) });
    }

    const netDirection: WhaleData["direction"] =
      buyUsd > sellUsd * 1.5 ? "BUY" :
      sellUsd > buyUsd * 1.5 ? "SELL" : "NONE";

    const data: WhaleData = {
      direction: netDirection,
      amountUsd: parseFloat((buyUsd + sellUsd).toFixed(0)),
      count: ethSwaps.length,
      buyCount, sellCount,
      recentSwaps: recentSwaps.slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
    whaleCache.set("whale", data, WHALE_TTL);
    console.log(`[AnalystClaw] Whale: ${data.count} swaps >$${WHALE_MIN_USD/1000}k  dir=${data.direction}  $${(data.amountUsd/1000).toFixed(0)}k total`);
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] Whale fetch failed:", (err as Error).message);
    return null;
  }
}

// ── Etherscan Large Transaction Monitor ───────────────────────────────────────
async function fetchLargeTransactions(): Promise<LargeTxData | null> {
  const cached = largeTxCache.get("largetx");
  if (cached) return cached;
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  try {
    // Check last 50 txs to Uniswap SwapRouter on L1 (chainid=1 — free tier works)
    const router = UNISWAP_ROUTERS[0];
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist` +
      `&address=${router}&sort=desc&page=1&offset=50&apikey=${key}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`Etherscan txlist HTTP ${res.status}`);
    const json = await res.json() as {
      status: string;
      result?: { value: string; to: string; from: string; timeStamp: string }[];
    };
    if (json.status !== "1" || !Array.isArray(json.result)) throw new Error("Etherscan txlist bad response");

    const cutoff = Math.floor(Date.now() / 1000) - 120; // last 2 min
    const recent = json.result.filter((tx) => parseInt(tx.timeStamp) >= cutoff);
    const FIFTY_ETH = BigInt("50000000000000000000"); // 50 ETH in wei

    let inflow = 0, outflow = 0, count = 0;
    for (const tx of recent) {
      const val = BigInt(tx.value || "0");
      if (val < FIFTY_ETH) continue;
      count++;
      const ethVal = Number(val) / 1e18;
      const toAddr = tx.to.toLowerCase();
      if (UNISWAP_ROUTERS.includes(toAddr)) inflow  += ethVal;
      else                                   outflow += ethVal;
    }

    const data: LargeTxData = {
      inflow:  parseFloat(inflow.toFixed(2)),
      outflow: parseFloat(outflow.toFixed(2)),
      count,
      fetchedAt: new Date().toISOString(),
    };
    largeTxCache.set("largetx", data, LARGE_TX_TTL);
    if (count > 0) console.log(`[AnalystClaw] LargeTx: ${count} txs  in=${inflow.toFixed(1)} ETH  out=${outflow.toFixed(1)} ETH`);
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] LargeTx fetch failed:", (err as Error).message);
    return null;
  }
}

// ── Nansen Smart Money ────────────────────────────────────────────────────────
// Fetches labeled smart money DEX trades from Ethereum mainnet.
// ETH buys = token_bought_symbol "ETH"; ETH sells = token_sold_symbol "ETH".
// Returns 1h window of trades (default window from API, no time filter needed).
async function fetchNansenSmartMoney(): Promise<NansenSmartMoneyData | null> {
  const cached = nansenCache.get("nansen");
  if (cached) return cached;
  const apiKey = process.env.NANSEN_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${NANSEN_URL}/api/v1/smart-money/dex-trades`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apiKey": apiKey,
        "User-Agent": "OptimusMegaPrime/1.0",
      },
      body: JSON.stringify({
        chains: ["ethereum"],
        pagination: { limit: 500 },
      }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[AnalystClaw] Nansen dex-trades HTTP ${res.status}`);
      return null;
    }

    const json = await res.json() as {
      data?: {
        block_timestamp: string;
        trader_address_label: string;
        token_bought_symbol: string;
        token_sold_symbol: string;
        trade_value_usd: number;
      }[];
    };

    let labeledBuyUsd = 0, labeledSellUsd = 0, labeledBuyCount = 0, labeledSellCount = 0;

    for (const t of json.data ?? []) {
      const usd = t.trade_value_usd ?? 0;
      if (t.token_bought_symbol === "ETH") {
        // Smart money bought ETH (spent another token to get ETH)
        labeledBuyUsd += usd;
        labeledBuyCount++;
      } else if (t.token_sold_symbol === "ETH") {
        // Smart money sold ETH (spent ETH to get another token)
        labeledSellUsd += usd;
        labeledSellCount++;
      }
    }

    let direction: NansenSmartMoneyData["direction"] = "NEUTRAL";
    if (labeledBuyUsd > labeledSellUsd * 1.5)  direction = "BUY";
    else if (labeledSellUsd > labeledBuyUsd * 1.5) direction = "SELL";

    const data: NansenSmartMoneyData = {
      netflow1hUsd:    labeledBuyUsd - labeledSellUsd,
      netflow24hUsd:   null,
      labeledBuyUsd:   parseFloat(labeledBuyUsd.toFixed(0)),
      labeledSellUsd:  parseFloat(labeledSellUsd.toFixed(0)),
      labeledBuyCount, labeledSellCount,
      direction,
      fetchedAt: new Date().toISOString(),
    };

    nansenCache.set("nansen", data, NANSEN_TTL);
    console.log(
      `[AnalystClaw] Nansen: dir=${direction}  ` +
      `buys=${labeledBuyCount}($${(labeledBuyUsd/1000).toFixed(1)}k) ` +
      `sells=${labeledSellCount}($${(labeledSellUsd/1000).toFixed(1)}k)`,
    );
    return data;
  } catch (err) {
    console.warn("[AnalystClaw] Nansen fetch failed:", (err as Error).message);
    return null;
  }
}

// ── Algorithmic Signal Engine ─────────────────────────────────────────────────

function computeSignalAlgorithmic(opts: {
  rsi: number;
  ema9: number; ema21: number; ema50: number;
  price: number;
  volumeRatio: number;
  swingHigh: number; swingLow: number;
  nearestFibLevel: number | null;
  tickStats: ReturnType<TickBuffer["stats"]>;
  fearGreed: FearGreedData | null;
  whale: WhaleData | null;
  obDepth: OrderBookData | null;
  largeTx: LargeTxData | null;
  nansen: NansenSmartMoneyData | null;
}): { signal: "BUY" | "SELL" | "HOLD"; strength: "STRONG" | "MODERATE" | "WEAK"; reason: string } {
  const { rsi, ema9, ema21, ema50, price, volumeRatio,
          nearestFibLevel, tickStats, fearGreed, whale, obDepth, largeTx, nansen } = opts;

  let buy  = 0;
  let sell = 0;
  const tags: string[] = [];

  // ── RSI ─────────────────────────────────────────────────────────────────────
  if      (rsi < strategyParams.rsiOversoldThreshold)       { buy  += 2; tags.push(`RSI ${rsi.toFixed(1)} oversold`); }
  else if (rsi < strategyParams.rsiOversoldThreshold + 10)  { buy  += 1; }
  else if (rsi > strategyParams.rsiOverboughtThreshold)     { sell += 2; tags.push(`RSI ${rsi.toFixed(1)} overbought`); }
  else if (rsi > strategyParams.rsiOverboughtThreshold - 10){ sell += 1; }

  // ── EMA trend alignment ──────────────────────────────────────────────────────
  if      (ema9 > ema21 && ema21 > ema50) { buy  += 1; tags.push("EMA bullish"); }
  else if (ema9 < ema21 && ema21 < ema50) { sell += 1; tags.push("EMA bearish"); }
  if      (price > ema9 && ema9 > ema21)  { buy  += 1; }
  else if (price < ema9 && ema9 < ema21)  { sell += 1; }

  // ── Fibonacci confluence (nearestFibRef already ensures proximity) ───────────
  if (nearestFibLevel !== null) {
    const isSupport = nearestFibLevel >= 0.382 && nearestFibLevel <= 0.786;
    if (isSupport && price < ema21) {
      buy += 2;
      tags.push(`Fib ${(nearestFibLevel * 100).toFixed(1)}% support`);
    } else if (!isSupport) {
      sell += 1;
      tags.push(`Fib ${(nearestFibLevel * 100).toFixed(1)}% resistance`);
    }
  }

  // ── Volume surge ─────────────────────────────────────────────────────────────
  if (volumeRatio > 2.0 * strategyParams.volumeMultiplier) {
    if      (buy  > sell) { buy  += 1; tags.push(`Vol ${volumeRatio.toFixed(1)}x`); }
    else if (sell > buy)  { sell += 1; tags.push(`Vol ${volumeRatio.toFixed(1)}x`); }
  }

  // ── Tick microstructure ──────────────────────────────────────────────────────
  if (tickStats.count >= 20) {
    const bsr = tickStats.buySellRatio;
    if      (bsr !== null && bsr > 1.4) { buy  += 1; tags.push(`B/S ${bsr.toFixed(2)}x buy`); }
    else if (bsr !== null && bsr < 0.6) { sell += 1; tags.push(`B/S ${bsr.toFixed(2)}x sell`); }
    const mom = tickStats.momentumPct;
    if      (mom !== null && mom >  0.06) buy  += 1;
    else if (mom !== null && mom < -0.06) sell += 1;
  }

  // ── Fear & Greed (contrarian) ────────────────────────────────────────────────
  if (fearGreed) {
    if      (fearGreed.value <= 15) { buy  += 1; tags.push(`Extreme Fear ${fearGreed.value}`); }
    else if (fearGreed.value >= 85) { sell += 1; tags.push(`Extreme Greed ${fearGreed.value}`); }
  }

  // ── Whale swap activity (Uniswap V3 via The Graph) ───────────────────────────
  if (whale && whale.count > 0) {
    if      (whale.direction === "BUY")  { buy  += 2; tags.push(`Whale BUY $${(whale.amountUsd/1000).toFixed(0)}k`); }
    else if (whale.direction === "SELL") { sell += 2; tags.push(`Whale SELL $${(whale.amountUsd/1000).toFixed(0)}k`); }
  }

  // ── Order book depth (Level2 bid/ask walls) ──────────────────────────────────
  if (obDepth && obDepth.bidWall > 0 && obDepth.askWall > 0) {
    if      (obDepth.ratio >= 3.0) { buy  += 1; tags.push(`Bid wall ${obDepth.ratio.toFixed(1)}x`); }
    else if (obDepth.ratio <= 0.33) { sell += 1; tags.push(`Ask wall ${(1/obDepth.ratio).toFixed(1)}x`); }
  }

  // ── Large L1 transactions to Uniswap ────────────────────────────────────────
  if (largeTx && largeTx.count > 0) {
    // inflow = ETH flowing INTO Uniswap (being swapped/sold) → SELL pressure
    // outflow = ETH flowing OUT of Uniswap (being withdrawn) → BUY pressure
    if      (largeTx.inflow  > 50) { sell += 1; tags.push(`L1 ${largeTx.inflow.toFixed(0)} ETH→Uni`); }
    else if (largeTx.outflow > 50) { buy  += 1; tags.push(`L1 ${largeTx.outflow.toFixed(0)} ETH←Uni`); }
  }

  // ── Nansen smart money (labeled wallets buying/selling ETH on-chain) ──────────
  // Trades where token_bought_symbol="ETH" = smart money accumulating ETH (bullish)
  // Trades where token_sold_symbol="ETH"   = smart money spending ETH    (bearish)
  if (nansen && (nansen.labeledBuyCount + nansen.labeledSellCount) >= 2) {
    const totalUsd = nansen.labeledBuyUsd + nansen.labeledSellUsd;
    if (nansen.direction === "BUY") {
      buy += 2;
      tags.push(`Nansen SM ETH buy $${(nansen.labeledBuyUsd/1000).toFixed(0)}k/${nansen.labeledBuyCount}tx`);
      // Extra point when dominant and meaningful volume
      if (totalUsd >= 10_000 && nansen.labeledBuyUsd > nansen.labeledSellUsd * 2.5) {
        buy += 1; tags.push("SM conviction");
      }
    } else if (nansen.direction === "SELL") {
      sell += 2;
      tags.push(`Nansen SM ETH sell $${(nansen.labeledSellUsd/1000).toFixed(0)}k/${nansen.labeledSellCount}tx`);
      if (totalUsd >= 10_000 && nansen.labeledSellUsd > nansen.labeledBuyUsd * 2.5) {
        sell += 1; tags.push("SM conviction");
      }
    }
  }

  // ── Score → Signal ───────────────────────────────────────────────────────────
  const net = buy - sell;
  let signal: "BUY" | "SELL" | "HOLD";
  let strength: "STRONG" | "MODERATE" | "WEAK";

  if      (net >=  4) { signal = "BUY";  strength = "STRONG";   }
  else if (net >=  2) { signal = "BUY";  strength = "MODERATE"; }
  else if (net >=  1) { signal = "BUY";  strength = "WEAK";     }
  else if (net <= -4) { signal = "SELL"; strength = "STRONG";   }
  else if (net <= -2) { signal = "SELL"; strength = "MODERATE"; }
  else if (net <= -1) { signal = "SELL"; strength = "WEAK";     }
  else                { signal = "HOLD"; strength = "WEAK";     }

  const reason = tags.length
    ? `${signal} net=${net}: ${tags.join(", ")}. RSI ${rsi.toFixed(1)} EMA9 $${ema9.toFixed(0)}`
    : `HOLD net=0. RSI ${rsi.toFixed(1)}, EMA9 $${ema9.toFixed(0)}, Vol ${volumeRatio.toFixed(2)}x`;

  return { signal, strength, reason };
}

// ── Analysis Runner ───────────────────────────────────────────────────────────
let analysisInProgress = false;
let analysisStartedAt  = 0; // epoch ms — non-zero when a run is in progress

async function analyse(candleWindow: CandleWindow, tickBuffer: TickBuffer, triggerCandle: Candle): Promise<void> {
  if (analysisInProgress) return;
  analysisInProgress = true;
  analysisStartedAt  = Date.now();
  const t0 = analysisStartedAt;

  try {
    const candles = candleWindow.get();
    if (candles.length < RSI_PERIOD + 2) {
      console.log(`[AnalystClaw] Window too small (${candles.length}), skipping…`);
      return;
    }

    const closes      = candles.map((c) => c.close);
    const volumes     = candles.map((c) => c.volume);
    const price       = closes[closes.length - 1];
    const rsi         = calcRSI(closes);
    const ema9        = calcEMA(closes, EMA_FAST);
    const ema21       = calcEMA(closes, EMA_MID);
    const ema50       = calcEMA(closes, EMA_SLOW);
    const { high: swingHigh, low: swingLow } = swingRange(candles);
    const volSlice    = volumes.slice(-VOL_LOOKBACK);
    const avgVol      = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
    const volumeRatio = candles[candles.length - 1].volume / (avgVol || 1);
    const fibRef      = nearestFibRef(price, swingHigh, swingLow);
    const ts          = tickBuffer.stats();

    // Fetch all external data in parallel
    const [fearGreed, market, onchain, whale, largeTx, nansen] = await Promise.all([
      fetchFearGreed(), fetchMarket(), fetchOnchain(), fetchWhaleSwaps(), fetchLargeTransactions(),
      fetchNansenSmartMoney(),
    ]);
    const obDepth = orderBook.size() > 0 ? orderBook.getDepth(price) : null;

    const dataSourcesActive: string[] = ["coinbase-candles"];
    if (ts.count > 0)      dataSourcesActive.push("coinbase-trades");
    if (fearGreed)         dataSourcesActive.push("fear-greed");
    if (market)            dataSourcesActive.push("coingecko");
    if (onchain)           dataSourcesActive.push("etherscan");
    if (whale)             dataSourcesActive.push("uniswap-graph");
    if (obDepth)           dataSourcesActive.push("orderbook-l2");
    if (largeTx?.count)    dataSourcesActive.push("etherscan-largetx");
    if (nansen)            dataSourcesActive.push("nansen-smart-money");

    const { signal, strength, reason } = computeSignalAlgorithmic({
      rsi, ema9, ema21, ema50, price, volumeRatio,
      swingHigh, swingLow,
      nearestFibLevel: fibRef?.level ?? null,
      tickStats: ts,
      fearGreed, whale, obDepth, largeTx, nansen,
    });
    const llmAnalysis = false;

    const analysisMs = Date.now() - t0;
    const now        = new Date().toISOString();

    const state: SignalState = {
      timestamp:        now,
      product:          PRODUCT_ID,
      candleStart:      new Date(triggerCandle.start * 1000).toISOString(),
      granularity:      GRANULARITY,
      price:            parseFloat(price.toFixed(4)),
      signal,
      strength,
      rsi:              parseFloat(rsi.toFixed(2)),
      ema9:             parseFloat(ema9.toFixed(2)),
      ema21:            parseFloat(ema21.toFixed(2)),
      ema50:            parseFloat(ema50.toFixed(2)),
      nearestFibLevel:  fibRef ? fibRef.level : null,
      nearestFibPrice:  fibRef ? parseFloat(fibRef.price.toFixed(4)) : null,
      volumeRatio:      parseFloat(volumeRatio.toFixed(4)),
      swingHigh:        parseFloat(swingHigh.toFixed(4)),
      swingLow:         parseFloat(swingLow.toFixed(4)),
      windowSize:       candles.length,
      tickCount:        ts.count,
      tickBuySellRatio: ts.buySellRatio !== null ? parseFloat(ts.buySellRatio.toFixed(3)) : null,
      tickMomentumPct:  ts.momentumPct  !== null ? parseFloat(ts.momentumPct.toFixed(3))  : null,
      latestTickPrice:  ts.latestPrice  !== null ? parseFloat(ts.latestPrice.toFixed(2))  : null,
      reason,
      llmAnalysis,
      analysisMs,
      fearGreedValue:   fearGreed ? fearGreed.value : null,
      fearGreedLabel:   fearGreed ? fearGreed.label : null,
      marketChange24h:  market  ? parseFloat(market.ethChange24h.toFixed(2)) : null,
      gasGwei:          onchain ? onchain.fastGasGwei   : null,
      dataSourcesActive,
      whaleActivity:     whale   ?? null,
      orderBook:         obDepth ?? null,
      largeTransactions: largeTx ?? null,
      nansenSmartMoney:  nansen  ?? null,
    };

    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // Journal STRONG signals to Obsidian vault
    if (strength === "STRONG" && (signal === "BUY" || signal === "SELL")) {
      try {
        appendToNote("", "System-Journal.md",
          `\n## ${new Date().toISOString().substring(0, 19).replace("T", " ")} UTC — ${signal} STRONG\n\n` +
          `**Price**: $${price.toFixed(2)}  **RSI**: ${rsi.toFixed(1)}  ` +
          `**EMA9/21/50**: $${ema9.toFixed(0)}/$${ema21.toFixed(0)}/$${ema50.toFixed(0)}\n\n` +
          `**Reason**: ${reason}\n`,
        );
      } catch { /* non-fatal */ }
    }

    const sc    = signal === "BUY" ? "\x1b[32m" : signal === "SELL" ? "\x1b[31m" : "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      `[${now}] ${sc}${signal} (${strength})${reset} [algo ${analysisMs}ms]  ` +
      `$${price.toFixed(2)}  RSI=${rsi.toFixed(1)}  EMA9=${ema9.toFixed(2)}  ` +
      `ticks=${ts.count}  B/S=${ts.buySellRatio?.toFixed(2) ?? "—"}  ` +
      `srcs=[${dataSourcesActive.join(",")}]  | ${reason}`,
    );
  } finally {
    analysisInProgress = false;
    analysisStartedAt  = 0;
  }
}

// ── REST Seed ─────────────────────────────────────────────────────────────────
async function seedFromREST(): Promise<Candle[]> {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - SEED_CANDLES * 60;
  const url   = `${REST_URL}/${PRODUCT_ID}/candles?start=${start}&end=${end}&granularity=${GRANULARITY}&limit=${SEED_CANDLES}`;
  // AbortSignal.timeout required — without it a stalled TCP connection hangs the entire process forever
  const res   = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`REST seed failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as {
    candles: { start: string; open: string; high: string; low: string; close: string; volume: string }[];
  };
  return json.candles.map((c) => ({
    start: parseInt(c.start), open: parseFloat(c.open), high: parseFloat(c.high),
    low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume),
  }));
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket(candleWindow: CandleWindow, tickBuffer: TickBuffer): WebSocket {
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[AnalystClaw] WebSocket connected → subscribing to candles + market_trades + l2_data…");
    ws.send(JSON.stringify({ type: "subscribe", product_ids: [PRODUCT_ID], channel: "candles" }));
    ws.send(JSON.stringify({ type: "subscribe", product_ids: [PRODUCT_ID], channel: "market_trades" }));
    ws.send(JSON.stringify({ type: "subscribe", product_ids: [PRODUCT_ID], channel: "level2" }));
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }

    // ── Candle events → trigger analysis on new close ──────────────────────
    if (msg.channel === "candles") {
      for (const event of (msg.events as { candles?: unknown[] }[] | undefined) ?? []) {
        for (const rc of (event.candles ?? []) as {
          start: string; open: string; high: string; low: string; close: string; volume: string
        }[]) {
          const candle: Candle = {
            start: parseInt(rc.start), open: parseFloat(rc.open), high: parseFloat(rc.high),
            low: parseFloat(rc.low), close: parseFloat(rc.close), volume: parseFloat(rc.volume),
          };
          const isNewClose = candleWindow.upsert(candle);
          if (isNewClose) {
            analyse(candleWindow, tickBuffer, candle).catch((err) =>
              console.error("[AnalystClaw] analyse error:", (err as Error).message),
            );
          }
        }
      }
      return;
    }

    // ── Level2 order book ─────────────────────────────────────────────────
    if (msg.channel === "l2_data") {
      for (const event of (msg.events as { type?: string; updates?: unknown[] }[] | undefined) ?? []) {
        const updates = (event.updates ?? []) as { side: string; price_level: string; new_quantity: string }[];
        if (updates.length) orderBook.applyUpdates(updates);
      }
      return;
    }

    // ── Trade events → accumulate ticks ───────────────────────────────────
    if (msg.channel === "market_trades") {
      for (const event of (msg.events as { type?: string; trades?: unknown[] }[] | undefined) ?? []) {
        const trades = (event.trades ?? []) as {
          price: string; size: string; side: string; time: string
        }[];
        const parsed: Tick[] = trades
          .filter((t) => t.side === "BUY" || t.side === "SELL")
          .map((t) => ({
            price: parseFloat(t.price),
            size:  parseFloat(t.size),
            side:  t.side as "BUY" | "SELL",
            time:  t.time,
          }));
        tickBuffer.addBatch(parsed);
      }
      return;
    }
  });

  ws.on("error", (err) => console.error("[AnalystClaw] WebSocket error:", err.message));

  ws.on("close", (code, reason) => {
    console.warn(`[AnalystClaw] WebSocket closed (${code} ${reason}). Reconnecting in ${RECONNECT_MS / 1000}s…`);
    setTimeout(() => connectWebSocket(candleWindow, tickBuffer), RECONNECT_MS);
  });

  return ws;
}

// ── Entry Point ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  initVault();
  console.log(`\n[AnalystClaw] Starting high-frequency mode for ${PRODUCT_ID}`);
  console.log(`  Granularity : ${GRANULARITY}  (${CANDLE_WINDOW}-bar window)`);
  console.log(`  Tick buffer : ${TICK_BUFFER_SIZE} trades`);
  console.log(`  State file  : ${STATE_FILE}`);
  console.log(`  Signal mode : algorithmic (RSI, EMA, Fibonacci, volume, ticks, sentiment)`);
  console.log(`  Sentiment   : Fear & Greed Index (alternative.me — no key required)`);
  console.log(`  Market      : CoinGecko ${process.env.COINGECKO_API_KEY ? "(authenticated)" : "(unauthenticated)"}`);
  console.log(`  Onchain     : ${process.env.ETHERSCAN_API_KEY ? "Etherscan V2 ✓" : "disabled (no ETHERSCAN_API_KEY)"}`);
  console.log(`  Nansen      : ${process.env.NANSEN_API_KEY ? "Smart Money ✓ (5-min TTL)" : "disabled (no NANSEN_API_KEY)"}\n`);

  const candleWindow = new CandleWindow();
  const tickBuffer   = new TickBuffer();

  // Seed with retry — without a timeout on the fetch the process can hang forever
  console.log("[AnalystClaw] Seeding candle window from REST API…");
  let seeded = false;
  for (let attempt = 1; attempt <= 3 && !seeded; attempt++) {
    try {
      const seedCandles = await seedFromREST();
      candleWindow.seed(seedCandles);
      console.log(`[AnalystClaw] Window seeded with ${candleWindow.size()} candles (attempt ${attempt}).`);
      seeded = true;
    } catch (err) {
      console.warn(`[AnalystClaw] Seed attempt ${attempt} failed: ${(err as Error).message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  if (!seeded) throw new Error("Failed to seed candle window after 3 attempts — cannot start.");

  const seedCandle = candleWindow.get().at(-1)!;
  await analyse(candleWindow, tickBuffer, seedCandle);

  connectWebSocket(candleWindow, tickBuffer);

  // Heartbeat: log every 60s so a silent freeze is immediately visible in logs
  setInterval(() => {
    const stateAge = fs.existsSync(STATE_FILE)
      ? Math.round((Date.now() - fs.statSync(STATE_FILE).mtimeMs) / 1000)
      : -1;
    const lockAge = analysisInProgress && analysisStartedAt > 0
      ? Math.round((Date.now() - analysisStartedAt) / 1000)
      : 0;
    if (lockAge > 120) {
      // analysisInProgress stuck for >2min — reset the lock so new candles can fire
      console.error(`[AnalystClaw] ⚠ analysisInProgress stuck for ${lockAge}s — force-resetting lock`);
      analysisInProgress = false;
      analysisStartedAt  = 0;
    }
    console.log(`[AnalystClaw] ♥ heartbeat  state_age=${stateAge}s  lock=${analysisInProgress}(${lockAge}s)  ticks=${tickBuffer.size()}  candles=${candleWindow.size()}`);
  }, 60_000);
}

main().catch((err) => {
  console.error("[AnalystClaw] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
