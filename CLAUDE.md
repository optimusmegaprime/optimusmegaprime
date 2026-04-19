# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

**OptimusMegaPrime** is an autonomous ETH/USDC swing trading system built on Coinbase AgentKit. The strategy is Fibonacci retracement-based: buy at key support levels (38.2%, 50%, 61.8%) confirmed by RSI and volume, sell at resistance. Running on **Base mainnet** with CDP Smart Wallet `0x29Efb582AD001088671684F357F5719b2bABBB52` and Paymaster-sponsored gas.

---

## Agent Architecture & LLM Routing

Four standalone agents communicate exclusively through JSON files in `shared/`.

```
StrategyCannon (claude-opus-4-6, every 24h)
  ↓ shared/strategy-params.json + Obsidian vault
AnalystClaw (algorithmic) → shared/analyst-state.json → TradeClaw
  RSI, EMA, Fibonacci,                                   Gate 5: claude -p (Max sub)
  volume, tick stats,                                           ↓
  Fear & Greed (scored)                              shared/trade-state.json
                                                               ↓
                                                           RiskClaw
                                                     every 60s: claude -p
                                                               ↓
                                                      shared/risk-state.json
                                                       (HALT flag → TradeClaw)
```

| Agent | Script | LLM | Invocation |
|---|---|---|---|
| StrategyCannon | `scripts/strategy-cannon.ts` | `claude-opus-4-6` subprocess | Daily at 00:00 UTC (or `npm run cannon`) |
| AnalystClaw | `scripts/analyst-claw.ts` | **None** — algorithmic | RSI/EMA/Fib scoring, runs every 1-min candle |
| TradeClaw | `scripts/trade-claw.ts` | `claude -p` subprocess | Once per trade at Gate 5 (EXECUTE/SKIP decision) |
| RiskClaw | `scripts/risk-claw.ts` | `claude -p` subprocess | Every 60s (HALT + narrative assessment) |

**LLM routing via `claude -p`**: TradeClaw, RiskClaw, and StrategyCannon spawn the Claude Code CLI as a subprocess (`spawnSync`/`spawn` from `child_process`). This routes all LLM calls through the user's Claude Max subscription rather than burning Anthropic API tokens. No `ANTHROPIC_API_KEY` is needed by these scripts.

**Arithmetic safety net**: RiskClaw's hard limits (drawdown > 40%, position > 25%) are evaluated synchronously before the Claude subprocess call. These cannot be overridden by Claude — Claude can only *add* a HALT, never remove one set by arithmetic.

---

## Commands

```bash
npm run dev          # Start Next.js frontend + AgentKit chat UI (localhost:3000)
npm run analyst      # AnalystClaw — continuous WebSocket signal engine
npm run trade        # TradeClaw — trade executor (reads analyst + risk state)
npm run risk         # RiskClaw — portfolio risk monitor (writes HALT flag)
npm run cannon       # StrategyCannon — one-shot strategic assessment + exit
npm run cannon:daemon # StrategyCannon — run immediately + schedule daily at 00:00 UTC
npm run mint-usdc    # One-shot: request 1000 testnet USDC from CDP faucet
npm run debug        # System snapshot: agent status, balances, last signal, issues
npm run withdraw     # Withdraw USDC profit to WITHDRAWAL_ADDRESS (keeps WITHDRAWAL_KEEP_USD)
npm run withdraw:dry # Dry-run: show amounts without sending
npm run withdraw:all # Sweep entire USDC balance to WITHDRAWAL_ADDRESS
npm run build        # Production Next.js build
npm run lint         # ESLint
npx tsx scripts/<file>.ts   # Run any script directly
```

Run all three agents together (typical dev workflow):
```bash
npm run risk &   # Start risk monitor first
npm run analyst & npm run trade
```

No test suite exists yet.

---

## Shared State File Schemas

