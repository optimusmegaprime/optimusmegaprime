const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Load .env so NANSEN_API_KEY and other vars are available
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
      var m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch(e) {}

const PORT = 3001;
const SHARED_DIR = path.join(__dirname, '..', 'shared');

// ── News cache ────────────────────────────────────────────────────────────────
let newsCache = null;
let newsCacheTime = 0;
const NEWS_TTL = 5 * 60 * 1000;

function fetchNews() {
  if (newsCache && Date.now() - newsCacheTime < NEWS_TTL) return Promise.resolve(newsCache);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'min-api.cryptocompare.com',
      path: '/data/v2/news/?lang=EN&categories=ETH,USDC&sortOrder=latest',
      method: 'GET',
      headers: { 'User-Agent': 'OptimusMegaPrime/1.0' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const items = (json.Data || []).slice(0, 20).map(n => ({
            title: n.title,
            source: (n.source_info && n.source_info.name) || n.source || '',
          }));
          newsCache = { items };
          newsCacheTime = Date.now();
          resolve(newsCache);
        } catch(e) { resolve({ items: [] }); }
      });
    });
    req.on('error', () => resolve({ items: [] }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ items: [] }); });
    req.end();
  });
}

// ── RiskClaw chat (claude -p subprocess) ─────────────────────────────────────
function buildChatPrompt(message, risk, analyst) {
  return `You are RiskClaw, AI risk guardian for OptimusMegaPrime — an autonomous ETH/USDC trading system on Base mainnet.
Speak concisely, directly, and with confidence. You are a trading risk AI.

CURRENT SYSTEM STATE:
Portfolio   : $${risk && risk.portfolioValueUsd ? risk.portfolioValueUsd.toFixed(2) : '--'}  (peak: $${risk && risk.peakPortfolioValueUsd ? risk.peakPortfolioValueUsd.toFixed(2) : '--'})
Drawdown    : ${risk && risk.drawdownPct ? risk.drawdownPct : '0%'}  (hard limit: 40%)
Halted      : ${risk && risk.halted ? 'YES — ' + risk.haltReason : 'NO — CLEAR'}
ETH price   : $${analyst && analyst.price ? analyst.price.toFixed(2) : '--'}
Signal      : ${analyst && analyst.signal ? analyst.signal : '--'} (${analyst && analyst.strength ? analyst.strength : '--'})
RSI         : ${analyst && analyst.rsi ? analyst.rsi.toFixed(1) : '--'}
Fear/Greed  : ${analyst && analyst.fearGreedValue != null ? analyst.fearGreedValue + ' (' + analyst.fearGreedLabel + ')' : '--'}
Assessment  : ${risk && risk.riskNarrative ? risk.riskNarrative : 'No assessment yet'}

USER MESSAGE: ${message}

Reply in 2-4 sentences. Be direct and informative. No markdown formatting.`;
}

function queryClaudeChat(prompt) {
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => { proc.kill(); resolve('RiskClaw timed out. Try again.'); }, 55000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => { clearTimeout(timer); resolve(out.trim() || 'No response received.'); });
    proc.on('error', () => { clearTimeout(timer); resolve('RiskClaw subprocess unavailable.'); });
  });
}

function readJSON(filename) {
  try { return JSON.parse(fs.readFileSync(path.join(SHARED_DIR, filename), 'utf8')); }
  catch { return null; }
}

const GRAN_SECS = {
  ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800, ONE_HOUR: 3600, TWO_HOUR: 7200,
  SIX_HOUR: 21600, ONE_DAY: 86400, ONE_WEEK: 604800
};

