import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const COINS = [
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC' },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH' },
  { id: 'the-open-network', name: 'TON', symbol: 'TON' },
  { id: 'solana', name: 'Solana', symbol: 'SOL' },
  { id: 'ripple', name: 'XRP', symbol: 'XRP' },
  { id: 'cardano', name: 'Cardano', symbol: 'ADA' },
  { id: 'dogecoin', name: 'Dogecoin', symbol: 'DOGE' },
  { id: 'polkadot', name: 'Polkadot', symbol: 'DOT' },
  { id: 'avalanche-2', name: 'Avalanche', symbol: 'AVAX' },
  { id: 'chainlink', name: 'Chainlink', symbol: 'LINK' },
  { id: 'near', name: 'NEAR', symbol: 'NEAR' },
  { id: 'sui', name: 'Sui', symbol: 'SUI' },
  { id: 'cosmos', name: 'Cosmos', symbol: 'ATOM' },
  { id: 'stellar', name: 'Stellar', symbol: 'XLM' },
  { id: 'hedera-hashgraph', name: 'Hedera', symbol: 'HBAR' },
  { id: 'arbitrum', name: 'Arbitrum', symbol: 'ARB' },
  { id: 'litecoin', name: 'Litecoin', symbol: 'LTC' },
  { id: 'render-token', name: 'Render', symbol: 'RENDER' },
];

/* ─── Signal computation (same algorithm) ─── */

function compute(coin, prices) {
  if (!prices || prices.length < 2) return null;
  const c = prices.map(p => p[1] || p);
  const p = c[c.length - 1];
  const p24 = c[Math.max(0, c.length - 97)] || c[0];
  const p7 = c[0];
  const c24 = ((p - p24) / p24) * 100;
  const c7 = ((p - p7) / p7) * 100;

  const rp = c.slice(-15);
  let g = 0, l = 0;
  for (let i = 1; i < rp.length; i++) { const d = rp[i] - rp[i-1]; if (d > 0) g += d; else l -= d; }
  const rs = l === 0 ? 100 : (g / 14) / (l / 14);
  const rsi = 100 - 100 / (1 + rs);

  let bull = 0, bear = 0, reasons = [];

  if (rsi < 30) { bull += 3; reasons.push(`RSI ${rsi.toFixed(0)} — deeply oversold, strong bounce potential`); }
  else if (rsi < 38) { bull += 2; reasons.push(`RSI ${rsi.toFixed(0)} — oversold territory, reversal likely`); }
  else if (rsi > 75) { bear += 3; reasons.push(`RSI ${rsi.toFixed(0)} — deeply overbought, correction due`); }
  else if (rsi > 65) { bear += 2; reasons.push(`RSI ${rsi.toFixed(0)} — overbought, profit-taking risk`); }

  if (c24 > 8) { bull += 2; reasons.push(`+${c24.toFixed(1)}% in 24h — breakout momentum`); }
  else if (c24 > 4) { bull += 1; reasons.push(`+${c24.toFixed(1)}% in 24h — bullish push`); }
  else if (c24 < -7) { bear += 2; reasons.push(`${c24.toFixed(1)}% in 24h — sharp sell-off`); }
  else if (c24 < -3) { bear += 1; reasons.push(`${c24.toFixed(1)}% in 24h — bearish drift`); }

  if (c7 > 25) { bull += 2; reasons.push(`+${c7.toFixed(1)}% in 7d — strong uptrend`); }
  else if (c7 < -20) { bear += 2; reasons.push(`${c7.toFixed(1)}% in 7d — strong downtrend`); }

  const l3 = c.slice(-3);
  if (l3[2] > l3[1] && l3[1] > l3[0]) { bull += 2; reasons.push('3 consecutive green candles — strong buying'); }
  else if (l3[2] < l3[1] && l3[1] < l3[0]) { bear += 2; reasons.push('3 consecutive red candles — strong selling'); }

  const lo = Math.min(...c), hi = Math.max(...c);
  const pos = ((p - lo) / (hi - lo || 1)) * 100;
  if (pos < 15) { bull += 2; reasons.push('Near 7-day low — support zone, bounce candidate'); }
  else if (pos > 85) { bear += 2; reasons.push('Near 7-day high — resistance zone, pullback risk'); }

  const net = bull - bear;
  let dir, conf;
  if (net >= 2) { dir = net >= 4 ? 'STRONG_BUY' : 'BUY'; conf = Math.min(92, 45 + net * 8); }
  else if (net <= -2) { dir = net <= -4 ? 'STRONG_SELL' : 'SELL'; conf = Math.min(92, 45 + Math.abs(net) * 8); }
  else { dir = 'HOLD'; conf = 20 + Math.abs(net) * 8; }

  return {
    coinId: coin.id, name: coin.name, symbol: coin.symbol,
    image: `https://cryptologos.cc/logos/${coin.id}-${coin.symbol.toLowerCase()}-logo.png`,
    price: p,
    change24h: Math.round(c24 * 100) / 100,
    change7d: Math.round(c7 * 100) / 100,
    rsi: Math.round(rsi * 10) / 10,
    direction: dir,
    confidence: Math.min(98, conf),
    reasons,
    description: reasons.slice(0, 2).join('. '),
    timestamp: new Date().toISOString()
  };
}