### `shared/analyst-state.json` — written by AnalystClaw, read by TradeClaw + RiskClaw
```json
{
  "timestamp": "ISO (analysis time)",
  "product": "ETH-USDC",
  "candleStart": "ISO (1-min candle that triggered this)",
  "granularity": "ONE_MINUTE",
  "price": 2359.20,
  "signal": "BUY | SELL | HOLD",
  "strength": "STRONG | MODERATE | WEAK",
  "rsi": 27.97,
  "ema9": 2362.10,
  "ema21": 2358.40,
  "ema50": 2351.80,
  "nearestFibLevel": 1.0,
  "nearestFibPrice": 2355.0,
  "volumeRatio": 0.186,
  "swingHigh": 2428.51,
  "swingLow": 2355.0,
  "windowSize": 200,
  "tickCount": 147,
  "tickBuySellRatio": 1.23,
  "tickMomentumPct": -0.042,
  "latestTickPrice": 2359.15,
  "reason": "Strong buy-side tick pressure (1.23x) despite bearish 24h. RSI 28 + swing low confluence. Gas 12 gwei low — favorable entry.",
  "llmAnalysis": true,
  "analysisMs": 1847,
  "fearGreedValue": 26,
  "fearGreedLabel": "Fear",
  "marketChange24h": -3.21,
  "gasGwei": 12,
  "dataSourcesActive": ["coinbase-candles", "coinbase-trades", "fear-greed", "coingecko", "etherscan"]
}
```
`llmAnalysis: false` + `reason: "LLM unavailable — holding"` means the LLM failed and no trade signal was generated (safe default).

### `shared/trade-state.json` — written by TradeClaw, read by RiskClaw
```json
{
  "timestamp": "ISO",
  "model": "claude-opus-4-6",
  "status": "IDLE | EXECUTING",
  "walletAddress": "0x...",
  "ethBalance": "0.500000",
  "usdcBalance": "800.00",
  "lastTrade": {
    "timestamp": "ISO",
    "action": "BUY | SELL",
    "fromAmount": "80.00",
    "fromTokenName": "USDC",
    "toAmount": "0.033",
    "toTokenName": "ETH",
    "txHash": "0x...",
    "network": "base-mainnet",
    "signalStrength": "MODERATE",
    "signalPrice": 2400.0,
    "candleStart": "ISO"
  },
  "lastSignalSeen": { "signal": "BUY", "strength": "MODERATE", "action": "EXECUTED" },
  "executedCount": 3,
  "skippedCount": 12
}
```

### `shared/risk-state.json` — written by RiskClaw, read by TradeClaw (Gate 0)
```json
{
  "timestamp": "ISO",
  "model": "claude-haiku-4-5-20251001",
  "halted": false,
  "haltReason": null,
  "portfolioValueUsd": 1042.50,
  "peakPortfolioValueUsd": 1050.00,
  "drawdown": 0.0071,
  "drawdownPct": "0.71%",
  "ethBalance": "0.500000",
  "usdcBalance": "800.00",
  "ethPriceUsd": 2485.0,
  "pendingSignal": "BUY",
  "pendingStrength": "MODERATE",
  "pendingPositionSizePct": 0.0768,
  "checks": {
    "drawdown":    { "ok": true, "value": 0.0071, "limit": 0.20 },
    "positionSize":{ "ok": true, "value": 0.0768, "limit": 0.25 }
  },
  "tradeCount": 3
}
```

---

## Agent Details

### StrategyCannon — `scripts/strategy-cannon.ts`

**Cadence:** Once daily at 00:00 UTC (daemon mode) or on-demand (`npm run cannon`)

**Purpose:** Meta-strategic mission control. Reads all vault notes and shared state, queries **claude-opus-4-6** for deep 3-horizon analysis, updates `shared/strategy-params.json` that AnalystClaw and TradeClaw consume.

**Outputs:**
- `shared/cannon-state.json` — alignment status (ALIGNED/DRIFTING/MISALIGNED), performance score, 3-horizon analyses, strategic directives, metrics snapshot, 30d/90d projections
- `shared/strategy-params.json` — tuned parameters: `rsiOversoldThreshold`, `rsiOverboughtThreshold`, `volumeMultiplier`, `minSignalStrength`, `positionSizeMultiplier`, `marketRegime`, `timeHorizonBias`, `fibProximityThreshold`
- Obsidian vault: `Projections/YYYY-MM-DD-30day.md`, `Projections/YYYY-MM-DD-90day.md`, daily note, `Alignment-Log.md` entry

**Parameter safety:** All numeric param changes clamped to ±20% per run. Absolute bounds enforced per field (e.g. RSI thresholds 15–85). String enum fields validated against allowed values. If Claude fails, DRIFTING state written and current params kept unchanged.

**Mission statement:** "OptimusMegaPrime is a balanced growth autonomous trading system designed for steady returns with controlled risk. Primary purpose is consistent compound growth while respecting defined risk boundaries. Maximum acceptable drawdown is 30%."

