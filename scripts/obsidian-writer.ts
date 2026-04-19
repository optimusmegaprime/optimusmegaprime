/**
 * obsidian-writer.ts — Obsidian Vault Read/Write Utility
 *
 * Writes structured markdown notes into the Obsidian vault at OBSIDIAN_VAULT_PATH.
 * All operations are non-fatal: if the vault path is unset or a write fails, the
 * agent continues normally. Nothing here blocks the trading loop.
 *
 * Vault layout (auto-created on first run):
 *   OptimusMegaPrime/
 *   ├── Mission.md
 *   ├── Alignment-Log.md
 *   ├── System-Journal.md
 *   ├── Daily/          — date-stamped daily notes
 *   ├── Insights/
 *   │   ├── Winning-Patterns.md
 *   │   └── Losing-Patterns.md
 *   ├── Projections/
 *   └── Trades/         — one note per completed trade
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

export const VAULT_PATH = (process.env.OBSIDIAN_VAULT_PATH ?? "").trim();

// ── Internals ─────────────────────────────────────────────────────────────────

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function resolveFile(folder: string, filename: string): string {
  const dir = folder ? path.join(VAULT_PATH, folder) : VAULT_PATH;
  ensureDir(dir);
  return path.join(dir, filename.endsWith(".md") ? filename : filename + ".md");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Creates or overwrites a note. Silently skips if VAULT_PATH is unset. */
export function writeNote(folder: string, filename: string, content: string): void {
  if (!VAULT_PATH) return;
  try { fs.writeFileSync(resolveFile(folder, filename), content, "utf8"); }
  catch (e) { /* non-fatal */ }
}

/** Appends content to an existing note (creates if missing). */
export function appendToNote(folder: string, filename: string, content: string): void {
  if (!VAULT_PATH) return;
  try { fs.appendFileSync(resolveFile(folder, filename), content, "utf8"); }
  catch (e) { /* non-fatal */ }
}

/** Reads a note. Returns null if unset or missing. */
export function readNote(folder: string, filename: string): string | null {
  if (!VAULT_PATH) return null;
  try { return fs.readFileSync(resolveFile(folder, filename), "utf8"); }
  catch { return null; }
}

/** Lists all .md files in a folder. Returns [] if unset or missing. */
export function listNotes(folder: string): string[] {
  if (!VAULT_PATH) return [];
  try {
    const dir = path.join(VAULT_PATH, folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch { return []; }
}

/** Writes a date-stamped daily note (overwrites if same day already exists). */
export function writeDaily(content: string): void {
  if (!VAULT_PATH) return;
  const today = new Date().toISOString().substring(0, 10);
  writeNote("Daily", today + ".md", content);
}

/** Initialises the vault structure on first run. Safe to call every startup. */
export function initVault(): void {
  if (!VAULT_PATH) return;
  try {
    ["Daily", "Insights", "Projections", "Trades"].forEach((d) =>
      ensureDir(path.join(VAULT_PATH, d)),
    );

    const files: Array<[string, string, string]> = [
      ["", "Mission.md", `---
title: OptimusMegaPrime — Mission
created: ${new Date().toISOString()}
---

# OptimusMegaPrime

**Strategy**: Autonomous ETH/USDC swing trading on Base mainnet via Fibonacci retracement.

**Approach**: Buy at key retracement levels (38.2 %, 50 %, 61.8 %) confirmed by RSI oversold (< 30) and volume surge. Sell at resistance or on RiskClaw HALT.

**Architecture**:
- **AnalystClaw** — algorithmic signal engine (RSI, EMA, Fibonacci, tick microstructure, Nansen smart-money)
- **TradeClaw** — trade executor with claude CLI Gate-5 approval
- **RiskClaw** — portfolio guardian (drawdown, liquidity, volatility)

**Hard limits**: Max drawdown 40 % · Max position 25 % · Cooldown 15 min

**Wallet**: \`0x29Efb582AD001088671684F357F5719b2bABBB52\` — Base mainnet
`],
      ["", "Alignment-Log.md", `---
title: RiskClaw Daily Alignment Log
---

# Alignment Log

*Daily risk narrative entries from RiskClaw (claude-haiku-4-5). One entry per day.*

---
`],
      ["", "System-Journal.md", `---
title: OptimusMegaPrime System Journal
---

# System Journal

*Notable STRONG signals from AnalystClaw. Written once per signal.*

---
`],
      ["Insights", "Winning-Patterns.md", `---
title: Winning Trade Patterns
---

# Winning Patterns

*Auto-populated from profitable closed trades. Identify recurring setups.*

---
`],
      ["Insights", "Losing-Patterns.md", `---
title: Losing Trade Patterns
---

# Losing Patterns

*Auto-populated from losing closed trades. Identify failure modes to avoid.*

---
`],
    ];

    files.forEach(([folder, filename, content]) => {
      const fp = resolveFile(folder, filename);
      if (!fs.existsSync(fp)) fs.writeFileSync(fp, content, "utf8");
    });
  } catch (e) { /* non-fatal */ }
}