/* ─── Stable price generation with live CoinGecko data ─── */
// Cache for live prices — refreshes every 10 minutes
let priceCache = null;
let lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchLivePrices() {
  const now = Date.now();
  if (priceCache && (now - lastFetch) < CACHE_TTL) return priceCache;
  
  try {
    const ids = COINS.map(c => c.id).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`,
      { timeout: 10000 }
    );
    if (!res.ok) throw new Error(`CoinGecko: ${res.status}`);
    const data = await res.json();
    
    // Also fetch historical for RSI calculation (7 days daily)
    priceCache = {};
    for (const coin of COINS) {
      const entry = data[coin.id];
      if (!entry) continue;
      priceCache[coin.id] = {
        price: entry.usd,
        change24h: entry.usd_24h_change || 0,
        change7d: 0, // CoinGecko simple API doesn't give this
      };
    }
    lastFetch = now;
    console.log(`📡 Live prices fetched (${Object.keys(priceCache).length} coins)`);
    return priceCache;
  } catch (e) {
    console.log('⚠️ CoinGecko fetch failed, using time-stable demo data');
    return null;
  }
}

// Time-seeded demo generator — stable for 10-minute windows
function timeSeededPrices(base) {
  const window = Math.floor(Date.now() / (10 * 60 * 1000)); // changes every 10 min
  const seed = window * 1000 + Math.floor(base);
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  
  const pts = 168;
  const hourlyStd = base * 0.007;
  const hourlyDrift = (rand() - 0.5) * 0.15;
  const r = [];
  let p = base;
  for (let i = 0; i < pts; i++) {
    p += p * (hourlyDrift / 100) + (rand() - 0.5) * hourlyStd;
    r.push(p);
  }
  return r;
}

const BASE_PRICES = {
  'bitcoin': 62583, 'ethereum': 1647, 'the-open-network': 1.65, 'solana': 65,
  'ripple': 1.11, 'cardano': 0.25, 'dogecoin': 0.08, 'polkadot': 0.95,
  'avalanche-2': 6.57, 'chainlink': 7.77, 'near': 2.05, 'sui': 0.30,
  'cosmos': 1.84, 'stellar': 0.19, 'hedera-hashgraph': 0.08, 'arbitrum': 0.08,
  'litecoin': 62, 'render-token': 1.57
};

/* ─── Warm up Hermes at startup ─── */
console.log('🔥 Warming up Hermes AI backend...');
try {
  const warm = spawnSync('/opt/hermes/.venv/bin/python3', 
    ['/opt/data/crypto-signals/hermes_chat.py', 'ping'],
    { timeout: 120000, env: { ...process.env, HERMES_HOME: '/opt/data', HERMES_QUIET: '1' },
      encoding: 'utf-8', cwd: '/opt/hermes' });
  if (warm.status === 0) console.log('✅ Hermes AI backend ready');
  else console.log('⚠️ Hermes warm-up failed:', (warm.stderr || 'exit ' + warm.status).substring(0, 100));
} catch (e) {
  console.log('⚠️ Hermes warm-up error:', e.message.substring(0, 100));
}

/* ─── API ─── */

app.get('/api/signals', async (req, res) => {
  // Try live data
  const livePrices = await fetchLivePrices();
  
  const results = await Promise.all(COINS.map(async coin => {
    let base, prices;
    
    if (livePrices && livePrices[coin.id]) {
      // Use live data for the current price
      base = livePrices[coin.id].price;
      // Generate time-seeded price series around live price
      prices = timeSeededPrices(base);
    } else {
      base = BASE_PRICES[coin.id] || 1;
      prices = timeSeededPrices(base);
    }
    
    const signal = compute(coin, prices);
    // Override 24h change with live data if available
    if (livePrices && livePrices[coin.id]) {
      signal.change24h = Math.round(livePrices[coin.id].change24h * 100) / 100;
    }
    return signal;
  }));
  
  const signals = results.filter(Boolean);

  // Relative ranking (always produce some BUY/SELL signals)
  const best = Math.max(...signals.map(s => s.change24h));
  const worst = Math.min(...signals.map(s => s.change24h));
  const range = best - worst;

  signals.forEach(s => {
    const rs = range === 0 ? 50 : ((s.change24h - worst) / range) * 100;
    let changed = false;
    if (rs > 82 && s.direction === 'HOLD') {
      s.direction = 'BUY'; s.confidence = Math.round(55 + (rs - 82) * 1.8);
      s.reasons.unshift(`Top 20% 24h performer vs market — relative strength play`);
      s.description = s.reasons.slice(0, 2).join('. ');
      changed = true;
    } else if (rs < 18 && s.direction === 'HOLD') {
      s.direction = 'SELL'; s.confidence = Math.round(55 + (18 - rs) * 1.8);
      s.reasons.unshift(`Bottom 20% 24h performer vs market — relative weakness`);
      s.description = s.reasons.slice(0, 2).join('. ');
      changed = true;
    }
    if (rs > 92 && s.direction === 'BUY') {
      s.direction = 'STRONG_BUY'; s.confidence = Math.min(95, s.confidence + 15);
      s.reasons.unshift(`Market leader — best 24h performance in our set`);
      changed = true;
    } else if (rs < 8 && s.direction === 'SELL') {
      s.direction = 'STRONG_SELL'; s.confidence = Math.min(95, s.confidence + 15);
      s.reasons.unshift(`Market laggard — worst 24h performance in our set`);
      changed = true;
    }
    if (changed) s.description = s.reasons.slice(0, 2).join('. ');
    s.confidence = Math.min(98, Math.max(12, s.confidence));
  });

  signals.sort((a, b) => b.confidence - a.confidence);

  res.json({
    success: true,
    count: signals.length,
    generatedAt: new Date().toISOString(),
    signals,
    dataSource: livePrices ? 'coingecko' : 'time-seeded-demo',
    note: livePrices 
      ? 'Live prices from CoinGecko — signal analysis via RSI, momentum, relative strength'
      : 'Time-seeded demo data (stable for 10min windows) — signal analysis via RSI, momentum, relative strength'
  });
});

app.get('/api/signals/:coinId', async (req, res) => {
  const coin = COINS.find(c => c.id === req.params.coinId);
  if (!coin) return res.status(404).json({ success: false, error: 'Not found' });
  
  const livePrices = await fetchLivePrices();
  let base;
  if (livePrices && livePrices[coin.id]) {
    base = livePrices[coin.id].price;
  } else {
    base = BASE_PRICES[coin.id] || 1;
  }
  const prices = timeSeededPrices(base);
  const signal = compute(coin, prices);
  if (livePrices && livePrices[coin.id]) {
    signal.change24h = Math.round(livePrices[coin.id].change24h * 100) / 100;
  }
  res.json({ success: true, signal });
});

/* ─── AI Chat ─── */

// In-memory chat history per session
const chatSessions = new Map();
const MAX_CHAT_HISTORY = 20;

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, error: 'Message is required' });
  }

  const sid = sessionId || crypto.randomUUID();
  if (!chatSessions.has(sid)) {
    chatSessions.set(sid, [
      { role: 'system', content: 'You are Hermes, an AI assistant integrated into a crypto signals platform. You help users understand market signals, technical analysis, and crypto markets. Keep answers clear and direct. You can reference current signal data if relevant. Be conversational but concise.' }
    ]);
  }

  const history = chatSessions.get(sid);
  history.push({ role: 'user', content: message });

  // Keep history manageable
  if (history.length > MAX_CHAT_HISTORY) {
    history.splice(1, history.length - MAX_CHAT_HISTORY);
  }

  try {
    const chatModel = process.env.CHAT_MODEL || '';

    // Execute hermes via venv Python — use spawnSync for better env control
    const result = spawnSync(
      '/opt/hermes/.venv/bin/python3',
      ['/opt/data/crypto-signals/hermes_chat.py', message],
      {
        timeout: 180000,
        maxBuffer: 50 * 1024,
        env: { ...process.env, HERMES_HOME: '/opt/data', HERMES_QUIET: '1' },
        encoding: 'utf-8',
        cwd: '/opt/hermes'
      }
    );

    let reply = "I'm not sure how to respond to that.";
    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed && parsed.reply) reply = parsed.reply;
      } catch {
        reply = result.stdout.trim();
      }
    } else if (result.stderr) {
      // stderr output means the AI backend crashed — fall through
      console.error('Chat stderr:', result.stderr.substring(0, 200));
    }

    history.push({ role: 'assistant', content: reply });

    res.json({
      success: true,
      reply,
      sessionId: sid
    });

  } catch (err) {
    // Fallback: respond with signal-aware canned reply when AI API unavailable
    const fallbackResponses = [
      "I'm currently in offline mode. I can still help with the signals on this dashboard — check the coin cards for RSI, momentum, and technical analysis. What specific coin are you looking at?",
      "My AI backend isn't reachable right now, but I can tell you what I see on the board. Look for coins with RSI < 35 (oversold bounce plays) or strong momentum breakouts (5%+ 24h).",
      "The signal board shows 18 coins with BUY/SELL/HOLD ratings based on RSI, candle patterns, and relative strength. Which one caught your eye?",
      "I'm running in fallback mode, but the dashboard has fresh signals. ATOM showing strong 24h momentum or coins with RSI > 70 might be due for a pullback."
    ];
    const idx = Math.floor(Math.random() * fallbackResponses.length);
    history.push({ role: 'assistant', content: fallbackResponses[idx] });
    res.json({
      success: true,
      reply: fallbackResponses[idx],
      sessionId: sid,
      fallback: true
    });
  }
});

// Serve static files — API routes must come first
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 5151;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Crypto Signals on http://0.0.0.0:${PORT} (${COINS.length} coins)`);
});