**Dashboard integration:** StrategyCannon has a full-width dropdown in the dashboard (click the `⬡ STRATEGYCANNON` button in the topbar). The dropdown exposes 8 sections: Mission Overview (score gauge + alignment), Performance Charts (6 Lightweight Charts mini-charts for equity curve, drawdown, monthly returns, win rate trend, P-day ratio, Sharpe trend), Three Horizon Outlooks, Market Regime, Active Parameters (with deltas from defaults), Strategic Directives, 24HR Blog (reads `Daily/YYYY-MM-DD.md` from Obsidian vault, rendered markdown, date navigation), and Projections (30d/90d).

**New API routes served by `scripts/dashboard-server.js`:**
- `GET /api/cannon-state` — `shared/cannon-state.json`
- `GET /api/strategy-params` — `shared/strategy-params.json`
- `GET /api/obsidian-daily?date=YYYY-MM-DD` — reads `$OBSIDIAN_VAULT_PATH/Daily/YYYY-MM-DD.md`
- `GET /api/obsidian-dates` — lists all available `Daily/*.md` dates from vault

### AnalystClaw — `scripts/analyst-claw.ts`

**Timeframe:** `ONE_MINUTE` candles + live `market_trades` tick stream

**Three simultaneous Coinbase WebSocket subscriptions:**
- `candles` channel → 1-min OHLCV closes; every new close triggers an analysis run
- `market_trades` channel → tick-by-tick trades; buffered into a 200-trade `TickBuffer`
- `level2` channel → live order book updates; maintained in `OrderBook` class (bid/ask Maps), used to compute ±0.5% depth walls

**On each new 1-min candle close:**
1. `analysisInProgress` lock prevents concurrent analyses
2. Eight data sources fetched in parallel (TTL-cached):
   - **Coinbase candles** — 200-bar OHLCV rolling window
   - **Coinbase trades** — 200-trade tick buffer (accumulated continuously)
   - **Fear & Greed Index** (`api.alternative.me/fng`) — score + 3-day trend (15-min TTL)
   - **CoinGecko** (`COINGECKO_API_KEY` optional) — ETH/BTC price, market cap, volume (5-min TTL)
   - **Etherscan V2** (`ETHERSCAN_API_KEY`) — L1 gas oracle (3-min TTL)
   - **Uniswap V3 Graph** (Goldsky: `api.goldsky.com/api/public/project_cl8ylkiw00krx0hvza0qw17vn/subgraphs/uniswap-v3-base/1.0.0/gn`) — swaps >$50k last 5 min (2-min TTL)
   - **Order Book L2** — live bid/ask walls within ±0.5% of mid price (real-time via WebSocket)
   - **Etherscan Large Tx** (`ETHERSCAN_API_KEY`) — ETH transactions >50 ETH to Uniswap routers (30-sec TTL)
3. **Computed indicators**: RSI-14, EMA-9/21/50, volume ratio (20-bar), swing high/low (50-bar), nearest Fibonacci level (±0.5%)

**Signal scoring** (`computeSignalAlgorithmic`): STRONG = net ≥ 4, MODERATE = net ≥ 2, WEAK = net ≥ 1.
| Source | BUY condition | SELL condition | Points |
|---|---|---|---|
| RSI | < 30 oversold | > 70 overbought | ±2 |
| RSI | 30–40 | 60–70 | ±1 |
| EMA trend | 9>21>50 bullish | 9<21<50 bearish | ±1 each |
| Fibonacci | 38.2–78.6% support + price < EMA21 | 0% resistance | ±2/±1 |
| Volume | Surge > 2x avg (directional) | — | ±1 |
| Tick B/S | ratio > 1.4x | ratio < 0.6x | ±1 |
| Tick momentum | > +0.06% | < -0.06% | ±1 |
| Fear & Greed | ≤ 15 extreme fear | ≥ 85 extreme greed | ±1 |
| **Whale swaps** | BUY net dominant >$50k | SELL net dominant | **±2** |
| **Order book** | bid wall ≥ 3x ask wall | ask wall ≥ 3x bid wall | **±1** |
| **Large L1 tx** | >50 ETH outflow from Uniswap | >50 ETH inflow to Uniswap | **±1** |

New state fields: `whaleActivity`, `orderBook`, `largeTransactions` written to `analyst-state.json`.