function fetchCandlesRaw(gran, startTs, endTs) {
  const p = `/api/v3/brokerage/market/products/ETH-USDC/candles?start=${startTs}&end=${endTs}&granularity=${gran}`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.coinbase.com', path: p, method: 'GET',
      headers: { 'User-Agent': 'OptimusMegaPrime/1.0' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).candles || []); } catch(e) { resolve([]); } });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(15000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function fetchCandles(granularity, bars) {
  granularity = granularity || 'ONE_MINUTE';
  bars = Math.min(bars || 200, 300);
  const gSec = GRAN_SECS[granularity] || 60;
  const end = Math.floor(Date.now() / 1000);
  const start = end - (bars * gSec);
  return fetchCandlesRaw(granularity, start, end).then(function(candles) {
    return { candles: candles };
  });
}

const historicalCandlesCache = {};
const HIST_CANDLES_TTL = 10 * 60 * 1000;

async function fetchCandlesPaginated(gran, fromTs, toTs) {
  const cacheFromTs = Math.floor(fromTs / 3600) * 3600;
  const cacheKey = gran + ':' + cacheFromTs;
  const now = Date.now();
  if (historicalCandlesCache[cacheKey] && now - historicalCandlesCache[cacheKey].ts < HIST_CANDLES_TTL) {
    return historicalCandlesCache[cacheKey].data;
  }
  const gSec = GRAN_SECS[gran] || 60;
  const chunkSecs = 298 * gSec;
  const seen = {};
  let cursor = fromTs;
  while (cursor < toTs) {
    const chunkEnd = Math.min(cursor + chunkSecs, toTs);
    const candles = await fetchCandlesRaw(gran, cursor, chunkEnd);
    (candles || []).forEach(function(c) { seen[c.start] = c; });
    cursor = chunkEnd;
    if (candles.length === 0 || chunkEnd >= toTs) break;
    await new Promise(r => setTimeout(r, 150));
  }
  const sorted = Object.values(seen).sort((a, b) => parseInt(a.start) - parseInt(b.start));
  const result = { candles: sorted };
  historicalCandlesCache[cacheKey] = { ts: now, data: result };
  return result;
}

// ── Nansen smart money whale cache ───────────────────────────────────────────
var nansenWhaleCache = null;
var nansenWhaleCacheTime = 0;
const NANSEN_WHALE_TTL = 5 * 60 * 1000;

function fetchNansenWhales() {
  var now = Date.now();
  if (nansenWhaleCache && (now - nansenWhaleCacheTime) < NANSEN_WHALE_TTL) {
    return Promise.resolve(nansenWhaleCache);
  }
  var apiKey = process.env.NANSEN_API_KEY;
  if (!apiKey) return Promise.resolve(null);
  var body = JSON.stringify({ chains: ['ethereum'], pagination: { limit: 500 } });
  return new Promise(function(resolve) {
    var opts = {
      hostname: 'api.nansen.ai', path: '/api/v1/smart-money/dex-trades', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'apiKey': apiKey,
        'Content-Length': Buffer.byteLength(body), 'User-Agent': 'OptimusMegaPrime/1.0'
      }
    };
    var req = https.request(opts, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try {
          var trades = (JSON.parse(d).data || []);
          var result = { trades: [], buyUsd: 0, sellUsd: 0, buyCount: 0, sellCount: 0, direction: 'NEUTRAL' };
          trades.forEach(function(t) {
            var dir = t.token_bought_symbol === 'ETH' ? 'BUY' : t.token_sold_symbol === 'ETH' ? 'SELL' : null;
            if (!dir) return;
            var usd = t.trade_value_usd || 0;
            result.trades.push({
              timestamp: Math.floor(new Date(t.block_timestamp).getTime() / 1000),
              direction: dir,
              amountUsd: Math.round(usd),
              label: t.trader_address_label || '',
              txHash: t.transaction_hash || ''
            });
            if (dir === 'BUY') { result.buyUsd += usd; result.buyCount++; }
            else               { result.sellUsd += usd; result.sellCount++; }
          });
          result.trades.sort(function(a, b) { return b.timestamp - a.timestamp; });
          result.buyUsd  = Math.round(result.buyUsd);
          result.sellUsd = Math.round(result.sellUsd);
          if (result.buyUsd > result.sellUsd * 1.5)  result.direction = 'BUY';
          else if (result.sellUsd > result.buyUsd * 1.5) result.direction = 'SELL';
          nansenWhaleCache = result;
          nansenWhaleCacheTime = now;
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', function() { resolve(null); });
    req.setTimeout(12000, function() { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── RSS ticker caches ─────────────────────────────────────────────────────────
const TICKER_CACHE = {};
const TICKER_CACHE_TIME = {};
const TICKER_TTL = 60 * 1000;

function parseRSSXML(xml) {
  var items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  return items.slice(0, 25).map(function(item) {
    var m = item.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    if (!m) return null;
    return m[1]
      .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '').replace(/<[^>]*>/g, '').trim();
  }).filter(Boolean);
}

function fetchRSSRaw(hostname, urlPath) {
  return new Promise(function(resolve) {
    var opts = { hostname: hostname, path: urlPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 OptimusMegaPrime/1.0', 'Accept': 'application/rss+xml,text/xml,*/*' } };
    var req = https.request(opts, function(res) {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        try {
          var loc = new URL(res.headers.location);
          fetchRSSRaw(loc.hostname, loc.pathname + loc.search).then(resolve);
        } catch(e) { resolve(''); }
        return;
      }
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { resolve(d); });
    });
    req.on('error', function() { resolve(''); });
    req.setTimeout(8000, function() { req.destroy(); resolve(''); });
    req.end();
  });
}

function fetchRSS(key, hostname, urlPath) {
  if (TICKER_CACHE[key] && Date.now() - (TICKER_CACHE_TIME[key] || 0) < TICKER_TTL) {
    return Promise.resolve(TICKER_CACHE[key]);
  }
  return fetchRSSRaw(hostname, urlPath).then(function(xml) {
    var titles = xml ? parseRSSXML(xml) : [];
    TICKER_CACHE[key] = titles;
    TICKER_CACHE_TIME[key] = Date.now();
    return titles;
  });
}

async function fetchAllTickers() {
  const [bbc, finance, crypto] = await Promise.all([
    fetchRSS('bbc',     'feeds.bbci.co.uk',          '/news/world/rss.xml'),
    fetchRSS('finance', 'feeds.finance.yahoo.com',  '/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US'),
    fetchRSS('crypto',  'cointelegraph.com',        '/rss'),
  ]);
  return { bbc, finance, crypto };
}

const HTML = getHTML();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const origin = req.headers['origin'] || '';
  if (origin === 'http://localhost:3001' || origin === 'http://127.0.0.1:3001' || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || 'http://localhost:3001');
  }

  if (u.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      analyst: readJSON('analyst-state.json'),
      trade:   readJSON('trade-state.json'),
      risk:    readJSON('risk-state.json'),
    }));
    return;
  }

  if (u.pathname === '/api/news') {
    try {
      const data = await fetchNews();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [] }));
    }
    return;
  }

  if (u.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d.toString(); });
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        if (!message || !message.trim()) {
          res.writeHead(400); res.end(JSON.stringify({ reply: 'Empty message.' })); return;
        }
        const risk    = readJSON('risk-state.json');
        const analyst = readJSON('analyst-state.json');
        const prompt  = buildChatPrompt(message.trim(), risk, analyst);
        const reply   = await queryClaudeChat(prompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: 'Error: ' + e.message }));
      }
    });
    return;
  }

  if (u.pathname === '/api/tickers') {
    try {
      const data = await fetchAllTickers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bbc: [], finance: [], crypto: [] }));
    }
    return;
  }

  if (u.pathname === '/api/nansen-whales') {
    fetchNansenWhales().then(function(data) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data || {}));
    });
    return;
  }

  if (u.pathname === '/api/obsidian-daily') {
    const date = u.searchParams.get('date') || '';
    const vaultPath = (process.env.OBSIDIAN_VAULT_PATH || '').trim();
    if (!vaultPath || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: null }));
      return;
    }
    try {
      const fp = path.join(vaultPath, 'Daily', date + '.md');
      const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: null }));
    }
    return;
  }

  if (u.pathname === '/api/obsidian-dates') {
    const vaultPath = (process.env.OBSIDIAN_VAULT_PATH || '').trim();
    if (!vaultPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dates: [] }));
      return;
    }
    try {
      const dailyDir = path.join(vaultPath, 'Daily');
      if (!fs.existsSync(dailyDir)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dates: [] }));
        return;
      }
      const dates = fs.readdirSync(dailyDir)
        .filter(function(f) { return /^\d{4}-\d{2}-\d{2}\.md$/.test(f); })
        .map(function(f) { return f.replace('.md', ''); })
        .sort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dates }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dates: [] }));
    }
    return;
  }

  if (u.pathname === '/api/strategy-params') {
    try {
      const fp = path.join(SHARED_DIR, 'strategy-params.json');
      const data = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || {}));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  if (u.pathname === '/api/cannon-state') {
    try {
      const fp = path.join(SHARED_DIR, 'cannon-state.json');
      const data = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || {}));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  if (u.pathname === '/api/lots') {
    try {
      const fp = path.join(SHARED_DIR, 'trade-state.json');
      const trade = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : null;
      const lots = trade?.lots ?? [];
      const ethPrice = (() => {
        try {
          const af = path.join(SHARED_DIR, 'analyst-state.json');
          return fs.existsSync(af) ? (JSON.parse(fs.readFileSync(af, 'utf8'))?.price ?? 0) : 0;
        } catch { return 0; }
      })();
      const enriched = lots.map(lot => ({
        ...lot,
        unrealizedPnlUsd: lot.status !== 'CLOSED' && ethPrice > 0
          ? parseFloat(((lot.ethRemaining * ethPrice) - lot.usdcCostRemaining).toFixed(4))
          : null,
        unrealizedPnlPct: lot.status !== 'CLOSED' && ethPrice > 0 && lot.usdcCostRemaining > 0
          ? (((lot.ethRemaining * ethPrice - lot.usdcCostRemaining) / lot.usdcCostRemaining) * 100).toFixed(2) + '%'
          : null,
        currentPriceUsd: ethPrice > 0 ? ethPrice : null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lots: enriched, count: lots.length, ethPrice }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lots: [], count: 0, error: e.message }));
    }
    return;
  }

  if (u.pathname === '/api/candles') {
    try {
      const gran = u.searchParams.get('granularity') || 'ONE_MINUTE';
      const fromParam = u.searchParams.get('from');
      let data;
      if (fromParam) {
        const fromTs = Math.floor(parseInt(fromParam) / 3600) * 3600;
        const toTs = Math.floor(Date.now() / 1000);
        data = await fetchCandlesPaginated(gran, fromTs, toTs);
      } else {
        const bars = parseInt(u.searchParams.get('bars') || '200');
        data = await fetchCandles(gran, bars);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\x1b[36m[OptimusMegaPrime Dashboard]\x1b[0m http://localhost:' + PORT);
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="OPTIMUS">
<meta name="theme-color" content="#030912">
<title>OPTIMUSMEGAPRIME // TRADING SYSTEM</title>
<script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --c:#3399FF;--b:#0055CC;--g:#55BBFF;--r:#FF2020;--y:#FFFFFF;--o:#FF5522;
  --bg:#030912;--pbg:#060F20;--br:rgba(51,153,255,0.38);
  --gc:0 0 12px #2288FF,0 0 28px rgba(34,136,255,0.45);
  --gg:0 0 12px #44AAFF,0 0 28px rgba(68,170,255,0.45);
  --gr:0 0 12px #FF2020,0 0 28px rgba(255,32,32,0.45);
}
body{background:#030912;color:#D8EEFF;font-family:'Courier New',monospace;min-height:100vh;overflow-x:hidden;font-size:15px;zoom:1.2}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(34,136,255,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(34,136,255,0.06) 1px,transparent 1px);background-size:50px 50px;pointer-events:none;z-index:0}
body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,0.07) 3px,rgba(0,0,0,0.07) 4px);pointer-events:none;z-index:0}
.wrap{position:relative;z-index:2;padding:10px}

/* TOP BAR */
.topbar{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,rgba(34,136,255,0.08),rgba(255,32,32,0.05));border:1px solid var(--br);border-radius:4px;padding:10px 20px;margin-bottom:10px;box-shadow:0 0 24px rgba(34,136,255,0.15),inset 0 1px 0 rgba(34,136,255,0.12)}
.logo{font-size:18px;font-weight:bold;letter-spacing:4px;color:var(--c);text-shadow:var(--gc)}
.ethbig{font-size:36px;font-weight:bold;color:var(--c);text-shadow:var(--gc);letter-spacing:2px;text-align:center}
.ethlbl{font-size:11px;color:rgba(34,136,255,0.5);display:block;letter-spacing:3px;margin-bottom:2px}
.status-row{display:flex;gap:12px;align-items:center}
.ast{display:flex;align-items:center;gap:6px;font-size:11px;letter-spacing:1px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--g);box-shadow:var(--gg);animation:blink 2s infinite}
.dot.off{background:var(--r);box-shadow:var(--gr);animation:none}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.4}}
.ts{font-size:11px;color:rgba(34,136,255,0.5);letter-spacing:1px}

/* PANELS */
.panels{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
.panel{background:var(--pbg);border:1px solid var(--br);border-radius:4px;padding:15px;box-shadow:0 0 15px rgba(34,136,255,0.05),inset 0 1px 0 rgba(34,136,255,0.08);position:relative;overflow:hidden}
.panel::before{content:'';position:absolute;top:0;left:0;width:20px;height:20px;border-top:2px solid var(--c);border-left:2px solid var(--c);box-shadow:-2px -2px 8px rgba(34,136,255,0.3)}
.panel::after{content:'';position:absolute;bottom:0;right:0;width:20px;height:20px;border-bottom:2px solid var(--c);border-right:2px solid var(--c);box-shadow:2px 2px 8px rgba(34,136,255,0.3)}
.ptitle{font-size:15px;letter-spacing:4px;color:var(--c);text-shadow:var(--gc);margin-bottom:15px;padding-bottom:8px;border-bottom:1px solid rgba(34,136,255,0.2);text-align:center}
.ptitle .mtag{font-size:10px;color:rgba(34,136,255,0.6);display:block;letter-spacing:2px;margin-top:2px}
.dr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
.dl{color:rgba(51,153,255,0.75);letter-spacing:1px;font-size:11px}
.dv{color:var(--c);font-weight:bold;letter-spacing:1px}
.dv.g{color:var(--g);text-shadow:var(--gg)}
.dv.r{color:var(--r);text-shadow:var(--gr)}
.dv.y{color:var(--y)}
.dv.o{color:var(--o)}
.div{height:1px;background:linear-gradient(90deg,transparent,rgba(34,136,255,0.3),transparent);margin:8px 0}

/* SIGNAL BADGE */
.sig{display:block;padding:5px 12px;border-radius:2px;font-size:15px;font-weight:bold;letter-spacing:3px;text-align:center;width:100%;margin:10px 0}
.sig.BUY{color:var(--g);border:1px solid var(--g);text-shadow:var(--gg);animation:pg 1.5s infinite}
.sig.SELL{color:var(--r);border:1px solid var(--r);text-shadow:var(--gr);animation:pr 1.5s infinite}
.sig.HOLD{color:var(--y);border:1px solid var(--y);box-shadow:0 0 10px rgba(255,221,0,0.3)}
@keyframes pg{0%,100%{box-shadow:0 0 10px rgba(68,170,255,0.3)}50%{box-shadow:0 0 30px rgba(68,170,255,0.8),0 0 60px rgba(68,170,255,0.3)}}
@keyframes pr{0%,100%{box-shadow:0 0 10px rgba(255,32,32,0.3)}50%{box-shadow:0 0 30px rgba(255,32,32,0.8),0 0 60px rgba(255,32,32,0.3)}}

/* STRENGTH */
.sb{display:flex;gap:4px;justify-content:center;margin:6px 0}
.sp{width:24px;height:8px;border-radius:1px;background:rgba(34,136,255,0.08);border:1px solid rgba(34,136,255,0.15)}
.sp.a{background:rgba(34,136,255,0.5);box-shadow:0 0 6px var(--c)}
.sp.a.STRONG{background:var(--g);box-shadow:0 0 6px var(--g)}
.sp.a.MODERATE{background:var(--y);box-shadow:0 0 6px var(--y)}

/* RSI */
.rsiwrap{text-align:center;margin:8px 0;position:relative;display:inline-block;width:100%}
#rsi-gauge{display:block;margin:0 auto}
.rsinum{position:absolute;bottom:2px;left:50%;transform:translateX(-50%);font-size:22px;font-weight:bold;color:var(--c);text-shadow:var(--gc);letter-spacing:2px}

/* FIB */
.fibsec{margin:8px 0}
.fibtitle{font-size:9px;letter-spacing:2px;color:rgba(34,136,255,0.35);margin-bottom:5px;text-align:center}
.fibrow{display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:10px}
.fiblbl{width:32px;color:rgba(34,136,255,0.55);text-align:right;flex-shrink:0}
.fibtrack{flex:1;height:5px;background:rgba(34,136,255,0.05);border:1px solid rgba(34,136,255,0.1);border-radius:1px;overflow:hidden}
.fibfill{height:100%;background:linear-gradient(90deg,rgba(34,136,255,0.3),rgba(34,136,255,0.7));border-radius:1px;transition:width 0.5s ease}
.fibfill.near{background:var(--y);box-shadow:0 0 6px var(--y)}
.fibprice{width:52px;color:rgba(34,136,255,0.45);font-size:9px;flex-shrink:0}

/* VOL BAR */
.voltrack{width:100%;height:7px;background:rgba(34,136,255,0.05);border:1px solid rgba(34,136,255,0.2);border-radius:1px;overflow:hidden;margin-top:3px}
.volfill{height:100%;background:linear-gradient(90deg,#FF2020,#2288FF);box-shadow:0 0 8px rgba(34,136,255,0.5);transition:width 0.5s ease}

/* REASON */
.reason{font-size:10px;color:rgba(34,136,255,0.6);padding:7px;border:1px solid rgba(34,136,255,0.1);background:rgba(34,136,255,0.02);border-radius:2px;line-height:1.5;margin-top:7px}

/* BALANCES */
.balgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.balbox{padding:10px;border:1px solid rgba(34,136,255,0.2);background:rgba(34,136,255,0.03);border-radius:2px;text-align:center}
.ballbl{font-size:9px;color:rgba(34,136,255,0.4);letter-spacing:2px;display:block}
.balval{font-size:17px;font-weight:bold;color:var(--c);text-shadow:var(--gc);letter-spacing:1px;display:block;margin-top:4px}

/* PNL */
.pnlbox{text-align:center;padding:8px;margin:8px 0;border:1px solid rgba(34,136,255,0.2);background:rgba(34,136,255,0.02);border-radius:2px}
.pnllbl{font-size:9px;color:rgba(34,136,255,0.4);letter-spacing:3px;display:block}
.pnlval{font-size:22px;font-weight:bold;letter-spacing:2px;display:block;margin-top:4px;color:var(--c);text-shadow:var(--gc)}

/* RICH TRADE LOG */
.rtlog{margin-top:10px;border:1px solid rgba(34,136,255,0.15);border-radius:2px;overflow:hidden}
.rtlog-hdr{font-size:9px;letter-spacing:2px;color:rgba(34,136,255,0.5);padding:5px 8px;background:rgba(34,136,255,0.05);border-bottom:1px solid rgba(34,136,255,0.15);display:flex;justify-content:space-between;align-items:center}
.rtlog-body{max-height:320px;overflow-y:auto;padding:4px}
.rtlog-body::-webkit-scrollbar{width:3px}
.rtlog-body::-webkit-scrollbar-thumb{background:rgba(34,136,255,0.3)}
.rte{border-radius:2px;border-left:3px solid rgba(34,136,255,0.2);margin-bottom:5px;padding:5px 7px;background:rgba(34,136,255,0.02)}
.rte.profit{border-left-color:#44AAFF;background:rgba(68,170,255,0.025)}
.rte.loss{border-left-color:#FF2020;background:rgba(255,32,32,0.025)}
.rte.open{border-left-color:rgba(34,136,255,0.35)}
.rte-hdr{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
.rte-ts{font-size:8px;color:rgba(34,136,255,0.4);flex-shrink:0;letter-spacing:0}
.rte-action{font-size:10px;font-weight:bold;letter-spacing:1px;padding:1px 5px;border-radius:1px;flex-shrink:0}
.rte-action.BUY{color:#44AAFF;border:1px solid rgba(68,170,255,0.4);background:rgba(68,170,255,0.06)}
.rte-action.SELL{color:#FF2020;border:1px solid rgba(255,32,32,0.4);background:rgba(255,32,32,0.06)}
.rte-str{font-size:8px;letter-spacing:1px;color:rgba(34,136,255,0.35);flex-shrink:0}
.rte-pnl{font-size:10px;font-weight:bold;margin-left:auto;letter-spacing:0}
.rte-pnl.profit{color:#44AAFF;text-shadow:0 0 6px rgba(68,170,255,0.5)}
.rte-pnl.loss{color:#FF2020;text-shadow:0 0 6px rgba(255,32,32,0.5)}
.rte-pnl.open{color:rgba(34,136,255,0.35);font-size:8px}
.rte-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:3px;margin-bottom:4px}
.rte-cell{text-align:center;padding:2px 0}
.rte-cell-lbl{font-size:7px;color:rgba(34,136,255,0.3);display:block;letter-spacing:1px;text-transform:uppercase}
.rte-cell-val{font-size:9px;color:rgba(34,136,255,0.75);display:block;letter-spacing:0}
.rte-ind-row{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}
.rte-ind{font-size:8px;padding:1px 5px;border:1px solid rgba(34,136,255,0.12);border-radius:1px;color:rgba(34,136,255,0.5);letter-spacing:0;white-space:nowrap}
.rte-claude{font-size:8px;color:rgba(34,136,255,0.4);border-top:1px solid rgba(34,136,255,0.08);padding-top:3px;margin-bottom:3px;line-height:1.45;font-style:italic}
.rte-tx{font-size:8px}
.rte-tx a{color:rgba(34,136,255,0.8);text-decoration:none;letter-spacing:0}
.rte-tx a:hover{color:#2288FF;text-decoration:underline}
.no-trades{text-align:center;color:rgba(34,136,255,0.2);font-size:10px;padding:22px;letter-spacing:2px}
.wallet{font-size:9px;color:rgba(34,136,255,0.25);text-align:center;padding:4px;margin-top:3px;overflow:hidden;text-overflow:ellipsis}
.skiptag{font-size:9px;color:rgba(255,136,0,0.7);letter-spacing:1px}

/* RISK */
.portval{font-size:26px;font-weight:bold;color:var(--c);text-shadow:var(--gc);letter-spacing:2px;display:block;text-align:center}
.portlbl{font-size:9px;color:rgba(34,136,255,0.4);letter-spacing:3px;text-align:center;display:block;margin:3px 0 8px}
.ddtrack{width:100%;height:10px;background:rgba(34,136,255,0.05);border:1px solid rgba(34,136,255,0.2);border-radius:2px;overflow:hidden;margin-top:4px}
.ddfill{height:100%;transition:width 0.5s,background 0.5s;border-radius:1px}
.chk{display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:3px 0}
.ok{color:var(--g)}
.fail{color:var(--r)}
.halt{display:none;text-align:center;padding:10px;border:2px solid var(--r);border-radius:2px;color:var(--r);font-size:13px;font-weight:bold;letter-spacing:4px;text-shadow:var(--gr);box-shadow:var(--gr);animation:hf 0.5s infinite;margin:8px 0}
.halt.on{display:block}
@keyframes hf{0%,100%{opacity:1}50%{opacity:0.25}}
.haltreason{font-size:10px;color:rgba(255,32,32,0.7);text-align:center;display:none}

/* CHART */
.chartsec{background:var(--pbg);border:1px solid var(--br);border-radius:4px;padding:15px;box-shadow:0 0 15px rgba(34,136,255,0.05)}
.chartsec.fullscreen{position:fixed;inset:0;z-index:9000;padding:10px;border-radius:0;background:#030912}
.chart-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px}
.tf-bar{display:flex;gap:3px;flex-wrap:wrap}
.tf-btn{background:rgba(34,136,255,0.06);border:1px solid rgba(34,136,255,0.2);color:rgba(34,136,255,0.5);font-family:'Courier New',monospace;font-size:10px;letter-spacing:1px;padding:3px 7px;border-radius:2px;cursor:pointer;transition:all 0.15s}
.tf-btn:hover{border-color:rgba(34,136,255,0.5);color:#3399FF}
.tf-btn.active{background:rgba(0,200,255,0.12);border-color:#00CCFF;color:#00CCFF;text-shadow:0 0 8px rgba(0,200,255,0.7);box-shadow:0 0 8px rgba(0,200,255,0.2)}
.chart-fullscreen-btn{background:rgba(34,136,255,0.06);border:1px solid rgba(34,136,255,0.2);color:rgba(34,136,255,0.5);font-size:14px;padding:2px 8px;border-radius:2px;cursor:pointer;transition:all 0.15s}
.chart-fullscreen-btn:hover{border-color:#00CCFF;color:#00CCFF}
.chartwrap{position:relative;display:flex;flex-direction:column;gap:1px}
.chart-price-wrap{height:340px;position:relative;border-radius:2px;overflow:hidden}
.chart-rsi-wrap{height:90px;position:relative;border-radius:2px;overflow:hidden}
.chart-sub-lbl{position:absolute;top:4px;left:8px;font-size:8px;letter-spacing:2px;color:rgba(34,136,255,0.4);z-index:2;pointer-events:none}

/* F&G GAUGE */
.fng-gauge-wrap{display:flex;flex-direction:column;align-items:center;margin:4px 0}
.fng-gauge-arc{position:relative;width:90px;height:50px;overflow:hidden}
.fng-arc-bg{position:absolute;bottom:0;left:0;right:0;height:90px;border-radius:90px 90px 0 0;background:conic-gradient(from 180deg at 50% 100%,#FF2020 0deg,#FF8800 36deg,#FFFF00 72deg,#44AAFF 108deg,#00FFFF 180deg);opacity:0.25}
.fng-arc-needle{position:absolute;bottom:0;left:50%;width:2px;height:42px;transform-origin:bottom center;background:linear-gradient(to top,#FFFFFF,rgba(255,255,255,0));border-radius:2px;box-shadow:0 0 6px #FFFFFF;transition:transform 0.8s ease}
.fng-arc-val{font-size:16px;font-weight:bold;letter-spacing:1px;text-align:center;display:block;margin-top:2px}
.fng-arc-lbl{font-size:8px;letter-spacing:2px;text-align:center;display:block;color:rgba(34,136,255,0.4)}

/* DATA SOURCE PILLS */
.srcpills{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
.pill{font-size:8px;letter-spacing:1px;padding:2px 6px;border-radius:2px;border:1px solid rgba(34,136,255,0.2);color:rgba(34,136,255,0.4);background:rgba(34,136,255,0.04)}
.pill.on{border-color:var(--g);color:var(--g);background:rgba(68,170,255,0.06);box-shadow:0 0 4px rgba(68,170,255,0.3)}

/* TICK PRICE FLASH */
.tickprice{font-size:10px;color:rgba(34,136,255,0.45);text-align:center;letter-spacing:1px;margin-top:2px}
.tickprice span{color:var(--c)}

/* EMA legend */
.ema-legend{display:flex;gap:10px;justify-content:center;margin-bottom:6px}
.ema-dot{display:flex;align-items:center;gap:4px;font-size:9px;color:rgba(34,136,255,0.4)}
.ema-dot b{display:inline-block;width:20px;height:2px;border-radius:1px}

/* SIGNAL CONTEXT BOX */
.sigctx{border:1px solid rgba(34,136,255,0.15);background:rgba(34,136,255,0.02);border-radius:2px;padding:7px;margin:8px 0}
.sigctx-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.sigctx-badge{font-size:13px;font-weight:bold;letter-spacing:2px;padding:2px 8px;border-radius:2px;border:1px solid currentColor}
.sigctx-badge.BUY{color:var(--g);text-shadow:var(--gg);box-shadow:0 0 8px rgba(68,170,255,0.3)}
.sigctx-badge.SELL{color:var(--r);text-shadow:var(--gr);box-shadow:0 0 8px rgba(255,32,32,0.3)}
.sigctx-badge.HOLD{color:var(--y);border-color:var(--y)}
.sigctx-age{font-size:9px;color:rgba(34,136,255,0.35);letter-spacing:1px}
.sigctx-strength{font-size:9px;letter-spacing:2px;color:rgba(34,136,255,0.4);margin-bottom:4px}
.sigctx-reason{font-size:9px;color:rgba(34,136,255,0.5);line-height:1.5;border-top:1px solid rgba(34,136,255,0.08);padding-top:5px;margin-top:2px}

/* MINI RSI + FEAR/GREED ROW */
.mini-row{display:flex;gap:6px;align-items:stretch;margin:8px 0}
.mini-box{flex:1;border:1px solid rgba(34,136,255,0.15);background:rgba(34,136,255,0.02);border-radius:2px;padding:6px 4px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center}
.mini-lbl{font-size:8px;letter-spacing:2px;color:rgba(34,136,255,0.4);display:block;margin-bottom:2px}
.mini-val{font-size:18px;font-weight:bold;color:var(--c);text-shadow:var(--gc);display:block;letter-spacing:1px;line-height:1.1}
.mini-sub{font-size:8px;color:rgba(34,136,255,0.35);display:block;margin-top:2px;letter-spacing:1px}
.mini-rsi-num{font-size:15px;font-weight:bold;letter-spacing:1px;margin-top:0}

/* FIB PROXIMITY */
.fibprox{margin:6px 0}
.fibprox-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.fibprox-lbl{font-size:9px;letter-spacing:1px;color:rgba(34,136,255,0.4)}
.fibprox-val{font-size:9px;letter-spacing:1px;font-weight:bold}
.fibprox-track{width:100%;height:9px;background:rgba(34,136,255,0.05);border:1px solid rgba(34,136,255,0.2);border-radius:1px;overflow:hidden;position:relative}
.fibprox-fill{height:100%;border-radius:1px;transition:width 0.6s ease}
.fibprox-fill.far{background:linear-gradient(90deg,rgba(34,136,255,0.4),rgba(34,136,255,0.5));box-shadow:0 0 5px rgba(34,136,255,0.3)}
.fibprox-fill.mid{background:linear-gradient(90deg,rgba(255,136,0,0.5),var(--o));box-shadow:0 0 6px rgba(255,136,0,0.4)}
.fibprox-fill.close{background:linear-gradient(90deg,rgba(68,170,255,0.4),var(--g));box-shadow:0 0 8px rgba(68,170,255,0.6)}

/* COOLDOWN TIMER */
.cooldown{margin:6px 0}
.cooldown-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.cooldown-lbl{font-size:9px;letter-spacing:1px;color:rgba(34,136,255,0.4)}
.cooldown-val{font-size:9px;font-weight:bold;letter-spacing:1px}
.cooldown-val.ready{color:var(--g);text-shadow:var(--gg)}
.cooldown-val.waiting{color:var(--o)}
.cooldown-track{width:100%;height:9px;background:rgba(34,136,255,0.05);border:1px solid rgba(34,136,255,0.2);border-radius:1px;overflow:hidden}
.cooldown-fill{height:100%;border-radius:1px;transition:width 2s linear}
.cooldown-fill.ready{background:linear-gradient(90deg,rgba(68,170,255,0.3),var(--g));box-shadow:0 0 8px rgba(68,170,255,0.5)}
.cooldown-fill.waiting{background:linear-gradient(90deg,#880011,#FF2020);box-shadow:0 0 6px rgba(255,32,32,0.4)}

/* SESSION P&L */
.pnlrow{display:flex;gap:6px;margin:6px 0}
.pnlhalf{flex:1;text-align:center;border:1px solid rgba(34,136,255,0.15);background:rgba(34,136,255,0.02);border-radius:2px;padding:6px 4px}
.pnlhalf-lbl{font-size:8px;letter-spacing:2px;color:rgba(34,136,255,0.4);display:block;margin-bottom:3px}
.pnlhalf-val{font-size:14px;font-weight:bold;letter-spacing:1px;display:block}

/* PERFORMANCE GRID */
.perfgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin:8px 0}
.perfbox{border:1px solid rgba(34,136,255,0.12);background:rgba(34,136,255,0.02);border-radius:2px;padding:5px 3px;text-align:center}
.perflbl{font-size:7px;letter-spacing:1px;color:rgba(34,136,255,0.35);display:block;margin-bottom:3px;text-transform:uppercase}
.perfval{font-size:14px;font-weight:bold;color:var(--c);display:block;letter-spacing:1px}

/* LIVE NEWS TICKER */
.risk-ticker{margin-top:14px;border:1px solid rgba(255,32,32,0.28);border-radius:3px;overflow:hidden}
.risk-ticker-hdr{font-size:10px;letter-spacing:2px;color:rgba(255,100,100,0.9);padding:5px 10px;background:rgba(255,32,32,0.08);border-bottom:1px solid rgba(255,32,32,0.18);display:flex;justify-content:space-between;align-items:center}
.ticker-outer{overflow:hidden;padding:7px 0;background:rgba(255,32,32,0.03);white-space:nowrap}
.ticker-inner{display:inline-block;animation:rticker 90s linear infinite;white-space:nowrap}
.ticker-inner:hover{animation-play-state:paused;cursor:default}
.ticker-item{display:inline-block;padding:0 36px;font-size:12px;color:#FFD8D8;letter-spacing:0.3px}
.ticker-item::before{content:'⬡  ';color:#FF2020;font-size:10px}
@keyframes rticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}

/* RISKCLAW CHAT */
.risk-chat{margin-top:12px;border:1px solid rgba(51,153,255,0.25);border-radius:3px;overflow:hidden}
.chat-hdr{font-size:10px;letter-spacing:2px;color:rgba(100,180,255,0.9);padding:5px 10px;background:rgba(51,153,255,0.07);border-bottom:1px solid rgba(51,153,255,0.18);display:flex;justify-content:space-between;align-items:center}
.chat-msgs{max-height:220px;min-height:80px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:7px;background:rgba(3,9,18,0.6)}
.chat-msgs::-webkit-scrollbar{width:3px}
.chat-msgs::-webkit-scrollbar-thumb{background:rgba(51,153,255,0.35)}
.chat-msg{font-size:13px;line-height:1.55;padding:6px 10px;border-radius:3px;max-width:94%;word-wrap:break-word}
.chat-msg.sys{color:rgba(170,210,255,0.55);font-size:11px;font-style:italic;align-self:center;text-align:center;background:none;border:none;padding:2px}
.chat-msg.user{background:rgba(51,153,255,0.14);border:1px solid rgba(51,153,255,0.28);color:#E0F0FF;align-self:flex-end;border-radius:4px 4px 0 4px}
.chat-msg.bot{background:rgba(255,32,32,0.08);border:1px solid rgba(255,32,32,0.2);color:#FFE0E0;align-self:flex-start;border-radius:4px 4px 4px 0}
.chat-msg.thinking{color:rgba(51,153,255,0.5);font-style:italic;font-size:11px;align-self:flex-start;background:none;border:none;animation:blink 1s infinite}
.chat-row{display:flex;border-top:1px solid rgba(51,153,255,0.18)}
.chat-input{flex:1;background:rgba(51,153,255,0.06);border:none;color:#D8EEFF;font-family:'Courier New',monospace;font-size:13px;padding:10px 12px;outline:none;min-width:0}
.chat-input::placeholder{color:rgba(51,153,255,0.4)}
.chat-input:focus{background:rgba(51,153,255,0.10)}
.chat-btn{background:rgba(255,32,32,0.18);border:none;border-left:1px solid rgba(255,32,32,0.3);color:#FF8888;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;padding:10px 16px;cursor:pointer;transition:all 0.2s;flex-shrink:0;white-space:nowrap}
.chat-btn:hover:not(:disabled){background:rgba(255,32,32,0.35);color:#FFFFFF}
.chat-btn:disabled{opacity:0.4;cursor:not-allowed}

/* WHALE PANEL */
.whalepanel{background:var(--pbg);border:1px solid rgba(0,255,200,0.25);border-radius:4px;padding:15px;margin-bottom:10px;box-shadow:0 0 20px rgba(0,255,180,0.06);position:relative;overflow:hidden}
.whalepanel::before{content:'';position:absolute;top:0;left:0;width:20px;height:20px;border-top:2px solid #00FFCC;border-left:2px solid #00FFCC;box-shadow:-2px -2px 8px rgba(0,255,200,0.3)}
.whalepanel::after{content:'';position:absolute;bottom:0;right:0;width:20px;height:20px;border-bottom:2px solid #00FFCC;border-right:2px solid #00FFCC;box-shadow:2px 2px 8px rgba(0,255,200,0.3)}
.whale-title{font-size:15px;letter-spacing:4px;color:#00FFCC;text-shadow:0 0 12px rgba(0,255,200,0.6);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(0,255,200,0.2);text-align:center}
.whale-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
.whale-box{border:1px solid rgba(0,255,200,0.15);background:rgba(0,255,200,0.02);border-radius:3px;padding:10px;text-align:center}
.whale-box-lbl{font-size:9px;letter-spacing:2px;color:rgba(0,255,200,0.4);display:block;margin-bottom:4px}
.whale-box-val{font-size:18px;font-weight:bold;display:block;letter-spacing:1px}
.whale-dir-BUY{color:#00FFCC;text-shadow:0 0 10px rgba(0,255,200,0.7)}
.whale-dir-SELL{color:#FF2020;text-shadow:0 0 10px rgba(255,32,32,0.7)}
.whale-dir-NONE{color:rgba(0,255,200,0.3)}
/* Order book depth bars */
.ob-section{margin:10px 0}
.ob-title{font-size:9px;letter-spacing:2px;color:rgba(0,255,200,0.4);margin-bottom:6px;text-align:center}
.ob-bars{display:flex;gap:6px;align-items:center;height:30px}
.ob-bid-bar{background:linear-gradient(90deg,rgba(0,255,100,0.15),rgba(0,255,100,0.4));border:1px solid rgba(0,255,100,0.3);border-radius:2px;height:100%;transition:width 0.6s ease;min-width:2px}
.ob-ask-bar{background:linear-gradient(90deg,rgba(255,50,50,0.4),rgba(255,50,50,0.15));border:1px solid rgba(255,50,50,0.3);border-radius:2px;height:100%;transition:width 0.6s ease;min-width:2px}
.ob-ratio{font-size:13px;font-weight:bold;letter-spacing:1px;white-space:nowrap;min-width:50px;text-align:center}
.ob-labels{display:flex;justify-content:space-between;font-size:9px;color:rgba(0,255,200,0.3);letter-spacing:1px;margin-top:3px}
/* Whale feed */
.whale-feed{border:1px solid rgba(0,255,200,0.12);border-radius:2px;overflow:hidden;margin-top:10px}
.whale-feed-hdr{font-size:9px;letter-spacing:2px;color:rgba(0,255,200,0.5);padding:4px 8px;background:rgba(0,255,200,0.04);border-bottom:1px solid rgba(0,255,200,0.12);display:flex;justify-content:space-between}
.whale-feed-body{max-height:140px;overflow-y:auto;padding:4px}
.whale-feed-body::-webkit-scrollbar{width:3px}
.whale-feed-body::-webkit-scrollbar-thumb{background:rgba(0,255,200,0.2)}
.whale-entry{display:flex;align-items:center;gap:8px;padding:3px 5px;border-radius:2px;font-size:10px;border-left:2px solid transparent;margin-bottom:2px}
.whale-entry.BUY{border-left-color:#00FFCC;background:rgba(0,255,200,0.03)}
.whale-entry.SELL{border-left-color:#FF2020;background:rgba(255,32,32,0.03)}
.whale-entry-dir{font-weight:bold;letter-spacing:1px;min-width:32px}
.whale-entry-dir.BUY{color:#00FFCC}
.whale-entry-dir.SELL{color:#FF2020}
.whale-entry-amt{color:rgba(200,255,240,0.7)}
.whale-entry-label{font-size:8px;color:rgba(0,255,200,0.5);flex:1;text-align:center;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.whale-entry-ts{font-size:8px;color:rgba(0,255,200,0.3)}
.no-whale{text-align:center;color:rgba(0,255,200,0.2);font-size:10px;padding:16px;letter-spacing:2px}
/* Large tx alert */
.largetx-row{display:flex;gap:6px;margin-top:8px}
.largetx-box{flex:1;border:1px solid rgba(0,255,200,0.12);background:rgba(0,255,200,0.02);border-radius:2px;padding:6px;text-align:center}
.largetx-lbl{font-size:8px;letter-spacing:1px;color:rgba(0,255,200,0.35);display:block;margin-bottom:3px}
.largetx-val{font-size:14px;font-weight:bold;display:block;letter-spacing:1px;color:rgba(0,255,200,0.5)}
.largetx-val.hot{color:#00FFCC;text-shadow:0 0 8px rgba(0,255,200,0.5)}

/* WIN RATE / LIQUIDITY / VOLATILITY in risk panel */
.winrate-gauge{display:flex;align-items:center;gap:6px;margin:4px 0}
.winrate-bar{flex:1;height:7px;background:rgba(34,136,255,0.07);border:1px solid rgba(34,136,255,0.2);border-radius:1px;overflow:hidden}
.winrate-fill{height:100%;border-radius:1px;transition:width 0.6s ease}
.winrate-warn{font-size:9px;text-align:center;padding:3px 6px;border-radius:2px;margin:3px 0;letter-spacing:1px;display:none}
.winrate-warn.on{display:block;color:#FF8800;border:1px solid rgba(255,136,0,0.35);background:rgba(255,136,0,0.06)}
.liq-warn{font-size:9px;text-align:center;padding:3px 6px;border-radius:2px;margin:3px 0;letter-spacing:1px;display:none}
.liq-warn.on{display:block;color:#FF2020;border:1px solid rgba(255,32,32,0.35);background:rgba(255,32,32,0.06)}

/* THREE NEWS TICKERS */
.newstickers-wrap{margin-bottom:10px;display:flex;flex-direction:column;gap:2px}
.nticker-row{display:flex;align-items:center;background:var(--pbg);border:1px solid rgba(34,136,255,0.15);border-radius:3px;overflow:hidden;height:26px}
.nticker-badge{font-size:8px;letter-spacing:2px;padding:0 8px;white-space:nowrap;border-right:1px solid rgba(34,136,255,0.18);height:100%;display:flex;align-items:center;flex-shrink:0;min-width:50px;justify-content:center}
.nticker-row.nw .nticker-badge{color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.03);border-right-color:rgba(255,255,255,0.15)}
.nticker-row.ny .nticker-badge{color:#FFDD00;background:rgba(255,221,0,0.04);border-right-color:rgba(255,221,0,0.2);text-shadow:0 0 8px rgba(255,221,0,0.5)}
.nticker-row.nc .nticker-badge{color:#00FFCC;background:rgba(0,255,200,0.03);border-right-color:rgba(0,255,200,0.2);text-shadow:0 0 8px rgba(0,255,200,0.4)}
.nticker-outer{overflow:hidden;flex:1;white-space:nowrap}
.nticker-inner{display:inline-block;animation:rticker 100s linear infinite;white-space:nowrap;font-size:11px;letter-spacing:0.3px}
.nticker-inner:hover{animation-play-state:paused;cursor:default}
.nticker-row.nw .nticker-inner{color:rgba(230,240,255,0.75)}
.nticker-row.ny .nticker-inner{color:rgba(255,230,50,0.85)}
.nticker-row.nc .nticker-inner{color:rgba(0,255,200,0.85)}
.nticker-item{display:inline-block;padding:0 28px}
.nticker-item::before{content:'⬡  ';font-size:8px;opacity:0.5}

/* MOBILE TAB NAV */
.mobile-nav{display:none}
@media(max-width:768px){
  body{font-size:14px;padding-bottom:70px}
  .wrap{padding:6px}
  .topbar{flex-wrap:wrap;gap:6px;padding:8px 10px}
  .ethbig{font-size:24px}
  .logo{font-size:14px;letter-spacing:2px}
  .panels{grid-template-columns:1fr;gap:6px;margin-bottom:6px}
  .panel{padding:12px}
  .ptitle{font-size:13px;letter-spacing:2px}
  .chart-price-wrap{height:180px}
  .chart-rsi-wrap{height:70px}
  .chartsec{padding:10px}
  .balgrid{grid-template-columns:1fr 1fr}
  .rte-grid{grid-template-columns:1fr 1fr}
  .mini-row{flex-direction:column}
  .perfgrid{grid-template-columns:1fr 1fr 1fr}
  .chat-msgs{max-height:160px}
  .rtlog-body{max-height:260px}
  .mobile-nav{
    display:flex;position:fixed;bottom:0;left:0;right:0;z-index:999;
    background:#030912;border-top:1px solid rgba(34,136,255,0.28);
    box-shadow:0 -4px 20px rgba(0,0,0,0.7);
    padding-bottom:env(safe-area-inset-bottom,0);
  }
  .mnav-btn{
    flex:1;background:none;border:none;color:rgba(34,136,255,0.45);
    font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    cursor:pointer;transition:all 0.2s;gap:2px;padding:10px 0;
    border-top:2px solid transparent;
  }
  .mnav-btn.active{color:#3399FF;border-top-color:#3399FF;text-shadow:0 0 8px rgba(51,153,255,0.6);background:rgba(34,136,255,0.06)}
  .mnav-btn:hover:not(.active){color:rgba(34,136,255,0.7)}
  .mnav-icon{font-size:20px;line-height:1}
  .mnav-lbl{font-size:9px;letter-spacing:1px}
}
</style>
</head>
<body>
<div class="wrap">

<div class="topbar">
  <div class="logo">&#x2B21; OPTIMUSMEGAPRIME</div>
  <div class="status-row">
    <div class="ast"><div class="dot" id="d-analyst"></div><span>ANALYST</span></div>
    <div class="ast"><div class="dot" id="d-trade"></div><span>TRADE</span></div>
    <div class="ast"><div class="dot" id="d-risk"></div><span>RISK</span></div>
  </div>
  <div>
    <div class="ethlbl">ETH / USDC</div>
    <div class="ethbig" id="top-price">$-.--</div>
  </div>
  <div>
    <div class="ts" id="top-time">--:--:-- UTC</div>
    <div class="ts" style="margin-top:4px" id="top-date">----/--/--</div>
  </div>
</div>

<div class="panels">

  <!-- ANALYST -->
  <div class="panel" data-tab="analyst">
    <div class="ptitle">ANALYST//CLAW<span class="mtag">claude-sonnet-4-6 &middot; 1M CANDLES + LIVE TICKS</span></div>
    <div class="rsiwrap">
      <canvas id="rsi-gauge" width="160" height="90"></canvas>
      <div class="rsinum" id="rsi-num">--</div>
    </div>
    <div id="sig-badge" class="sig HOLD">HOLD</div>
    <div class="sb" id="str-bar">
      <div class="sp"></div><div class="sp"></div><div class="sp"></div>
    </div>
    <div class="div"></div>
    <div class="dr"><span class="dl">SIGNAL SOURCE</span><span class="dv" id="a-src" style="font-size:9px;letter-spacing:2px">--</span></div>
    <div class="dr"><span class="dl">LATENCY</span><span class="dv" id="a-latency" style="font-size:9px">-- ms</span></div>
    <div class="srcpills" id="a-srcpills">
      <span class="pill" id="pill-candles">CB-CANDLES</span>
      <span class="pill" id="pill-trades">CB-TRADES</span>
      <span class="pill" id="pill-fng">FEAR/GREED</span>
      <span class="pill" id="pill-cg">COINGECKO</span>
      <span class="pill" id="pill-es">ETHERSCAN</span>
    </div>
    <div class="div"></div>
    <div class="dr"><span class="dl">CANDLE CLOSE</span><span class="dv" id="a-price">$-.--</span></div>
    <div class="tickprice">LIVE TICK &nbsp;<span id="a-tickprice">--</span></div>
    <div class="dr"><span class="dl">EMA 9/21/50</span><span class="dv" id="a-ema" style="font-size:9px;letter-spacing:0">--/--/--</span></div>
    <div class="dr"><span class="dl">BB UPPER/MID/LOWER</span><span class="dv" id="a-bb" style="font-size:9px;letter-spacing:0;color:#00CCFF">--/--/--</span></div>
    <div class="div"></div>
    <div class="dr"><span class="dl">TICKS BUFFERED</span><span class="dv" id="a-ticks">--</span></div>
    <div class="dr"><span class="dl">TICK B/S RATIO</span><span class="dv" id="a-bsratio">-.-x</span></div>
    <div class="dr"><span class="dl">TICK MOMENTUM</span><span class="dv" id="a-momentum">--%</span></div>
    <div class="div"></div>
    <div class="dr"><span class="dl">MARKET 24H</span><span class="dv" id="a-mkt24h">--%</span></div>
    <div class="dr"><span class="dl">GAS (FAST)</span><span class="dv" id="a-gas">-- gwei</span></div>
    <div class="dr"><span class="dl">VOLUME RATIO</span><span class="dv" id="a-vol">-.-x</span></div>
    <div class="voltrack"><div class="volfill" id="vol-bar" style="width:0%"></div></div>
    <div class="div"></div>
    <div class="fng-gauge-wrap">
      <div class="mini-lbl" style="letter-spacing:2px;margin-bottom:4px">FEAR / GREED</div>
      <div class="fng-gauge-arc">
        <div class="fng-arc-bg"></div>
        <div class="fng-arc-needle" id="fng-needle" style="transform:rotate(-90deg)"></div>
      </div>
      <span class="fng-arc-val" id="a-fng-val">--</span>
      <span class="fng-arc-lbl" id="a-fng-lbl">--</span>
    </div>
    <div class="div"></div>
    <div class="fibsec">
      <div class="fibtitle">FIBONACCI RETRACEMENT</div>
      <div class="dr" style="margin-bottom:4px"><span class="dl">NEAREST LEVEL</span><span class="dv" id="a-fibprox" style="font-size:9px;color:#44AAFF">--</span></div>
      <div id="fib-bars"></div>
    </div>
    <div class="reason" id="a-reason">Awaiting signal data...</div>
  </div>

  <!-- TRADE -->
  <div class="panel" data-tab="trade">
    <div class="ptitle">TRADE//CLAW<span class="mtag">claude-opus-4-6 &middot; EXECUTOR</span></div>

    <!-- Signal context from AnalystClaw -->
    <div class="sigctx">
      <div class="sigctx-top">
        <span class="sigctx-badge HOLD" id="tc-signal">HOLD</span>
        <span class="sigctx-age" id="tc-sig-age">--</span>
      </div>
      <div class="sigctx-strength" id="tc-strength">-- STRENGTH</div>
      <div class="sigctx-reason" id="tc-reason">Awaiting signal...</div>
    </div>

    <!-- Mini RSI gauge + Fear/Greed -->
    <div class="mini-row">
      <div class="mini-box">
        <span class="mini-lbl">RSI-14</span>
        <canvas id="rsi-gauge-t" width="86" height="50"></canvas>
        <span class="mini-rsi-num" id="tc-rsi" style="color:#2288FF">--</span>
      </div>
      <div class="mini-box">
        <span class="mini-lbl">FEAR / GREED</span>
        <span class="mini-val" id="tc-fng-val">--</span>
        <span class="mini-sub" id="tc-fng-lbl">--</span>
      </div>
    </div>

    <!-- Fib proximity bar -->
    <div class="fibprox">
      <div class="fibprox-hdr">
        <span class="fibprox-lbl">NEAREST FIB LEVEL</span>
        <span class="fibprox-val" id="tc-fib-info" style="color:rgba(34,136,255,0.4)">--</span>
      </div>
      <div class="fibprox-track"><div class="fibprox-fill far" id="tc-fib-bar" style="width:0%"></div></div>
    </div>

    <!-- Cooldown timer -->
    <div class="cooldown">
      <div class="cooldown-hdr">
        <span class="cooldown-lbl">TRADE COOLDOWN &nbsp;(15m min)</span>
        <span class="cooldown-val ready" id="tc-cooldown-txt">READY</span>
      </div>
      <div class="cooldown-track"><div class="cooldown-fill ready" id="tc-cooldown-bar" style="width:100%"></div></div>
    </div>

    <div class="div"></div>

    <!-- Balances -->
    <div class="balgrid">
      <div class="balbox"><span class="ballbl">USDC</span><span class="balval" id="t-usdc">-.--</span></div>
      <div class="balbox"><span class="ballbl">ETH</span><span class="balval" id="t-eth">-.----</span></div>
    </div>

    <!-- Portfolio + Session P&L -->
    <div class="pnlrow">
      <div class="pnlhalf">
        <span class="pnlhalf-lbl">PORTFOLIO</span>
        <span class="pnlhalf-val" id="t-portval" style="color:var(--c)">$--.--</span>
      </div>
      <div class="pnlhalf">
        <span class="pnlhalf-lbl">SESSION P&amp;L</span>
        <span class="pnlhalf-val" id="tc-pnl" style="color:var(--c)">--</span>
      </div>
    </div>

    <!-- Performance stats -->
    <div class="perfgrid">
      <div class="perfbox"><span class="perflbl">EXECUTED</span><span class="perfval" id="t-exec">0</span></div>
      <div class="perfbox"><span class="perflbl">WIN RATE</span><span class="perfval" id="tc-winrate">N/A</span></div>
      <div class="perfbox"><span class="perflbl">AVG DUR</span><span class="perfval" id="tc-avgdur">N/A</span></div>
    </div>

    <div class="dr"><span class="dl">SIGNALS SKIPPED</span><span class="dv skiptag" id="t-skip">0</span></div>
    <div class="dr"><span class="dl">STATUS</span><span class="dv" id="t-status">IDLE</span></div>
    <div class="wallet" id="t-wallet">--</div>

    <div class="rtlog">
      <div class="rtlog-hdr"><span>&#9658; TRADE LOG &nbsp;(LAST 50)</span><span id="rtlog-count" style="color:rgba(34,136,255,0.3)">0 TRADES</span></div>
      <div class="rtlog-body" id="rtlog-body"><div class="no-trades">NO TRADES YET</div></div>
    </div>
  </div>

  <!-- RISK -->
  <div class="panel" data-tab="risk">
    <div class="ptitle">RISK//CLAW<span class="mtag">claude-haiku-4-5 &middot; GUARDIAN</span></div>
    <span class="portval" id="r-portval">$--.----</span>
    <span class="portlbl">PORTFOLIO VALUE</span>
    <div class="dr"><span class="dl">PEAK VALUE</span><span class="dv" id="r-peak">$--.----</span></div>
    <div class="dr"><span class="dl">ETH PRICE</span><span class="dv" id="r-ethprice">$-.--</span></div>
    <div class="div"></div>
    <div class="dr"><span class="dl">DRAWDOWN</span><span class="dv" id="r-dd">0.00%</span></div>
    <div class="ddtrack"><div class="ddfill" id="r-ddbar" style="width:0%;background:#44AAFF"></div></div>
    <div class="div"></div>
    <div class="dr"><span class="dl">TRADE COUNT</span><span class="dv" id="r-trades">0</span></div>
    <div class="dr"><span class="dl">PENDING SIGNAL</span><span class="dv" id="r-pending">--</span></div>
    <div class="dr"><span class="dl">POSITION SIZE</span><span class="dv" id="r-possize">0%</span></div>
    <div class="div"></div>
    <div class="chk"><span class="dl">DRAWDOWN CHECK</span><span class="ok" id="chk-dd">&#10003; OK</span></div>
    <div class="chk"><span class="dl">POSITION CHECK</span><span class="ok" id="chk-pos">&#10003; OK</span></div>
    <div class="halt" id="r-halt">&#9888; SYSTEM HALTED</div>
    <div class="haltreason" id="r-haltreason"></div>

    <div class="div"></div>
    <!-- Win rate -->
    <div class="dr"><span class="dl">WIN RATE</span><span class="dv" id="r-winrate">N/A</span></div>
    <div class="winrate-gauge">
      <div class="winrate-bar"><div id="r-winrate-bar" class="winrate-fill" style="width:0%;background:#44AAFF"></div></div>
    </div>
    <div class="dr"><span class="dl">AVG P&amp;L / TRADE</span><span class="dv" id="r-avgpnl">N/A</span></div>
    <div class="dr"><span class="dl">STREAK</span><span class="dv" id="r-streak">--</span></div>
    <div class="winrate-warn" id="r-winrate-warn">&#9888; WIN RATE &lt;40% &nbsp;(LAST 10 TRADES)</div>
    <div class="div"></div>
    <!-- Liquidity + Volatility -->
    <div class="dr"><span class="dl">LIQUIDITY DEPTH</span><span class="dv" id="r-liquidity">--</span></div>
    <div class="liq-warn" id="r-liq-warn">&#9888; LOW LIQUIDITY — TRADE SKIP ACTIVE</div>
    <div class="dr"><span class="dl">VOLATILITY REGIME</span><span class="dv" id="r-vol-regime">NORMAL</span></div>
    <div class="dr"><span class="dl">POSITION MULTIPLIER</span><span class="dv" id="r-vol-mult">1.0x</span></div>

    <!-- LIVE NEWS TICKER -->
    <div class="risk-ticker">
      <div class="risk-ticker-hdr">
        <span>&#9658; LIVE FEED &nbsp;ETH / USDC</span>
        <span id="ticker-status" style="font-size:8px;color:rgba(255,100,100,0.5);letter-spacing:1px">LOADING...</span>
      </div>
      <div class="ticker-outer">
        <div class="ticker-inner" id="news-ticker">
          <span class="ticker-item">Connecting to market feed...</span>
          <span class="ticker-item">OptimusMegaPrime risk monitor active</span>
          <span class="ticker-item">Connecting to market feed...</span>
          <span class="ticker-item">OptimusMegaPrime risk monitor active</span>
        </div>
      </div>
    </div>

    <!-- RISKCLAW CHAT -->
    <div class="risk-chat">
      <div class="chat-hdr">
        <span>&#9658; RISKCLAW CHAT</span>
        <span style="font-size:8px;color:rgba(255,100,100,0.7);letter-spacing:1px">HAIKU-4.5 // LIVE</span>
      </div>
      <div class="chat-msgs" id="chat-msgs">
        <div class="chat-msg sys">RiskClaw online. Portfolio guardian active. Ask me anything about risk, markets, or strategy.</div>
      </div>
      <div class="chat-row">
        <input type="text" id="chat-input" class="chat-input" placeholder="Ask RiskClaw..." onkeydown="if(event.key==='Enter')sendChat()">
        <button class="chat-btn" id="chat-btn" onclick="sendChat()">SEND</button>
      </div>
    </div>
  </div>

</div>

<div class="newstickers-wrap">
  <div class="nticker-row nw">
    <span class="nticker-badge">WORLD</span>
    <div class="nticker-outer"><div class="nticker-inner" id="ticker-bbc"><span class="nticker-item">Loading world news...</span></div></div>
  </div>
  <div class="nticker-row ny">
    <span class="nticker-badge">STOCKS</span>
    <div class="nticker-outer"><div class="nticker-inner" id="ticker-finance"><span class="nticker-item">Loading market news...</span></div></div>
  </div>
  <div class="nticker-row nc">
    <span class="nticker-badge">CRYPTO</span>
    <div class="nticker-outer"><div class="nticker-inner" id="ticker-crypto"><span class="nticker-item">Loading crypto news...</span></div></div>
  </div>
</div>

<div class="whalepanel" data-tab="analyst">
  <div class="whale-title">&#9650; WHALE &amp; ORDER FLOW</div>
  <div class="whale-grid">
    <div class="whale-box">
      <span class="whale-box-lbl">WHALE DIRECTION</span>
      <span class="whale-box-val whale-dir-NONE" id="w-direction">--</span>
    </div>
    <div class="whale-box">
      <span class="whale-box-lbl">SWAP VOLUME</span>
      <span class="whale-box-val" id="w-volume" style="color:rgba(0,255,200,0.6)">$--</span>
    </div>
    <div class="whale-box">
      <span class="whale-box-lbl">LARGE SWAPS</span>
      <span class="whale-box-val" id="w-count" style="color:rgba(0,255,200,0.6)">--</span>
    </div>
  </div>

  <div class="ob-section">
    <div class="ob-title">ORDER BOOK DEPTH &nbsp;(±0.5% of MID)</div>
    <div class="ob-bars">
      <div id="ob-bid-bar" class="ob-bid-bar" style="width:45%;flex-shrink:0"></div>
      <div class="ob-ratio" id="ob-ratio" style="color:rgba(0,255,200,0.5)">--</div>
      <div id="ob-ask-bar" class="ob-ask-bar" style="width:45%;flex-shrink:0"></div>
    </div>
    <div class="ob-labels"><span id="ob-bid-usd" style="color:rgba(0,255,100,0.5)">BID --</span><span id="ob-ask-usd" style="color:rgba(255,50,50,0.5)">ASK --</span></div>
  </div>

  <div class="largetx-row">
    <div class="largetx-box">
      <span class="largetx-lbl">L1 ETH → UNISWAP (SELL PRESSURE)</span>
      <span class="largetx-val" id="ltx-inflow">-- ETH</span>
    </div>
    <div class="largetx-box">
      <span class="largetx-lbl">L1 ETH ← UNISWAP (BUY PRESSURE)</span>
      <span class="largetx-val" id="ltx-outflow">-- ETH</span>
    </div>
  </div>

  <div class="whale-feed">
    <div class="whale-feed-hdr">
      <span>&#9658; RECENT LARGE SWAPS &nbsp;(&gt;$50K · UNISWAP V3 BASE)</span>
      <span id="w-feed-status" style="font-size:8px;color:rgba(0,255,200,0.3)">--</span>
    </div>
    <div class="whale-feed-body" id="w-feed-body">
      <div class="no-whale">AWAITING WHALE DATA...</div>
    </div>
  </div>
</div>

<div class="chartsec" data-tab="analyst" id="chart-section">
  <div class="chart-header">
    <div class="tf-bar" id="tf-bar">
      <button class="tf-btn" onclick="setTF('ALL')">ALL</button>
      <button class="tf-btn" onclick="setTF('5Y')">5Y</button>
      <button class="tf-btn" onclick="setTF('1Y')">1Y</button>
      <button class="tf-btn" onclick="setTF('1M')">1M</button>
      <button class="tf-btn" onclick="setTF('1W')">1W</button>
      <button class="tf-btn" onclick="setTF('1D')">1D</button>
      <button class="tf-btn" onclick="setTF('6H')">6H</button>
      <button class="tf-btn" onclick="setTF('1H')">1H</button>
      <button class="tf-btn" onclick="setTF('15M')">15M</button>
      <button class="tf-btn" onclick="setTF('5M')">5M</button>
      <button class="tf-btn active" onclick="setTF('LIVE')">LIVE</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:10px;color:rgba(34,136,255,0.3)" id="chart-ts">--</span>
      <button class="chart-fullscreen-btn" onclick="toggleFullscreen()" title="Fullscreen">&#x26F6;</button>
    </div>
  </div>
  <div class="ema-legend">
    <div class="ema-dot"><b style="background:#FFFFFF"></b>PRICE</div>
    <div class="ema-dot"><b style="background:#00FFFF"></b>EMA-9</div>
    <div class="ema-dot"><b style="background:#FFFF00"></b>EMA-21</div>
    <div class="ema-dot"><b style="background:#FF8800"></b>EMA-50</div>
    <div class="ema-dot"><b style="background:rgba(0,200,255,0.5)"></b>BB</div>
  </div>
  <div class="chartwrap" id="chartwrap">
    <div class="chart-price-wrap"><div id="price-chart" style="width:100%;height:100%"></div></div>
    <div class="chart-rsi-wrap"><span class="chart-sub-lbl">RSI-14</span><div id="rsi-subchart" style="width:100%;height:100%"></div></div>
  </div>
</div>

<nav class="mobile-nav">
  <button class="mnav-btn active" onclick="switchTab('analyst')" id="mnav-analyst">
    <span class="mnav-icon">◈</span><span class="mnav-lbl">ANALYST</span>
  </button>
  <button class="mnav-btn" onclick="switchTab('trade')" id="mnav-trade">
    <span class="mnav-icon">⚡</span><span class="mnav-lbl">TRADE</span>
  </button>
  <button class="mnav-btn" onclick="switchTab('risk')" id="mnav-risk">
    <span class="mnav-icon">⬡</span><span class="mnav-lbl">RISK</span>
  </button>
</nav>

</div>
<script>
var FIB_LVL  = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
var FIB_LBL  = ['0%','23.6%','38.2%','50%','61.8%','78.6%','100%'];
var FIB_CLR  = ['#FF2020','#FF6644','#FFFFFF','#00AAFF','#00FFFF','#88FFFF','#0055CC'];
var fibPrices = [];
var fibLines = [];
var chart = null, rsiSubchart = null;
var candleSeries = null, volSeries = null;
var ema9S = null, ema21S = null, ema50S = null;
var bbUpperS = null, bbMidS = null, bbLowS = null;
var rsiSeriesLW = null;
var currentTF = 'LIVE';
var TF_CONFIG = {
  'ALL':  { gran: 'ONE_WEEK',    from: 1535760000     },  // Sep 1, 2018 — USDC mainnet launch
  '5Y':   { gran: 'ONE_DAY',     fromOffset: 157680000 },  // 5*365*86400
  '1Y':   { gran: 'ONE_DAY',     fromOffset: 31536000  },  // 365*86400
  '1M':   { gran: 'SIX_HOUR',    fromOffset: 2592000   },  // 30*86400
  '1W':   { gran: 'ONE_HOUR',    fromOffset: 604800    },  // 7*86400
  '1D':   { gran: 'FIVE_MINUTE', fromOffset: 86400     },
  '6H':   { gran: 'ONE_MINUTE',  bars: 180             },
  '1H':   { gran: 'ONE_MINUTE',  bars: 60              },
  '15M':  { gran: 'ONE_MINUTE',  bars: 15              },
  '5M':   { gran: 'ONE_MINUTE',  bars: 5               },
  'LIVE': { gran: 'ONE_MINUTE',  bars: 200             },
};
var lastPrice = 0;

// Trade panel state
var COOLDOWN_MS = 15 * 60 * 1000;
var sessionStartPortfolio = null;
var lastTradeTsMs = 0;         // for cooldown calculation

var FIB_PCT_MAP = {0:'0%', 0.236:'23.6%', 0.382:'38.2%', 0.5:'50%', 0.618:'61.8%', 0.786:'78.6%', 1:'100%'};

function fibLabel(lvl) {
  if (lvl == null) return '--';
  var k = parseFloat(lvl);
  return FIB_PCT_MAP[k] || (k * 100).toFixed(1) + '%';
}

function calcEMASeries(values, period) {
  if (!values || values.length < period) return values.map(function(){ return null; });
  var k = 2 / (period + 1), result = [], ema = 0, i;
  for (i = 0; i < period; i++) ema += values[i];
  ema /= period;
  for (i = 0; i < period - 1; i++) result.push(null);
  result.push(parseFloat(ema.toFixed(2)));
  for (i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(parseFloat(ema.toFixed(2)));
  }
  return result;
}

// ── INDICATORS ─────────────────────────────────────────────────────────────
function calcBollingerBands(closes, period, mult) {
  period = period || 20; mult = mult || 2;
  var upper = [], middle = [], lower = [];
  for (var i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(null); middle.push(null); lower.push(null); continue; }
    var sl = closes.slice(i - period + 1, i + 1);
    var sma = sl.reduce(function(a,b){return a+b;},0) / period;
    var std = Math.sqrt(sl.reduce(function(a,b){return a+Math.pow(b-sma,2);},0)/period);
    upper.push(parseFloat((sma + mult*std).toFixed(2)));
    middle.push(parseFloat(sma.toFixed(2)));
    lower.push(parseFloat((sma - mult*std).toFixed(2)));
  }
  return { upper: upper, middle: middle, lower: lower };
}

function calcRSISeries(closes, period) {
  period = period || 14;
  var result = closes.map(function(){ return null; });
  if (closes.length < period + 1) return result;
  var gains = 0, losses = 0, i;
  for (i = 1; i <= period; i++) {
    var ch = closes[i] - closes[i-1];
    if (ch > 0) gains += ch; else losses -= ch;
  }
  gains /= period; losses /= period;
  result[period] = losses === 0 ? 100 : parseFloat((100 - 100/(1+gains/losses)).toFixed(2));
  for (i = period + 1; i < closes.length; i++) {
    var c = closes[i] - closes[i-1];
    gains  = (gains  * (period-1) + Math.max(0, c))  / period;
    losses = (losses * (period-1) + Math.max(0, -c)) / period;
    result[i] = losses === 0 ? 100 : parseFloat((100 - 100/(1+gains/losses)).toFixed(2));
  }
  return result;
}

// ── FULLSCREEN ──────────────────────────────────────────────────────────────
var isFullscreen = false;
function toggleFullscreen() {
  isFullscreen = !isFullscreen;
  var sec = document.getElementById('chart-section');
  sec.className = isFullscreen ? 'chartsec fullscreen' : 'chartsec';
  setTimeout(function() {
    var pw = document.getElementById('price-chart');
    var rw = document.getElementById('rsi-subchart');
    if (chart && pw) chart.resize(pw.clientWidth, pw.clientHeight || 340);
    if (rsiSubchart && rw) rsiSubchart.resize(rw.clientWidth, rw.clientHeight || 90);
  }, 80);
}

// ── TIMEFRAME ───────────────────────────────────────────────────────────────
function setTF(tf) {
  if (!TF_CONFIG[tf]) return;
  currentTF = tf;
  document.querySelectorAll('.tf-btn').forEach(function(b) {
    b.className = b.textContent.trim() === tf ? 'tf-btn active' : 'tf-btn';
  });
  loadCandles();
}

// ── CHART ──────────────────────────────────────────────────────────────────
function initChart() {
  var priceWrap = document.getElementById('price-chart');
  var rsiWrap   = document.getElementById('rsi-subchart');
  if (!priceWrap || !rsiWrap || typeof LightweightCharts === 'undefined') return;
  var LC = LightweightCharts;

  var baseOpts = {
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: 'rgba(0,200,255,0.5)',
      fontFamily: "'Courier New',monospace",
      fontSize: 9
    },
    grid: {
      vertLines: { color: 'rgba(34,136,255,0.05)' },
      horzLines: { color: 'rgba(34,136,255,0.05)' }
    },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: 'rgba(34,136,255,0.15)' },
    timeScale: {
      borderColor: 'rgba(34,136,255,0.15)',
      timeVisible: true, secondsVisible: false,
      rightOffset: 5, fixLeftEdge: false
    },
    handleScroll: true, handleScale: true
  };

  // Main price chart
  chart = LC.createChart(priceWrap, Object.assign({}, baseOpts, {
    width: priceWrap.clientWidth,
    height: priceWrap.clientHeight || 340,
    rightPriceScale: Object.assign({}, baseOpts.rightPriceScale, {
      scaleMargins: { top: 0.08, bottom: 0.28 }
    })
  }));

  // Volume histogram overlay (bottom 20%)
  volSeries = chart.addHistogramSeries({
    color: 'rgba(0,200,100,0.35)',
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    lastValueVisible: false,
    priceLineVisible: false
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.80, bottom: 0 }, visible: false });

  // Bollinger Bands (behind candles)
  bbUpperS = chart.addLineSeries({ color: 'rgba(0,200,255,0.4)',  lineWidth: 1, lineStyle: LC.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  bbMidS   = chart.addLineSeries({ color: 'rgba(0,200,255,0.18)', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  bbLowS   = chart.addLineSeries({ color: 'rgba(0,200,255,0.4)',  lineWidth: 1, lineStyle: LC.LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });

  // Candlestick series (on top of BB)
  candleSeries = chart.addCandlestickSeries({
    upColor: '#00CC88', downColor: '#FF2020',
    borderUpColor: '#00CC88', borderDownColor: '#FF2020',
    wickUpColor: 'rgba(0,204,136,0.7)', wickDownColor: 'rgba(255,32,32,0.7)',
    priceLineVisible: false
  });

  // EMA lines
  ema9S  = chart.addLineSeries({ color: '#00FFFF', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  ema21S = chart.addLineSeries({ color: '#FFFF00', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  ema50S = chart.addLineSeries({ color: '#FF8800', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });

  // RSI subchart
  rsiSubchart = LC.createChart(rsiWrap, Object.assign({}, baseOpts, {
    width: rsiWrap.clientWidth,
    height: rsiWrap.clientHeight || 90,
    timeScale: Object.assign({}, baseOpts.timeScale, { visible: false }),
    rightPriceScale: { borderColor: 'rgba(34,136,255,0.1)', textColor: 'rgba(180,100,255,0.5)' }
  }));

  rsiSeriesLW = rsiSubchart.addLineSeries({
    color: '#CC44FF', lineWidth: 1.5,
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false
  });
  rsiSeriesLW.createPriceLine({ price: 70, color: 'rgba(255,32,32,0.4)',  lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true,  title: '' });
  rsiSeriesLW.createPriceLine({ price: 30, color: 'rgba(255,32,32,0.4)',  lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true,  title: '' });
  rsiSeriesLW.createPriceLine({ price: 50, color: 'rgba(34,136,255,0.2)', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false, title: '' });

  // Sync time ranges
  chart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
    if (range && rsiSubchart) rsiSubchart.timeScale().setVisibleLogicalRange(range);
  });
  rsiSubchart.timeScale().subscribeVisibleLogicalRangeChange(function(range) {
    if (range && chart) chart.timeScale().setVisibleLogicalRange(range);
  });

  // Resize listener
  window.addEventListener('resize', function() {
    if (chart && priceWrap) chart.resize(priceWrap.clientWidth, priceWrap.clientHeight || 340);
    if (rsiSubchart && rsiWrap) rsiSubchart.resize(rsiWrap.clientWidth, rsiWrap.clientHeight || 90);
  });
}

async function loadCandles() {
  try {
    var tf = TF_CONFIG[currentTF] || TF_CONFIG['LIVE'];
    var url;
    if (tf.from !== undefined) {
      url = '/api/candles?granularity=' + tf.gran + '&from=' + tf.from;
      document.getElementById('chart-ts').textContent = currentTF + ' · LOADING ALL-TIME...';
    } else if (tf.fromOffset !== undefined) {
      var fromTs = Math.floor(Date.now() / 1000) - tf.fromOffset;
      url = '/api/candles?granularity=' + tf.gran + '&from=' + fromTs;
      document.getElementById('chart-ts').textContent = currentTF + ' · LOADING...';
    } else {
      url = '/api/candles?granularity=' + tf.gran + '&bars=' + tf.bars;
    }
    var res = await fetch(url);
    var data = await res.json();
    if (!data.candles || !data.candles.length) return;
    var candles = data.candles.slice().reverse();

    var times   = candles.map(function(c){ return parseInt(c.start); });
    var closes  = candles.map(function(c){ return parseFloat(c.close); });
    var opens   = candles.map(function(c){ return parseFloat(c.open); });
    var highs   = candles.map(function(c){ return parseFloat(c.high); });
    var lows    = candles.map(function(c){ return parseFloat(c.low); });
    var volumes = candles.map(function(c){ return parseFloat(c.volume); });

    var bb = calcBollingerBands(closes, 20, 2);
    var rsiArr = calcRSISeries(closes, 14);

    function toLineData(arr) {
      return arr.map(function(v, i) {
        return (v !== null && v !== undefined) ? { time: times[i], value: v } : null;
      }).filter(Boolean);
    }

    if (candleSeries) candleSeries.setData(candles.map(function(c, i) {
      return { time: times[i], open: opens[i], high: highs[i], low: lows[i], close: closes[i] };
    }));
    if (volSeries) volSeries.setData(candles.map(function(c, i) {
      return { time: times[i], value: volumes[i],
               color: closes[i] >= opens[i] ? 'rgba(0,200,100,0.45)' : 'rgba(255,50,50,0.45)' };
    }));
    if (ema9S)    ema9S.setData(toLineData(calcEMASeries(closes, 9)));
    if (ema21S)   ema21S.setData(toLineData(calcEMASeries(closes, 21)));
    if (ema50S)   ema50S.setData(toLineData(calcEMASeries(closes, 50)));
    if (bbUpperS) bbUpperS.setData(toLineData(bb.upper));
    if (bbMidS)   bbMidS.setData(toLineData(bb.middle));
    if (bbLowS)   bbLowS.setData(toLineData(bb.lower));
    if (rsiSeriesLW) rsiSeriesLW.setData(toLineData(rsiArr));

    document.getElementById('chart-ts').textContent = currentTF + ' · UPDATED ' + new Date().toISOString().substring(11,19) + ' UTC';

    // Update analyst panel BB values
    var last = closes.length - 1;
    if (bb.upper[last] !== null) {
      var bbEl = document.getElementById('a-bb');
      if (bbEl) bbEl.textContent = '$'+bb.upper[last].toFixed(0)+' / $'+bb.middle[last].toFixed(0)+' / $'+bb.lower[last].toFixed(0);
    }

    // Re-apply Fibonacci price lines with new data loaded
    if (fibPrices.length) setFibPrices(null, null);
    // Re-apply Nansen smart money markers
    applyNansenMarkers();
  } catch(e) { console.error('candle err', e); }
}

function setFibPrices(sh, sl) {
  if (sh !== null && sl !== null) {
    var range = sh - sl;
    fibPrices = FIB_LVL.map(function(l){ return sh - l * range; });
  }
  if (!candleSeries || !fibPrices.length) return;
  fibLines.forEach(function(line) { try { candleSeries.removePriceLine(line); } catch(e){} });
  fibLines = [];
  var LC = LightweightCharts;
  FIB_LVL.forEach(function(lvl, i) {
    var line = candleSeries.createPriceLine({
      price: fibPrices[i],
      color: FIB_CLR[i],
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: FIB_LBL[i]
    });
    fibLines.push(line);
  });
}

// ── RSI GAUGE ──────────────────────────────────────────────────────────────
// canvasId: canvas element id; textId: numeric readout element id (or null); showLabels: draw OS/OB text
function drawRSI(rsi, canvasId, textId, showLabels) {
  canvasId   = canvasId   || 'rsi-gauge';
  textId     = textId     !== undefined ? textId : 'rsi-num';
  showLabels = showLabels !== false;
  var cv = document.getElementById(canvasId);
  if (!cv) return;
  var cx2 = cv.getContext('2d'), w = cv.width, h = cv.height;
  var cx = w/2, cy = h * 0.88, r2 = w * 0.38;
  var lw = Math.max(4, Math.round(w * 0.065));
  cx2.clearRect(0, 0, w, h);

  function arc(s, e, col, lw2, lc) {
    cx2.beginPath();
    cx2.arc(cx, cy, r2, Math.PI + (s/100)*Math.PI, Math.PI + (e/100)*Math.PI);
    cx2.strokeStyle = col; cx2.lineWidth = lw2 || lw;
    cx2.lineCap = lc || 'butt'; cx2.stroke();
  }

  arc(0, 100, 'rgba(34,136,255,0.10)');
  arc(0, 30,  'rgba(255,32,32,0.40)');
  arc(30, 70, 'rgba(34,136,255,0.15)');
  arc(70, 100,'rgba(255,32,32,0.40)');

  if (rsi !== null && !isNaN(rsi)) {
    var col = (rsi < 30 || rsi > 70) ? '#FF2020' : '#2288FF';
    cx2.shadowBlur = 15; cx2.shadowColor = col;
    arc(0, rsi, col, lw, 'round');
    cx2.shadowBlur = 0;
    var ang = Math.PI + (rsi/100)*Math.PI;
    cx2.beginPath();
    cx2.arc(cx + r2*Math.cos(ang), cy + r2*Math.sin(ang), Math.max(2, lw*0.4), 0, Math.PI*2);
    cx2.fillStyle = col; cx2.shadowBlur = 8; cx2.shadowColor = col;
    cx2.fill(); cx2.shadowBlur = 0;
  }

  if (showLabels) {
    cx2.font = '8px Courier New'; cx2.textAlign = 'left';
    cx2.fillStyle = 'rgba(255,32,32,0.5)';
    cx2.fillText('OS', cx - r2 - 4, cy + 3);
    cx2.textAlign = 'right';
    cx2.fillText('OB', cx + r2 + 4, cy + 3);
    cx2.textAlign = 'left';
  }

  if (textId) {
    var el = document.getElementById(textId);
    if (el) {
      el.textContent = rsi !== null ? rsi.toFixed(1) : '--';
      var col2 = (rsi !== null && (rsi < 30 || rsi > 70)) ? '#FF2020' : '#2288FF';
      el.style.color = col2;
      el.style.textShadow = '0 0 10px ' + col2;
    }
  }
}

// ── FIB BARS ───────────────────────────────────────────────────────────────
function renderFibBars(price, sh, sl, nearLvl) {
  var range = sh - sl;
  var cont = document.getElementById('fib-bars');
  cont.innerHTML = '';
  FIB_LVL.forEach(function(lvl, i) {
    var fp = sh - lvl * range;
    var prox = Math.max(0, 1 - Math.abs(price - fp) / (range * 0.5));
    var isNear = Math.abs(lvl - nearLvl) < 0.001;
    var row = document.createElement('div');
    row.className = 'fibrow';
    row.innerHTML =
      '<span class="fiblbl">' + FIB_LBL[i] + '</span>' +
      '<div class="fibtrack"><div class="fibfill' + (isNear ? ' near' : '') + '" style="width:' + Math.round(prox*100) + '%"></div></div>' +
      '<span class="fibprice">$' + fp.toFixed(0) + '</span>';
    cont.appendChild(row);
  });
}

// ── STRENGTH ───────────────────────────────────────────────────────────────
function updateStrength(s) {
  var pips = document.querySelectorAll('.sp');
  var n = s === 'STRONG' ? 3 : s === 'MODERATE' ? 2 : s === 'WEAK' ? 1 : 0;
  pips.forEach(function(p, i) {
    p.className = 'sp' + (i < n ? ' a ' + s : '');
  });
}

// ── DOT STATUS ─────────────────────────────────────────────────────────────
function updateDot(id, state) {
  var dot = document.getElementById(id);
  if (!state || !state.timestamp) { dot.className = 'dot off'; return; }
  // Analyst runs every 1 min — stale if >3 min. Trade/Risk have slower cadence — 5 min.
  var limit = (id === 'd-analyst') ? 180000 : 300000;
  dot.className = (Date.now() - new Date(state.timestamp).getTime() < limit) ? 'dot' : 'dot off';
}

// ── ANALYST PANEL ──────────────────────────────────────────────────────────
function updateAnalyst(a) {
  if (!a) return;
  lastPrice = a.price;

  // Top bar price: prefer live tick, fall back to candle close
  var displayPrice = (a.latestTickPrice != null) ? a.latestTickPrice : a.price;
  document.getElementById('top-price').textContent = '$' + displayPrice.toFixed(2);

  document.getElementById('a-price').textContent  = '$' + a.price.toFixed(2);
  document.getElementById('a-reason').textContent = a.reason || '--';
  document.getElementById('a-vol').textContent    = (a.volumeRatio||0).toFixed(2) + 'x';
  document.getElementById('vol-bar').style.width  = Math.min(100, a.volumeRatio * 80) + '%';

  // Tick price secondary display
  var tp = document.getElementById('a-tickprice');
  if (a.latestTickPrice != null) {
    tp.textContent = '$' + a.latestTickPrice.toFixed(2);
    tp.style.color = a.latestTickPrice > a.price ? '#44AAFF' : a.latestTickPrice < a.price ? '#FF2020' : '#2288FF';
  } else {
    tp.textContent = 'no ticks yet';
    tp.style.color = 'rgba(34,136,255,0.3)';
  }

  // Signal source + latency
  var srcEl = document.getElementById('a-src');
  srcEl.textContent = a.llmAnalysis ? 'LLM \u2713' : 'HOLD (no LLM)';
  srcEl.style.color = a.llmAnalysis ? '#44AAFF' : '#FF5522';
  document.getElementById('a-latency').textContent = a.analysisMs !== undefined ? a.analysisMs + ' ms' : '--';

  // Source pills
  var active = a.dataSourcesActive || [];
  var pillMap = { 'coinbase-candles':'pill-candles', 'coinbase-trades':'pill-trades',
                  'fear-greed':'pill-fng', 'coingecko':'pill-cg', 'etherscan':'pill-es' };
  Object.keys(pillMap).forEach(function(src) {
    var el = document.getElementById(pillMap[src]);
    if (el) el.className = 'pill' + (active.indexOf(src) >= 0 ? ' on' : '');
  });

  // EMAs
  if (a.ema9 && a.ema21 && a.ema50) {
    document.getElementById('a-ema').textContent =
      '$' + a.ema9.toFixed(0) + ' / $' + a.ema21.toFixed(0) + ' / $' + a.ema50.toFixed(0);
  }

  // Tick stats
  document.getElementById('a-ticks').textContent = a.tickCount !== undefined ? a.tickCount + ' trades' : '--';

  var bsr = document.getElementById('a-bsratio');
  if (a.tickBuySellRatio != null) {
    bsr.textContent = a.tickBuySellRatio.toFixed(2) + 'x';
    bsr.className   = 'dv' + (a.tickBuySellRatio > 1.2 ? ' g' : a.tickBuySellRatio < 0.8 ? ' r' : '');
  } else { bsr.textContent = 'N/A'; bsr.className = 'dv'; }

  var mom = document.getElementById('a-momentum');
  if (a.tickMomentumPct != null) {
    mom.textContent = (a.tickMomentumPct >= 0 ? '+' : '') + a.tickMomentumPct.toFixed(3) + '%';
    mom.className   = 'dv' + (a.tickMomentumPct > 0 ? ' g' : a.tickMomentumPct < 0 ? ' r' : '');
  } else { mom.textContent = 'N/A'; mom.className = 'dv'; }

  // External data
  var mkt = document.getElementById('a-mkt24h');
  if (a.marketChange24h != null) {
    mkt.textContent = (a.marketChange24h >= 0 ? '+' : '') + a.marketChange24h.toFixed(2) + '%';
    mkt.className   = 'dv' + (a.marketChange24h >= 0 ? ' g' : ' r');
  } else { mkt.textContent = 'N/A'; mkt.className = 'dv'; }

  document.getElementById('a-gas').textContent = a.gasGwei != null ? a.gasGwei + ' gwei' : 'N/A';

  // F&G gauge
  if (a.fearGreedValue != null) {
    var fngV = a.fearGreedValue;
    var fngColor = fngV >= 75 ? '#00FFFF' : fngV >= 55 ? '#44AAFF' : fngV >= 45 ? '#FFFFFF' : fngV >= 25 ? '#FF8800' : '#FF2020';
    var fngAngle = -90 + (fngV / 100) * 180;
    var needle = document.getElementById('fng-needle');
    if (needle) { needle.style.transform = 'rotate(' + fngAngle + 'deg)'; needle.style.background = 'linear-gradient(to top,' + fngColor + ',rgba(255,255,255,0))'; needle.style.boxShadow = '0 0 8px ' + fngColor; }
    var fngValEl = document.getElementById('a-fng-val');
    var fngLblEl = document.getElementById('a-fng-lbl');
    if (fngValEl) { fngValEl.textContent = fngV; fngValEl.style.color = fngColor; fngValEl.style.textShadow = '0 0 10px ' + fngColor; }
    if (fngLblEl) fngLblEl.textContent = a.fearGreedLabel || '--';
  }

  // Fib proximity
  if (a.swingHigh && a.swingLow && a.nearestFibLevel != null) {
    var range = a.swingHigh - a.swingLow;
    var nearPrice = a.nearestFibPrice || (a.swingHigh - range * a.nearestFibLevel);
    var distPct = range > 0 ? (Math.abs(a.price - nearPrice) / range * 100).toFixed(1) : '--';
    var lvlStr = FIB_LBL[FIB_LVL.indexOf(a.nearestFibLevel)] || (a.nearestFibLevel*100).toFixed(1)+'%';
    var fpEl = document.getElementById('a-fibprox');
    if (fpEl) fpEl.textContent = lvlStr + '  $' + nearPrice.toFixed(0) + '  ±' + distPct + '% of range';
  }

  // Signal badge
  var sig = document.getElementById('sig-badge');
  sig.className   = 'sig ' + (a.signal || 'HOLD');
  sig.textContent = (a.signal || 'HOLD') + ' \u00B7 ' + (a.strength || '--');

  updateStrength(a.strength);
  drawRSI(a.rsi, 'rsi-gauge', 'rsi-num', true);
  if (a.swingHigh && a.swingLow) {
    renderFibBars(a.price, a.swingHigh, a.swingLow, a.nearestFibLevel);
    setFibPrices(a.swingHigh, a.swingLow);
  }
}

// ── TRADE PANEL ────────────────────────────────────────────────────────────
function fmtAge(tsIso) {
  if (!tsIso) return '--';
  var s = Math.floor((Date.now() - new Date(tsIso).getTime()) / 1000);
  if (s < 0) s = 0;
  if (s < 60)  return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's ago';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm ago';
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return 'N/A';
  var s = Math.floor(ms / 1000);
  if (s < 60)   return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

function computePerf(tradeLog) {
  if (!tradeLog || !tradeLog.length) return { winRate: 'N/A', avgDur: 'N/A' };
  var sells = tradeLog.filter(function(t) { return t.action === 'SELL' && t.pnlUsd !== null && t.pnlUsd !== undefined; });
  if (!sells.length) return { winRate: 'N/A', avgDur: 'N/A' };
  var wins = sells.filter(function(t) { return t.pnlUsd > 0; }).length;
  var winRate = ((wins / sells.length) * 100).toFixed(0) + '%';
  var buys = tradeLog.filter(function(t) { return t.action === 'BUY'; });
  var durs = [];
  for (var i = 0; i < Math.min(buys.length, sells.length); i++) {
    var dur = new Date(sells[i].timestamp).getTime() - new Date(buys[i].timestamp).getTime();
    if (dur > 0) durs.push(dur);
  }
  var avgDur = durs.length ? fmtDuration(durs.reduce(function(a,b){return a+b;},0)/durs.length) : 'N/A';
  return { winRate: winRate, avgDur: avgDur };
}

function renderTradeLog(trades) {
  var body = document.getElementById('rtlog-body');
  var countEl = document.getElementById('rtlog-count');
  if (!body) return;
  if (!trades || !trades.length) {
    body.innerHTML = '<div class="no-trades">NO TRADES YET</div>';
    if (countEl) countEl.textContent = '0 TRADES';
    return;
  }
  if (countEl) countEl.textContent = trades.length + ' TRADE' + (trades.length !== 1 ? 'S' : '');
  var shown = trades.slice(-50).reverse();
  var html = shown.map(function(tr) {
    var ts = tr.timestamp ? new Date(tr.timestamp) : null;
    var tsStr = ts ? ts.toISOString().replace('T',' ').substring(0,19) + ' UTC' : '--';
    var hasPnl = tr.pnlUsd !== null && tr.pnlUsd !== undefined;
    var pnlClass = hasPnl ? (tr.pnlUsd >= 0 ? 'profit' : 'loss') : 'open';
    var pnlStr = hasPnl
      ? (tr.pnlUsd >= 0 ? '+$' : '-$') + Math.abs(tr.pnlUsd).toFixed(4) + ' (' + (tr.pnlPct||'') + ')'
      : 'OPEN POSITION';
    var isBuy = tr.action === 'BUY';
    var entryStr  = tr.entryPriceUsd  ? '$' + parseFloat(tr.entryPriceUsd).toFixed(2)  : '--';
    var exitStr   = tr.exitPriceUsd   ? '$' + parseFloat(tr.exitPriceUsd).toFixed(2)   : '--';
    var amtIn  = isBuy
      ? '$' + parseFloat(tr.fromAmount||0).toFixed(2) + ' USDC'
      : parseFloat(tr.fromAmount||0).toFixed(6) + ' ETH';
    var amtOut = isBuy
      ? parseFloat(tr.toAmount||0).toFixed(6) + ' ETH'
      : '$' + parseFloat(tr.toAmount||0).toFixed(2) + ' USDC';
    var rsiStr = tr.rsiAtEntry != null ? parseFloat(tr.rsiAtEntry).toFixed(1) : '--';
    var fngStr = tr.fearGreedAtEntry != null
      ? tr.fearGreedAtEntry + ' ' + (tr.fearGreedLabelAtEntry || '')
      : '--';
    var fibStr = tr.fibLevelAtEntry != null
      ? fibLabel(tr.fibLevelAtEntry) + (tr.fibPriceAtEntry ? ' $' + parseFloat(tr.fibPriceAtEntry).toFixed(0) : '')
      : '--';
    var strStr     = tr.signalStrength || '--';
    var claudeStr  = tr.claudeReason   || '--';
    var txHash = tr.txHash || '';
    var txShort = txHash ? txHash.substring(0,10) + '...' + txHash.slice(-8) : '';
    var txLink  = txHash ? 'https://basescan.org/tx/' + txHash : '';
    return '<div class="rte ' + pnlClass + '">' +
      '<div class="rte-hdr">' +
        '<span class="rte-ts">' + tsStr + '</span>' +
        '<span class="rte-action ' + tr.action + '">' + tr.action + '</span>' +
        '<span class="rte-str">' + strStr + '</span>' +
        '<span class="rte-pnl ' + pnlClass + '">' + pnlStr + '</span>' +
      '</div>' +
      '<div class="rte-grid">' +
        '<div class="rte-cell"><span class="rte-cell-lbl">ENTRY PRICE</span><span class="rte-cell-val">' + entryStr + '</span></div>' +
        '<div class="rte-cell"><span class="rte-cell-lbl">EXIT PRICE</span><span class="rte-cell-val">' + exitStr + '</span></div>' +
        '<div class="rte-cell"><span class="rte-cell-lbl">AMT IN</span><span class="rte-cell-val">' + amtIn + '</span></div>' +
        '<div class="rte-cell"><span class="rte-cell-lbl">AMT OUT</span><span class="rte-cell-val">' + amtOut + '</span></div>' +
      '</div>' +
      '<div class="rte-ind-row">' +
        '<span class="rte-ind">RSI ' + rsiStr + '</span>' +
        '<span class="rte-ind">F&G ' + fngStr + '</span>' +
        '<span class="rte-ind">FIB ' + fibStr + '</span>' +
      '</div>' +
      '<div class="rte-claude">&#9654; ' + claudeStr + '</div>' +
      (txHash ? '<div class="rte-tx"><a href="' + txLink + '" target="_blank">' + txShort + ' &#8599; basescan</a></div>' : '') +
    '</div>';
  }).join('');
  body.innerHTML = html;
  body.scrollTop = 0; // latest trade at top
}

function updateTrade(t, risk, analyst) {
  if (!t) return;
  document.getElementById('t-usdc').textContent = parseFloat(t.usdcBalance||0).toFixed(2);
  document.getElementById('t-eth').textContent  = parseFloat(t.ethBalance||0).toFixed(6);
  document.getElementById('t-exec').textContent = t.executedCount || 0;
  document.getElementById('t-skip').textContent = t.skippedCount  || 0;
  document.getElementById('t-wallet').textContent = t.walletAddress ?
    t.walletAddress.substring(0,8) + '...' + t.walletAddress.slice(-6) : '--';

  var st = document.getElementById('t-status');
  st.textContent = t.status || 'IDLE';
  st.className = 'dv' + (t.status === 'EXECUTING' ? ' g' : '');

  // Portfolio value
  var portval = risk ? risk.portfolioValueUsd :
    (parseFloat(t.usdcBalance||0) + parseFloat(t.ethBalance||0) * lastPrice);
  var pv = document.getElementById('t-portval');
  pv.textContent = '$' + portval.toFixed(2);
  pv.style.color = ''; pv.style.textShadow = '';

  // Session P&L
  if (portval > 1) {
    if (sessionStartPortfolio === null) sessionStartPortfolio = portval;
    var pnlAbs = portval - sessionStartPortfolio;
    var pnlPct = sessionStartPortfolio > 0 ? (pnlAbs / sessionStartPortfolio) * 100 : 0;
    var pnlEl  = document.getElementById('tc-pnl');
    var pnlCol = pnlAbs >= 0 ? '#44AAFF' : '#FF2020';
    pnlEl.textContent = (pnlAbs >= 0 ? '+$' : '-$') + Math.abs(pnlAbs).toFixed(2) +
                        ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)';
    pnlEl.style.color = pnlCol;
    pnlEl.style.textShadow = '0 0 8px ' + pnlCol;
    pv.style.color = '#2288FF';
  }

  // Cooldown timer — derive from lastTrade timestamp
  lastTradeTsMs = (t.lastTrade && t.lastTrade.timestamp)
    ? new Date(t.lastTrade.timestamp).getTime() : 0;
  updateCooldown();

  // Win rate + avg duration from persistent tradeLog
  var perf = computePerf(t.tradeLog || []);
  document.getElementById('tc-winrate').textContent = perf.winRate;
  document.getElementById('tc-avgdur').textContent  = perf.avgDur;

  // ── Signal context from analyst ──────────────────────────────────────────
  var a = analyst || {};
  var sig = a.signal || 'HOLD';
  var str = a.strength || '--';

  var sigBadge = document.getElementById('tc-signal');
  sigBadge.textContent = sig;
  sigBadge.className   = 'sigctx-badge ' + sig;

  document.getElementById('tc-strength').textContent = str + ' STRENGTH';
  document.getElementById('tc-reason').textContent   = a.reason || '--';
  document.getElementById('tc-sig-age').textContent  = a.timestamp ? fmtAge(a.timestamp) : '--';

  // Mini RSI gauge
  if (a.rsi != null) {
    drawRSI(a.rsi, 'rsi-gauge-t', 'tc-rsi', false);
  }

  // Fear & Greed
  var fngVal = document.getElementById('tc-fng-val');
  var fngLbl = document.getElementById('tc-fng-lbl');
  if (a.fearGreedValue != null) {
    fngVal.textContent = a.fearGreedValue;
    fngLbl.textContent = a.fearGreedLabel || '--';
    var fngCol = a.fearGreedValue >= 60 ? '#44AAFF' : a.fearGreedValue <= 40 ? '#FF2020' : '#FFFFFF';
    fngVal.style.color = fngCol;
    fngVal.style.textShadow = '0 0 10px ' + fngCol;
  } else {
    fngVal.textContent = '--'; fngVal.style.color = '';
    fngLbl.textContent = '--';
  }

  // Fib proximity bar
  if (a.swingHigh && a.swingLow && a.price) {
    var range = a.swingHigh - a.swingLow;
    var nearLvl = a.nearestFibLevel;
    var nearPrice = a.nearestFibPrice || (a.swingHigh - range * (nearLvl || 0));
    var distAbs = Math.abs(a.price - nearPrice);
    var distPct = range > 0 ? (distAbs / range) * 100 : 100;
    var proximityPct = Math.max(0, Math.min(100, 100 - distPct * 2));
    var fibBar = document.getElementById('tc-fib-bar');
    fibBar.style.width = proximityPct.toFixed(1) + '%';
    var cls = proximityPct >= 70 ? 'close' : proximityPct >= 35 ? 'mid' : 'far';
    fibBar.className = 'fibprox-fill ' + cls;
    var infoEl = document.getElementById('tc-fib-info');
    var fibLblMap = {0:'0%', 0.236:'23.6%', 0.382:'38.2%', 0.5:'50%', 0.618:'61.8%', 0.786:'78.6%', 1:'100%'};
    var lvlStr = nearLvl != null ? (fibLblMap[nearLvl] || (nearLvl*100).toFixed(1)+'%') : '--';
    var distStr = distAbs < 1 ? distAbs.toFixed(3) : distAbs.toFixed(2);
    infoEl.textContent = lvlStr + '  $' + nearPrice.toFixed(0) + '  \u00B1$' + distStr;
    var infoCol = cls === 'close' ? '#44AAFF' : cls === 'mid' ? '#FF5522' : 'rgba(34,136,255,0.5)';
    infoEl.style.color = infoCol;
  }

  // Rich trade log
  renderTradeLog(t.tradeLog || []);
}

function updateCooldown() {
  var cdTxt = document.getElementById('tc-cooldown-txt');
  var cdBar = document.getElementById('tc-cooldown-bar');
  if (!cdTxt || !cdBar) return;
  if (!lastTradeTsMs) {
    cdTxt.textContent = 'READY'; cdTxt.className = 'cooldown-val ready';
    cdBar.style.width = '100%'; cdBar.className = 'cooldown-fill ready';
    return;
  }
  var elapsed = Date.now() - lastTradeTsMs;
  if (elapsed >= COOLDOWN_MS) {
    cdTxt.textContent = 'READY'; cdTxt.className = 'cooldown-val ready';
    cdBar.style.width = '100%'; cdBar.className = 'cooldown-fill ready';
  } else {
    var remaining = COOLDOWN_MS - elapsed;
    var remS = Math.ceil(remaining / 1000);
    var remMin = Math.floor(remS / 60), remSec = remS % 60;
    cdTxt.textContent = remMin + 'm ' + remSec + 's';
    cdTxt.className = 'cooldown-val waiting';
    var pct = (elapsed / COOLDOWN_MS) * 100;
    cdBar.style.width = pct.toFixed(1) + '%';
    cdBar.className = 'cooldown-fill waiting';
  }
}

// ── RISK PANEL ─────────────────────────────────────────────────────────────
function updateRisk(r) {
  if (!r) return;
  document.getElementById('r-portval').textContent  = '$' + (r.portfolioValueUsd||0).toFixed(4);
  document.getElementById('r-peak').textContent     = '$' + (r.peakPortfolioValueUsd||0).toFixed(4);
  document.getElementById('r-ethprice').textContent = '$' + (r.ethPriceUsd||0).toFixed(2);
  document.getElementById('r-trades').textContent   = r.tradeCount || 0;

  var pend = r.pendingSignal || '--';
  var pel = document.getElementById('r-pending');
  pel.textContent = pend + (r.pendingStrength ? ' \u00B7 ' + r.pendingStrength : '');
  pel.className = 'dv' + (pend==='BUY' ? ' g' : pend==='SELL' ? ' r' : '');

  document.getElementById('r-possize').textContent =
    ((r.pendingPositionSizePct||0)*100).toFixed(0) + '%';

  var ddRaw = typeof r.drawdownPct === 'string' ? parseFloat(r.drawdownPct) : (r.drawdown||0)*100;
  var ddEl = document.getElementById('r-dd');
  ddEl.textContent = ddRaw.toFixed(2) + '%';
  var bar = document.getElementById('r-ddbar');
  bar.style.width = Math.min(100, (ddRaw/40)*100) + '%';
  var dcol = ddRaw < 20 ? '#44AAFF' : ddRaw < 35 ? '#FFFFFF' : '#FF2020';
  bar.style.background = dcol; bar.style.boxShadow = '0 0 8px ' + dcol;
  ddEl.className = 'dv' + (ddRaw < 20 ? ' g' : ddRaw < 35 ? ' y' : ' r');

  var chkdd  = r.checks && r.checks.drawdown;
  var chkpos = r.checks && r.checks.positionSize;
  var dd2  = document.getElementById('chk-dd');
  var pos2 = document.getElementById('chk-pos');
  dd2.className  = chkdd  && chkdd.ok  ? 'ok' : 'fail';
  dd2.textContent = chkdd  && chkdd.ok  ? '\u2713 OK' : '\u2717 FAIL';
  pos2.className  = chkpos && chkpos.ok ? 'ok' : 'fail';
  pos2.textContent = chkpos && chkpos.ok ? '\u2713 OK' : '\u2717 FAIL';

  var halt = document.getElementById('r-halt');
  var hr   = document.getElementById('r-haltreason');
  if (r.halted) {
    halt.className = 'halt on';
    hr.style.display = 'block'; hr.textContent = r.haltReason || '';
  } else {
    halt.className = 'halt';
    hr.style.display = 'none';
  }

  // Win rate
  var wrEl = document.getElementById('r-winrate');
  var wrBar = document.getElementById('r-winrate-bar');
  var wrWarn = document.getElementById('r-winrate-warn');
  if (r.winRate !== null) {
    var wrPct = (r.winRate * 100).toFixed(1);
    wrEl.textContent = wrPct + '%';
    wrEl.className = 'dv' + (r.winRate >= 0.5 ? ' g' : r.winRate >= 0.4 ? ' y' : ' r');
    if (wrBar) {
      wrBar.style.width = wrPct + '%';
      wrBar.style.background = r.winRate >= 0.5 ? '#44AAFF' : r.winRate >= 0.4 ? '#FFDD00' : '#FF2020';
      wrBar.style.boxShadow = '0 0 6px ' + (r.winRate >= 0.5 ? '#44AAFF' : r.winRate >= 0.4 ? '#FFDD00' : '#FF2020');
    }
  } else { wrEl.textContent = 'N/A'; wrEl.className = 'dv'; if (wrBar) wrBar.style.width = '0%'; }
  if (wrWarn) wrWarn.className = 'winrate-warn' + (r.winRateWarning ? ' on' : '');

  var avgEl = document.getElementById('r-avgpnl');
  if (avgEl) {
    if (r.avgPnlUsd !== null) {
      avgEl.textContent = (r.avgPnlUsd >= 0 ? '+$' : '-$') + Math.abs(r.avgPnlUsd).toFixed(4);
      avgEl.className = 'dv' + (r.avgPnlUsd >= 0 ? ' g' : ' r');
    } else { avgEl.textContent = 'N/A'; avgEl.className = 'dv'; }
  }
  var strkEl = document.getElementById('r-streak');
  if (strkEl) {
    if (r.consecutiveWins > 0)   { strkEl.textContent = r.consecutiveWins   + 'W'; strkEl.className = 'dv g'; }
    else if (r.consecutiveLosses > 0) { strkEl.textContent = r.consecutiveLosses + 'L'; strkEl.className = 'dv r'; }
    else { strkEl.textContent = '--'; strkEl.className = 'dv'; }
  }

  // Liquidity
  var liqEl  = document.getElementById('r-liquidity');
  var liqWrn = document.getElementById('r-liq-warn');
  if (liqEl) {
    if (r.liquidityDepthUsd !== null) {
      liqEl.textContent = '$' + (r.liquidityDepthUsd / 1000).toFixed(0) + 'K est.';
      liqEl.className = 'dv' + (r.liquidityWarning ? ' r' : r.liquidityDepthUsd > 500000 ? ' g' : '');
    } else { liqEl.textContent = '--'; liqEl.className = 'dv'; }
  }
  if (liqWrn) liqWrn.className = 'liq-warn' + (r.liquidityWarning ? ' on' : '');

  // Volatility
  var vrEl = document.getElementById('r-vol-regime');
  var vmEl = document.getElementById('r-vol-mult');
  if (vrEl) {
    vrEl.textContent = r.volatilityRegime || 'NORMAL';
    vrEl.className = 'dv' + (r.volatilityRegime === 'CHOPPY' ? ' r' : r.volatilityRegime === 'TRENDING' ? ' g' : '');
  }
  if (vmEl) {
    vmEl.textContent = (r.volatilityMultiplier !== undefined ? r.volatilityMultiplier : 1.0).toFixed(1) + 'x';
    vmEl.className = 'dv' + ((r.volatilityMultiplier || 1.0) < 1.0 ? ' y' : ' g');
  }
}

// ── TIME ───────────────────────────────────────────────────────────────────
function tick() {
  var now = new Date();
  document.getElementById('top-time').textContent = now.toISOString().substring(11,19) + ' UTC';
  document.getElementById('top-date').textContent = now.toISOString().substring(0,10);
  updateCooldown();
}

// ── POLL ───────────────────────────────────────────────────────────────────
async function poll() {
  try {
    var res = await fetch('/api/state');
    var d = await res.json();
    updateDot('d-analyst', d.analyst);
    updateDot('d-trade',   d.trade);
    updateDot('d-risk',    d.risk);
    if (d.analyst) { updateAnalyst(d.analyst); updateWhale(d.analyst); }
    if (d.trade)   { window._lastTradeState = d.trade; updateTrade(d.trade, d.risk, d.analyst); }
    if (d.risk)    updateRisk(d.risk);
    tick();
  } catch(e) { console.error('poll err', e); }
}

// ── NEWS TICKER ────────────────────────────────────────────────────────────
async function loadNews() {
  try {
    var res = await fetch('/api/news');
    var data = await res.json();
    if (data.items && data.items.length) {
      var ticker = document.getElementById('news-ticker');
      var status = document.getElementById('ticker-status');
      var doubled = data.items.concat(data.items);
      ticker.innerHTML = doubled.map(function(item) {
        return '<span class="ticker-item">' + item.title +
          (item.source ? ' &nbsp;[' + item.source + ']' : '') + '</span>';
      }).join('');
      var dur = Math.max(40, Math.min(150, data.items.length * 6)) + 's';
      ticker.style.animationDuration = dur;
      if (status) { status.textContent = data.items.length + ' ITEMS'; status.style.color = 'rgba(68,170,255,0.6)'; }
    }
  } catch(e) { console.error('news err', e); }
}

// ── RISKCLAW CHAT ──────────────────────────────────────────────────────────
var chatBusy = false;

function addChatMsg(type, text) {
  var msgs = document.getElementById('chat-msgs');
  if (!msgs) return;
  var div = document.createElement('div');
  div.className = 'chat-msg ' + type;
  if (type === 'thinking') div.id = 'chat-thinking';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeThinking() {
  var el = document.getElementById('chat-thinking');
  if (el) el.remove();
}

async function sendChat() {
  if (chatBusy) return;
  var input = document.getElementById('chat-input');
  var btn   = document.getElementById('chat-btn');
  var msg   = input ? input.value.trim() : '';
  if (!msg) return;

  addChatMsg('user', msg);
  input.value = '';
  chatBusy = true;
  if (btn) btn.disabled = true;
  addChatMsg('thinking', '⬡ RiskClaw is thinking...');

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    var data = await res.json();
    removeThinking();
    addChatMsg('bot', data.reply || 'No response.');
  } catch(e) {
    removeThinking();
    addChatMsg('bot', 'Connection error. Please try again.');
  }
  chatBusy = false;
  if (btn) btn.disabled = false;
  if (input) input.focus();
}

// ── WHALE PANEL ────────────────────────────────────────────────────────────
function fmtUsd(n) {
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

function updateWhale(a) {
  if (!a) return;
  var ob  = a.orderBook;
  var ltx = a.largeTransactions;

  // Order book depth bars (live from Coinbase L2 — unchanged)
  if (ob && ob.bidWall > 0) {
    var total = ob.bidWall + ob.askWall;
    var bidPct = total > 0 ? (ob.bidWall / total * 100).toFixed(1) : 50;
    var askPct = total > 0 ? (ob.askWall / total * 100).toFixed(1) : 50;
    var bidBar = document.getElementById('ob-bid-bar');
    var askBar = document.getElementById('ob-ask-bar');
    var ratioEl = document.getElementById('ob-ratio');
    var bidUsd = document.getElementById('ob-bid-usd');
    var askUsd = document.getElementById('ob-ask-usd');
    if (bidBar) bidBar.style.width = bidPct + '%';
    if (askBar) askBar.style.width = askPct + '%';
    if (ratioEl) {
      var r = ob.ratio;
      ratioEl.textContent = r >= 3 ? r.toFixed(1)+'x BID' : r <= 0.33 ? (1/r).toFixed(1)+'x ASK' : r.toFixed(2);
      ratioEl.style.color = r >= 3 ? '#00FF88' : r <= 0.33 ? '#FF2020' : 'rgba(0,255,200,0.5)';
    }
    if (bidUsd) bidUsd.textContent = 'BID ' + fmtUsd(ob.bidWall);
    if (askUsd) askUsd.textContent = 'ASK ' + fmtUsd(ob.askWall);
  }

  // Large transactions (Etherscan — unchanged)
  if (ltx) {
    var inflowEl  = document.getElementById('ltx-inflow');
    var outflowEl = document.getElementById('ltx-outflow');
    if (inflowEl) {
      inflowEl.textContent = ltx.inflow > 0 ? ltx.inflow.toFixed(1) + ' ETH' : '--';
      inflowEl.className = 'largetx-val' + (ltx.inflow > 50 ? ' hot' : '');
    }
    if (outflowEl) {
      outflowEl.textContent = ltx.outflow > 0 ? ltx.outflow.toFixed(1) + ' ETH' : '--';
      outflowEl.className = 'largetx-val' + (ltx.outflow > 50 ? ' hot' : '');
    }
  }
}

// ── NANSEN WHALE FEED + CHART MARKERS ──────────────────────────────────────
var nansenMarkers = [];

async function loadNansenWhales() {
  try {
    var res = await fetch('/api/nansen-whales');
    var data = await res.json();
    if (!data || !data.trades) return;

    // Update whale header stats
    var dir = data.direction || 'NEUTRAL';
    var dirEl = document.getElementById('w-direction');
    if (dirEl) {
      dirEl.textContent = dir === 'NEUTRAL' ? '--' : dir;
      dirEl.className = 'whale-box-val whale-dir-' + (dir === 'NEUTRAL' ? 'NONE' : dir);
    }
    var volEl = document.getElementById('w-volume');
    var cntEl = document.getElementById('w-count');
    var totalUsd = (data.buyUsd || 0) + (data.sellUsd || 0);
    if (volEl) volEl.textContent = totalUsd > 0 ? fmtUsd(totalUsd) : '$--';
    if (cntEl) {
      cntEl.textContent = (data.buyCount + data.sellCount) + ' (' + data.buyCount + 'B/' + data.sellCount + 'S)';
      cntEl.style.color = dir === 'BUY' ? '#00FFCC' : dir === 'SELL' ? '#FF2020' : 'rgba(0,255,200,0.4)';
    }

    // Render feed with Nansen labeled trades
    var feedBody   = document.getElementById('w-feed-body');
    var feedStatus = document.getElementById('w-feed-status');
    var trades = data.trades || [];
    if (feedStatus) feedStatus.textContent = trades.length ? trades.length + ' SM TRADES · 1H' : 'NO DATA';
    if (feedBody) {
      if (!trades.length) {
        feedBody.innerHTML = '<div class="no-whale">NO LABELED SM TRADES IN WINDOW</div>';
      } else {
        feedBody.innerHTML = trades.slice(0, 40).map(function(t) {
          var ts  = new Date(t.timestamp * 1000).toISOString().substring(11, 19);
          var lbl = t.label ? t.label.toUpperCase() : 'UNLABELED';
          return '<div class="whale-entry ' + t.direction + '">' +
            '<span class="whale-entry-dir ' + t.direction + '">' + t.direction + '</span>' +
            '<span class="whale-entry-label">' + lbl + '</span>' +
            '<span class="whale-entry-amt">' + fmtUsd(t.amountUsd) + '</span>' +
            '<span class="whale-entry-ts">' + ts + ' UTC</span>' +
          '</div>';
        }).join('');
      }
    }

    // Store markers for chart overlay (snap to minute boundary)
    nansenMarkers = trades.map(function(t) {
      var minuteTs = Math.floor(t.timestamp / 60) * 60;
      return {
        time:     minuteTs,
        position: t.direction === 'BUY' ? 'belowBar' : 'aboveBar',
        color:    t.direction === 'BUY' ? '#00FFCC'  : '#FF4444',
        shape:    t.direction === 'BUY' ? 'arrowUp'  : 'arrowDown',
        text:     t.label ? t.label.substring(0, 12) : 'SM'
      };
    });
    applyNansenMarkers();
  } catch(e) { console.error('nansen whale err', e); }
}

function applyNansenMarkers() {
  if (!candleSeries || !nansenMarkers.length) return;
  // Deduplicate by time (LW Charts requires unique times per series)
  var seen = {};
  var unique = nansenMarkers.filter(function(m) {
    var key = m.time + m.position;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  unique.sort(function(a, b) { return a.time - b.time; });
  try { candleSeries.setMarkers(unique); } catch(e) {}
}

// ── MOBILE TAB SWITCHING ───────────────────────────────────────────────────
var currentTab = 'analyst';
function isMobile() { return window.innerWidth <= 768; }
function switchTab(tab) {
  currentTab = tab;
  var mobile = isMobile();
  document.querySelectorAll('.panel').forEach(function(p) {
    p.style.display = (!mobile || p.getAttribute('data-tab') === tab) ? '' : 'none';
  });
  var cs = document.querySelector('.chartsec');
  if (cs) cs.style.display = (!mobile || tab === 'analyst') ? '' : 'none';
  ['analyst','trade','risk'].forEach(function(t) {
    var btn = document.getElementById('mnav-' + t);
    if (btn) btn.className = 'mnav-btn' + (t === tab ? ' active' : '');
  });
  // Re-draw RSI gauges if switching to a tab that has one
  if (tab === 'analyst' || tab === 'trade') drawRSI(null, 'rsi-gauge', 'rsi-num', true);
}
window.addEventListener('resize', function() { switchTab(currentTab); });
if (isMobile()) switchTab('analyst');

// ── NEWS TICKERS ────────────────────────────────────────────────────────────
function buildTickerItems(titles) {
  if (!titles || !titles.length) return '<span class="nticker-item">No data available</span>';
  var doubled = titles.concat(titles);
  return doubled.map(function(t) {
    return '<span class="nticker-item">' + String(t).replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>';
  }).join('');
}

async function loadTickers() {
  try {
    var res = await fetch('/api/tickers');
    var data = await res.json();
    var feeds = { bbc: data.bbc || [], finance: data.finance || [], crypto: data.crypto || [] };
    ['bbc','finance','crypto'].forEach(function(key) {
      var el = document.getElementById('ticker-' + key);
      if (!el) return;
      el.innerHTML = buildTickerItems(feeds[key]);
      var dur = Math.max(50, Math.min(180, feeds[key].length * 8));
      el.style.animationDuration = dur + 's';
    });
  } catch(e) { console.error('ticker err', e); }
}


// Mark default TF button active
(function(){ var b = document.querySelector('.tf-btn.active'); if(!b){ var btns=document.querySelectorAll('.tf-btn'); btns.forEach(function(x){if(x.textContent.trim()==='LIVE')x.className='tf-btn active';}); } })();

// ── STARTUP ────────────────────────────────────────────────────────────────
poll();
setInterval(poll, 5000);
tick();
setInterval(tick, 1000);
initChart();
loadNews();
setInterval(loadNews, 60000);
loadNansenWhales();
setInterval(loadNansenWhales, 60000);
loadTickers();
setInterval(loadTickers, 120000);
</script>
</body>
</html>`;
}