### TradeClaw — `scripts/trade-claw.ts`

Seven sequential gates before any swap executes:
1. **Gate 0 — RiskClaw HALT**: reads `risk-state.json`, aborts if `halted === true`
2. **Gate 0b — Liquidity check**: skips if `liquidityWarning === true` (Uniswap V3 depth < $50k)
3. **Gate 1 — Signal strength**: skips HOLD and WEAK
4. **Gate 2 — Freshness**: skips signals older than 20 min
5. **Gate 3 — Deduplication**: one execution per `candleStart` (silent skip)
6. **Gate 4 — Cooldown**: 15 min minimum between trades
7. **Gate 5 — Claude CLI approval**: spawns `claude -p "..."` via `spawnSync`; parses `{"action":"EXECUTE"|"SKIP","reason":"..."}` — skips on CLI failure (safe default)

Position sizing: STRONG = 20%, MODERATE = 20% of available token balance × `volatilityMultiplier` from `risk-state.json`. BUY = spend USDC → receive ETH; SELL = spend ETH → receive USDC. Swap via `cdpSmartWalletActionProvider().swap()` — handles Permit2 approval automatically. Uses `fs.watch` on `analyst-state.json` for <1s reaction time, with 30s polling fallback.

### RiskClaw — `scripts/risk-claw.ts`

Polls every **60s**. Async tick with `evalInProgress` guard prevents overlap.

**Three-phase evaluation per tick:**
1. **Data gathering** (async, parallel): reads analyst + trade state; updates RSI ring buffer; computes win stats; fetches Goldsky liquidity depth.
2. **Arithmetic phase** (synchronous): portfolio value, drawdown, position sizing (with volatility multiplier). Hard limits enforced; result written to `risk-state.json` immediately.
3. **Claude phase** (async, up to 55s): spawns `claude -p` with privacy-locked prompt; parses `{"halted","haltReason","riskNarrative"}`. Claude can ADD a halt; cannot remove an arithmetic halt.

**New risk checks (all written to `risk-state.json`):**
- **Win rate tracking**: reads `tradeLog` from `trade-state.json`, computes win rate, avg P&L/trade, consecutive win/loss streak. `winRateWarning: true` if < 40% over last 10 closed trades.
- **Liquidity validation**: queries Goldsky Uniswap V3 ETH/USDC pool TVL; estimates ±0.5% depth as 10% of TVL. `liquidityWarning: true` if estimated depth < $50,000 → TradeClaw Gate 0b skips trade.
- **Volatility-adjusted sizing**: tracks RSI over last 10 candles in `rsiHistory[]`. If RSI range > 30 pts → `volatilityRegime: "CHOPPY"`, `volatilityMultiplier: 0.5`. Normal → `1.0`. TradeClaw multiplies base position size by this value.
- **Privacy lock**: all Claude CLI calls prefixed with immutable prompt that restricts responses to market/risk topics only.

- **Portfolio value** = `ethBalance * ethPrice + usdcBalance` (price from analyst-state)
- **Peak** persisted in `risk-state.json` — survives process restarts
- **Drawdown** = `(peak - current) / peak`; skip if portfolio < $0.10 (fresh wallet)
- **Hard HALT triggers** (arithmetic): Drawdown > 40%, Pending position size > 25% of portfolio
- **Soft HALT**: Claude CLI can halt for narrative reasons; `riskNarrative` and `claudeMs` in `risk-state.json`

### AgentKit Chat UI — `app/`

Next.js 15 chat interface not part of the trading loop. Agent uses LangGraph ReAct via `@coinbase/agentkit-langchain` with `claude-sonnet-4-20250514`. The wallet is a CDP Smart Wallet (`CdpSmartWalletProvider`) persisted to `wallet_data.txt`.

- `app/api/agent/prepare-agentkit.ts` — wallet + action provider wiring
- `app/api/agent/create-agent.ts` — LLM, system prompt, LangGraph agent (singleton)

Action providers loaded: `weth`, `pyth`, `wallet`, `erc20`, `cdpApi`, `cdpSmartWallet`, `x402`.

---

## Environment Variables (`.env`)

| Variable | Required by | Purpose |
|---|---|---|
| `CDP_API_KEY_ID` | TradeClaw, mint-usdc, chat UI | Coinbase Developer Platform key |
| `CDP_API_KEY_SECRET` | TradeClaw, mint-usdc, chat UI | CDP secret |
| `CDP_WALLET_SECRET` | TradeClaw, mint-usdc, chat UI | Smart wallet encryption secret |
| `ANTHROPIC_API_KEY` | chat UI (`create-agent.ts`) | LLM for the AgentKit chat UI |
| `NETWORK_ID` | AgentKit | Set: `base-mainnet` |
| `PAYMASTER_URL` | AgentKit | Set: Base Paymaster URL (gas sponsored) |
| `RPC_URL` | AgentKit | Optional: custom RPC endpoint |

| `ANTHROPIC_API_KEY`     | AnalystClaw (LLM signals), chat UI | Claude Sonnet signal generation |
| `COINGECKO_API_KEY`     | AnalystClaw | Market context — optional, unauthenticated free tier works at low volume |
| `ETHERSCAN_API_KEY`     | AnalystClaw | Gas oracle + onchain data via Etherscan V2 (free tier at etherscan.io) |

**RiskClaw uses no env vars** — reads local JSON files only. Fear & Greed Index requires no API key. AnalystClaw falls back to HOLD/WEAK when `ANTHROPIC_API_KEY` is missing.

| `OBSIDIAN_VAULT_PATH` | All three claws | Absolute path to the Obsidian vault folder (e.g. `/Users/.../OptimusMegaPrime`). Optional — all writes silently skipped if unset. |
| `NANSEN_API_KEY`      | AnalystClaw, dashboard | Nansen smart-money DEX trade data |

---

## Obsidian Vault Integration

All three agents write structured markdown notes into a local Obsidian vault via `scripts/obsidian-writer.ts`. The vault is auto-created on first run if `OBSIDIAN_VAULT_PATH` is set. All vault writes are non-fatal — agents continue normally if the path is unset or a write fails.

**Vault layout** (`$OBSIDIAN_VAULT_PATH/`):
```
Mission.md               — immutable strategy document
Alignment-Log.md         — daily RiskClaw narrative (one entry per calendar day)
System-Journal.md        — STRONG signals from AnalystClaw
Daily/YYYY-MM-DD.md      — date-stamped daily notes
Insights/
  Winning-Patterns.md    — auto-appended after profitable closed trades
  Losing-Patterns.md     — auto-appended after losing closed trades
Projections/             — reserved for future StrategyCannon
Trades/SLUG.md           — one note per completed trade (with YAML frontmatter)
```

**Integration**:
- **TradeClaw** → `Trades/` (each completed trade) + `Insights/Winning|Losing-Patterns.md`
- **RiskClaw** → `Alignment-Log.md` (once per calendar day after Claude assessment)
- **AnalystClaw** → `System-Journal.md` (STRONG BUY/SELL signals only)

**Module**: `scripts/obsidian-writer.ts` — exports `writeNote`, `appendToNote`, `readNote`, `listNotes`, `writeDaily`, `initVault`.

---

## Key Design Decisions

- **Scripts vs Next.js**: All three agents run as standalone `tsx` processes, not Next.js API routes. They communicate only through `shared/*.json` files.
- **File-based IPC**: `shared/` is the message bus. Writes are synchronous (`fs.writeFileSync`). Readers use `fs.watch` + polling fallback.
- **RiskClaw HALT is Gate 0**: TradeClaw checks `risk-state.json` before evaluating signal strength, freshness, or anything else. A halted system will not trade regardless of signal quality.
- **Peak portfolio tracking**: RiskClaw seeds its peak from the last persisted `risk-state.json` on startup — drawdown is calculated correctly across restarts.
- **Token addresses** (Base mainnet): USDC = `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, native ETH sentinel = `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`, WETH = `0x4200000000000000000000000000000000000006`.
- **Wallet address**: `0x29Efb582AD001088671684F357F5719b2bABBB52` (Base server wallet, Base mainnet). Owner: `0xbe814Eb7F4e96F4F7F659390507a7095Cb17667e`. Persisted in `wallet_data.txt`.
- **CDP Smart Wallet swap** requires a CDP server account owner (`ownerAddress` in `wallet_data.txt`) — not a local private key. The swap provider handles Permit2 approvals internally.
- **Paymaster**: `PAYMASTER_URL` set in `.env` — gas fees on swaps sponsored by Base Paymaster. Wallet needs USDC only, no ETH for gas.
- **Network**: `NETWORK_ID=base-mainnet` — system is live on Base mainnet.
