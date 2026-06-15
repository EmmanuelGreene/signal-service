import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  maxAge: 86400,
}));
app.use(express.json());

/* ─────────────────────────────────────────────
   STARTUP TIME — for health check uptime
   ───────────────────────────────────────────── */
const START_TIME = Date.now();

/* ─────────────────────────────────────────────
   GLOBAL ERROR HANDLING — never crash silently
   ───────────────────────────────────────────── */
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack?.substring(0, 500));
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason?.message || reason);
});

/* ─────────────────────────────────────────────
   HELPER: fetch with retry + backoff
   ───────────────────────────────────────────── */
async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort(), options.timeout || 15000);
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(id);
      if (res.status === 429 && attempt < retries) {
        const wait = (attempt + 1) * 2000;
        console.log(`⏳ Rate limited, retry ${attempt + 1}/${retries} in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = (attempt + 1) * 1500;
      console.log(`⏳ Fetch failed (${e.message}), retry ${attempt + 1}/${retries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function fetchWithTimeout(url, ms = 15000) {
  return fetchWithRetry(url, { timeout: ms }, 2);
}

/* ─────────────────────────────────────────────
   COIN LIST — 18 top cryptos
   ───────────────────────────────────────────── */
const COINS = [
  { id: 'bitcoin',             name: 'Bitcoin',       sym: 'BTC' },
  { id: 'ethereum',            name: 'Ethereum',      sym: 'ETH' },
  { id: 'the-open-network',    name: 'TON',           sym: 'TON' },
  { id: 'solana',              name: 'Solana',        sym: 'SOL' },
  { id: 'ripple',              name: 'XRP',           sym: 'XRP' },
  { id: 'cardano',             name: 'Cardano',       sym: 'ADA' },
  { id: 'dogecoin',            name: 'Dogecoin',      sym: 'DOGE' },
  { id: 'polkadot',            name: 'Polkadot',      sym: 'DOT' },
  { id: 'avalanche-2',         name: 'Avalanche',     sym: 'AVAX' },
  { id: 'chainlink',           name: 'Chainlink',     sym: 'LINK' },
  { id: 'near',                name: 'NEAR',          sym: 'NEAR' },
  { id: 'sui',                 name: 'Sui',           sym: 'SUI' },
  { id: 'cosmos',              name: 'Cosmos',        sym: 'ATOM' },
  { id: 'stellar',             name: 'Stellar',       sym: 'XLM' },
  { id: 'hedera-hashgraph',    name: 'Hedera',        sym: 'HBAR' },
  { id: 'arbitrum',            name: 'Arbitrum',      sym: 'ARB' },
  { id: 'litecoin',            name: 'Litecoin',      sym: 'LTC' },
  { id: 'render-token',        name: 'Render',        sym: 'RNDR' },
];

/* ─────────────────────────────────────────────
   TECHNICAL INDICATORS
   ───────────────────────────────────────────── */
function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function sma(values, period) {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function bb(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const slice = values.slice(-period);
  const variance = slice.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, mid, lower: mid - mult * std, width: std / mid };
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < values.length; i++) changes.push(values[i] - values[i - 1]);
  const recent = changes.slice(-period);
  let avgGain = 0, avgLoss = 0;
  for (const c of recent) { if (c > 0) avgGain += c; else avgLoss -= c; }
  avgGain /= period; avgLoss /= period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const line = ema12 - ema26;
  // signal line would need full series — use line direction as proxy
  return { line, histogram: line, signal: 0 };
}

/* ─────────────────────────────────────────────
   COINGECKO FETCHER — live data every 10 min
   ───────────────────────────────────────────── */
let cachedMarket = null;
let lastMarketFetch = 0;
const MARKET_TTL = 10 * 60 * 1000;

async function fetchMarketData() {
  const now = Date.now();
  if (cachedMarket && (now - lastMarketFetch) < MARKET_TTL) return cachedMarket;

  try {
    const ids = COINS.map(c => c.id).join(',');
    // Main price + 24h + 7d + mcap + volume + sparkline for RSI calc
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h,7d`,
      15000
    );
    if (!res.ok) throw new Error(`CoinGecko: ${res.status}`);
    const data = await res.json();

    const map = {};
    for (const item of data) {
      const spark = item.sparkline_in_7d?.price || [];
      map[item.id] = {
        price: item.current_price,
        mcap: item.market_cap,
        vol24h: item.total_volume,
        change24h: item.price_change_percentage_24h || 0,
        change7d: item.price_change_percentage_7d_in_currency || 0,
        high24h: item.high_24h || item.current_price,
        low24h: item.low_24h || item.current_price,
        sparkline: spark,
        ath: item.ath || item.current_price,
      };
    }

    cachedMarket = map;
    lastMarketFetch = now;
    console.log(`📡 Live: ${Object.keys(map).length} coins`);
    return map;
  } catch (e) {
    console.log(`⚠️ CoinGecko: ${e.message}`);
    console.log('🔄 Falling back to CoinCap...');
    const fallback = await fetchMarketDataFallback();
    if (fallback) {
      cachedMarket = fallback;
      lastMarketFetch = now;
      console.log(`📡 CoinCap fallback: ${Object.keys(fallback).length} coins`);
    }
    return fallback;
  }
}

/* ─────────────────────────────────────────────
   COINCAP FALLBACK — when CoinGecko is down
   ───────────────────────────────────────────── */
const COINCAP_ID_MAP = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'XRP': 'ripple',
  'ADA': 'cardano', 'DOGE': 'dogecoin', 'DOT': 'polkadot', 'AVAX': 'avalanche-2',
  'LINK': 'chainlink', 'NEAR': 'near', 'SUI': 'sui', 'ATOM': 'cosmos',
  'XLM': 'stellar', 'HBAR': 'hedera-hashgraph', 'ARB': 'arbitrum', 'LTC': 'litecoin',
  'TON': 'the-open-network', 'RNDR': 'render-token',
};
const COINCAP_API_BASE = 'https://api.coincap.io/v2/assets';

async function fetchMarketDataFallback() {
  try {
    const results = {};
    let fetchedCount = 0;
    for (const coin of COINS) {
      const slug = COINCAP_ID_MAP[coin.sym];
      if (!slug) continue;
      const res = await fetchWithTimeout(`${COINCAP_API_BASE}/${slug}`, 8000);
      if (!res.ok) continue;
      const body = await res.json();
      const d = body?.data;
      if (!d) continue;
      const price = parseFloat(d.priceUsd);
      results[coin.id] = {
        price,
        mcap: parseFloat(d.marketCapUsd) || 0,
        vol24h: parseFloat(d.volumeUsd24Hr) || 0,
        change24h: parseFloat(d.changePercent24Hr) || 0,
        change7d: 0,
        high24h: price,  // CoinCap doesn't provide 24h high/low
        low24h: price,
        sparkline: [price],
        ath: price,
      };
      fetchedCount++;
      // Small delay to be polite to CoinCap
      if (fetchedCount % 6 === 0) await new Promise(r => setTimeout(r, 300));
    }
    return Object.keys(results).length > 0 ? results : null;
  } catch (e) {
    console.log(`⚠️ CoinCap fallback error: ${e.message}`);
    return null;
  }
}

/* ─────────────────────────────────────────────
   BINANCE FETCHER — funding rates & volume profile
   ───────────────────────────────────────────── */
let cachedBinance = null;
let lastBinanceFetch = 0;
const BINANCE_TTL = 5 * 60 * 1000; // 5 min

const BINANCE_SYMBOLS = {
  'bitcoin': 'BTCUSDT', 'ethereum': 'ETHUSDT', 'solana': 'SOLUSDT',
  'ripple': 'XRPUSDT', 'cardano': 'ADAUSDT', 'dogecoin': 'DOGEUSDT',
  'polkadot': 'DOTUSDT', 'avalanche-2': 'AVAXUSDT', 'chainlink': 'LINKUSDT',
  'near': 'NEARUSDT', 'sui': 'SUIUSDT', 'cosmos': 'ATOMUSDT',
  'stellar': 'XLMUSDT', 'hedera-hashgraph': 'HBARUSDT', 'arbitrum': 'ARBUSDT',
  'litecoin': 'LTCUSDT', 'the-open-network': 'TONUSDT', 'render-token': 'RNDRUSDT',
};

async function fetchBinanceData() {
  const now = Date.now();
  if (cachedBinance && (now - lastBinanceFetch) < BINANCE_TTL) return cachedBinance;

  try {
    const results = {};
    const symbols = Object.values(BINANCE_SYMBOLS);
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const entries = await Promise.allSettled(batch.map(async (sym) => {
        // Funding rate
        const frRes = await fetchWithTimeout(
          `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1`, 6000
        );
        let fundingRate = 0;
        if (frRes.ok) {
          const frData = await frRes.json();
          if (frData?.length > 0) fundingRate = parseFloat(frData[0].fundingRate) || 0;
        }

        // Open interest
        let openInterest = 0;
        const oiRes = await fetchWithTimeout(
          `https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`, 6000
        );
        if (oiRes.ok) {
          const oiData = await oiRes.json();
          openInterest = parseFloat(oiData.openInterest) || 0;
        }

        // Long/short ratio (top trader positions)
        let longShortRatio = 0.5;
        const lsRes = await fetchWithTimeout(
          `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`, 6000
        );
        if (lsRes.ok) {
          const lsData = await lsRes.json();
          if (lsData?.length > 0) {
            longShortRatio = parseFloat(lsData[0].longShortRatio) || 0.5;
          }
        }

        return { sym, fundingRate, openInterest, longShortRatio };
      }));

      for (const entry of entries) {
        if (entry.status === 'fulfilled' && entry.value) {
          results[entry.value.sym] = {
            fundingRate: entry.value.fundingRate,
            openInterest: entry.value.openInterest,
            longShortRatio: entry.value.longShortRatio,
          };
        }
      }
      // Polite delay between batches
      if (i + batchSize < symbols.length) await new Promise(r => setTimeout(r, 500));
    }

    // Map back to coin IDs
    const mapped = {};
    for (const [coinId, sym] of Object.entries(BINANCE_SYMBOLS)) {
      if (results[sym]) mapped[coinId] = results[sym];
    }

    cachedBinance = mapped;
    lastBinanceFetch = now;
    console.log(`📡 Binance: ${Object.keys(mapped).length} coins`);
    return mapped;
  } catch (e) {
    console.log(`⚠️ Binance: ${e.message}`);
    return null;
  }
}

/* ─────────────────────────────────────────────
   SIGNAL COMPUTATION
   ───────────────────────────────────────────── */
function computeSignal(coin, md, binanceData) {
  if (!md) return null;

  const prices = md.sparkline || [];
  if (prices.length < 20) return null;

  const price = prices[prices.length - 1];
  const close = prices;

  // RSI
  const rsiVal = rsi(close);

  // EMAs
  const ema8 = ema(close, 8);
  const ema21 = ema(close, 21);

  // Bollinger Bands
  const bollinger = bb(close);
  const bbPos = (price - bollinger.lower) / (bollinger.upper - bollinger.lower || 1);

  // MACD
  const m = macd(close);

  // Volume ratio vs average (approximate from sparkline data)
  // We don't have per-candle volume from sparkline, but we can use total_volume vs market cap
  const volRatio = md.mcap > 0 ? (md.vol24h / md.mcap) * 100 : 0;

  // Distance from 24h low
  const range24 = md.high24h - md.low24h || 1;
  const posInRange = ((price - md.low24h) / range24) * 100;

  /* ─── SCORING (trend-aware) ─── */
  let score = 0;
  const reasons = [];

  // Trend context — EMA8/EMA21 ratio + 7d momentum
  const emaRatio = ema8 / ema21;
  const trendStrength = md.change7d || 0;

  /* RSI (trend-adjusted) */
  // In strong uptrend, overbought is less bearish
  // In strong downtrend, oversold is less bullish
  const trendContextBull = trendStrength > 10 || emaRatio > 1.02 ? 0.5 : 1.0;
  const trendContextBear = trendStrength < -8 || emaRatio < 0.98 ? 0.5 : 1.0;

  if (rsiVal < 30) {
    const netScore = Math.round(4 * trendContextBull);
    if (netScore > 0) { score += netScore; reasons.push(`RSI ${rsiVal.toFixed(0)} — deeply oversold`); }
  } else if (rsiVal < 38) {
    const netScore = Math.round(2 * trendContextBull);
    if (netScore > 0) { score += netScore; reasons.push(`RSI ${rsiVal.toFixed(0)} — near oversold`); }
  } else if (rsiVal > 78) {
    const netScore = Math.round(-3 * trendContextBear);
    if (netScore < 0) { score += netScore; reasons.push(`RSI ${rsiVal.toFixed(0)} — overbought`); }
  } else if (rsiVal > 68) {
    const netScore = Math.round(-1 * trendContextBear);
    if (netScore < 0) { score += netScore; reasons.push(`RSI ${rsiVal.toFixed(0)} — elevated`); }
  }

  /* EMA Crossover */
  if (emaRatio > 1.025) { score += 3; reasons.push(`EMA bullish crossover (${emaRatio.toFixed(3)})`); }
  else if (emaRatio > 1.008) { score += 1; reasons.push(`EMA(8) ↑ EMA(21) — uptrend`); }
  else if (emaRatio < 0.975) { score -= 3; reasons.push(`EMA bearish crossover (${emaRatio.toFixed(3)})`); }
  else if (emaRatio < 0.992) { score -= 1; reasons.push(`EMA(8) ↓ EMA(21) — downtrend`); }

  /* Bollinger Bands */
  if (bbPos < 0.05) { score += 3; reasons.push(`Price at lower BB — bounce zone`); }
  else if (bbPos < 0.2) { score += 1; reasons.push(`Lower BB — value area`); }
  else if (bbPos > 0.95) { score -= 2; reasons.push(`Upper BB — resistance`); }
  else if (bbPos > 0.85) { score -= 1; reasons.push(`Near upper BB`); }

  /* MACD */
  if (m.line > 0 && m.line > (m.histogram > 0 ? 0 : 0)) {
    score += 2; reasons.push('MACD positive — momentum up');
  } else if (m.line < 0) {
    score -= 2; reasons.push('MACD negative — momentum down');
  }

  /* Volume */
  if (volRatio > 10) { score += 1; reasons.push(`Liquid (${volRatio.toFixed(0)}% vol/mcap)`); }
  else if (volRatio < 1) { score -= 1; reasons.push(`Thin (${volRatio.toFixed(1)}% vol/mcap)`); }

  /* 24h momentum */
  const dayChange = md.change24h || 0;
  if (dayChange > 6) { score += 2; reasons.push(`+${dayChange.toFixed(1)}% 24h — strong`); }
  else if (dayChange > 3) { score += 1; reasons.push(`+${dayChange.toFixed(1)}% 24h`); }
  else if (dayChange < -5) { score -= 2; reasons.push(`${dayChange.toFixed(1)}% 24h — selloff`); }
  else if (dayChange < -2) { score -= 1; reasons.push(`${dayChange.toFixed(1)}% 24h`); }

  /* Candle pattern */
  const l3 = prices.slice(-3);
  if (l3.length === 3 && l3[2] > l3[1] && l3[1] > l3[0]) { score += 2; reasons.push('3 green candles'); }
  else if (l3.length === 3 && l3[2] < l3[1] && l3[1] < l3[0]) { score -= 2; reasons.push('3 red candles'); }

  /* 7d momentum boost */
  if (trendStrength > 15) { score += 1; reasons.push(`+${trendStrength.toFixed(0)}% in 7d`); }
  else if (trendStrength < -12) { score -= 1; reasons.push(`${trendStrength.toFixed(0)}% in 7d`); }

  /* Derive direction */
  let direction, confidence;
  if (score >= 6) { direction = 'STRONG_BUY'; confidence = Math.min(94, 55 + score * 4); }
  else if (score >= 3) { direction = 'BUY'; confidence = Math.min(85, 50 + score * 6); }
  else if (score <= -6) { direction = 'STRONG_SELL'; confidence = Math.min(94, 55 + Math.abs(score) * 4); }
  else if (score <= -3) { direction = 'SELL'; confidence = Math.min(85, 50 + Math.abs(score) * 6); }
  else { direction = 'HOLD'; confidence = Math.max(15, Math.min(50, 30 + Math.abs(score) * 5)); }

  return {
    coinId: coin.id,
    name: coin.name,
    symbol: coin.sym,
    price,
    mcap: md.mcap,
    vol24h: md.vol24h,
    change24h: md.change24h,
    change7d: md.change7d,
    rsi: Math.round(rsiVal * 10) / 10,
    ema8: Math.round(ema8 * 100) / 100,
    ema21: Math.round(ema21 * 100) / 100,
    bbPos: Math.round(bbPos * 100) / 100,
    macd: Math.round(m.line * 100) / 100,
    volRatio: Math.round(volRatio * 10) / 10,
    score,
    direction,
    confidence: Math.round(confidence),
    reasons: reasons.slice(0, 4),
    description: reasons.slice(0, 2).join('. '),
    // Entry guidance: for BUY, limit slightly below or at market; for SELL, limit above
    entryPrice: direction === 'BUY' || direction === 'STRONG_BUY'
      ? Math.round(price * (1 - 0.002) * 100) / 100  // 0.2% below for limit buy
      : direction === 'SELL' || direction === 'STRONG_SELL'
        ? Math.round(price * (1 + 0.002) * 100) / 100 // 0.2% above for limit sell
        : null,
    stopLoss: direction === 'BUY' || direction === 'STRONG_BUY'
      ? Math.round(price * 0.95 * 100) / 100  // 5% below
      : direction === 'SELL' || direction === 'STRONG_SELL'
        ? Math.round(price * 1.05 * 100) / 100  // 5% above (for short)
        : null,
    takeProfit: direction === 'BUY' || direction === 'STRONG_BUY'
      ? Math.round(price * 1.12 * 100) / 100  // 12% above
      : direction === 'SELL' || direction === 'STRONG_SELL'
        ? Math.round(price * 0.88 * 100) / 100  // 12% below (for short)
        : null,
    timestamp: new Date().toISOString(),
    // Binance derivatives data (when available)
    fundingRate: binanceData?.[coin.id]?.fundingRate ?? null,
    openInterest: binanceData?.[coin.id]?.openInterest ?? null,
    longShortRatio: binanceData?.[coin.id]?.longShortRatio ?? null,
  };
}

/* ─────────────────────────────────────────────
   COIN ACCURACY TRACKER — learn which coins we're good at
   ───────────────────────────────────────────── */
const coinAccuracy = {}; // coinId -> { signals: { pred, correct }[], hits, total, streaks }

function recordSignalAccuracy(coinId, direction, confidence, actualPrice) {
  if (!coinAccuracy[coinId]) {
    coinAccuracy[coinId] = { signals: [], hits: 0, total: 0 };
  }
  // In a live system we'd compare prediction vs movement;
  // for now track calibration data
}

function getCoinReliability(coinId) {
  const c = coinAccuracy[coinId];
  if (!c || c.total < 3) return 1.0; // not enough data — trust the model
  return c.total > 0 ? c.hits / c.total : 0.5;
}

/* ─────────────────────────────────────────────
   CONVICTION FIREWALL — only surface what we can trust
   ───────────────────────────────────────────── */
function applyConvictionFirewall(signals) {
  for (const s of signals) {
    // Risk filters
    const rejectReasons = [];

    // 1. RSI too high for buys or too low for sells
    if ((s.direction === 'BUY' || s.direction === 'STRONG_BUY') && s.rsi > 80) {
      rejectReasons.push(`RSI ${s.rsi} — overbought, skip`);
    }
    if ((s.direction === 'SELL' || s.direction === 'STRONG_SELL') && s.rsi < 25) {
      rejectReasons.push(`RSI ${s.rsi} — oversold, skip`);
    }

    // 2. Volume too thin
    if (s.volRatio < 1.5 && (s.direction !== 'HOLD')) {
      rejectReasons.push(`Thin volume (${s.volRatio.toFixed(1)}% vol/mcap)`);
    }

    // 3. Low conviction — only STRONG_BUY/STRONG_SELL are actionable
    if (s.direction === 'BUY' || s.direction === 'SELL') {
      rejectReasons.push('Not top conviction — wait for STRONG signal');
    }

    if (rejectReasons.length > 0) {
      s.direction = 'HOLD';
      s.confidence = Math.min(45, Math.max(15, s.confidence));
      s.entryPrice = null;
      s.stopLoss = null;
      s.takeProfit = null;
      s._rejected = rejectReasons;
      s.reasons = [...rejectReasons];
      if (!s.description) s.description = rejectReasons[0];
    }

    // Cap confidence
    s.confidence = Math.min(98, Math.max(10, s.confidence));
  }
  return signals;
}

/* ─────────────────────────────────────────────
   PAPER TRADING ENGINE
   ───────────────────────────────────────────── */
/* ─────────────────────────────────────────────
   PAPER TRADING ENGINE (with SL/TP)
   ───────────────────────────────────────────── */
class PaperTrader {
  constructor() {
    this.positions = {};
    this.trades = [];
    this.startBalance = 10000;
    this.balance = 10000;
    this.maxPerPosition = 0.20;
    this.slPct = 0.05;   // 5% stop-loss
    this.tpPct = 0.12;   // 12% take-profit
    this.trailingActivationPct = 0.03; // activate trailing at 3% profit
    this.trailPct = 0.03;              // trail 3% below peak
    this.priceCache = {}; // coinId -> { price, fetchedAt }
    this.pricePollInterval = null;
    this.confidenceHits = {}; // confRange -> { hits, total }
  }

  checkSLTP(coinId, currentPrice) {
    const pos = this.positions[coinId];
    if (!pos) return null;
    const unrealized = pos.direction === 'LONG'
      ? (currentPrice - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - currentPrice) / pos.entryPrice;

    // Track peak price for trailing stop
    if (pos.direction === 'LONG' && currentPrice > pos.peakPrice) {
      pos.peakPrice = currentPrice;
    } else if (pos.direction === 'SHORT' && currentPrice < pos.peakPrice) {
      pos.peakPrice = currentPrice;
    }

    // Trailing stop: activate at 3% profit, trail 3% below peak
    if (unrealized >= this.trailingActivationPct) {
      const trailStop = pos.direction === 'LONG'
        ? pos.peakPrice * (1 - this.trailPct)
        : pos.peakPrice * (1 + this.trailPct);
      if (pos.direction === 'LONG' && trailStop > (pos.trailingStopPrice ?? 0)) {
        pos.trailingStopPrice = trailStop;
      } else if (pos.direction === 'SHORT' && (pos.trailingStopPrice === null || trailStop < pos.trailingStopPrice)) {
        pos.trailingStopPrice = trailStop;
      }
      // Check trailing stop hit
      if (pos.direction === 'LONG' && currentPrice <= pos.trailingStopPrice) return 'TRAILING_STOP';
      if (pos.direction === 'SHORT' && currentPrice >= pos.trailingStopPrice) return 'TRAILING_STOP';
    }

    if (unrealized <= -this.slPct) return 'STOP_LOSS';
    if (unrealized >= this.tpPct) return 'TAKE_PROFIT';
    return null;
  }

  async pollPrices() {
    try {
      const ids = Object.keys(this.positions).join(',');
      if (!ids) return;
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return;
      const data = await res.json();
      const now = Date.now();
      for (const [coinId, entry] of Object.entries(data)) {
        this.priceCache[coinId] = { price: entry.usd, fetchedAt: now };
        // Update peak price for trailing stop
        const pos = this.positions[coinId];
        if (pos) {
          if (pos.direction === 'LONG' && entry.usd > pos.peakPrice) {
            pos.peakPrice = entry.usd;
          } else if (pos.direction === 'SHORT' && entry.usd < pos.peakPrice) {
            pos.peakPrice = entry.usd;
          }
        }
        const trigger = this.checkSLTP(coinId, entry.usd);
        if (trigger) {
          this.closePosition(coinId, entry.usd, trigger);
        }
      }
    } catch (_) { /* silent — CG rate limits */ }
  }

  startPricePolling() {
    if (this.pricePollInterval) return;
    this.pricePollInterval = setInterval(() => this.pollPrices(), 60_000);
  }

  stopPricePolling() {
    if (this.pricePollInterval) {
      clearInterval(this.pricePollInterval);
      this.pricePollInterval = null;
    }
  }

  recordConfidenceCalibration(confidence, wasCorrect) {
    const bucket = confidence >= 90 ? '90-100'
      : confidence >= 80 ? '80-89'
      : confidence >= 70 ? '70-79'
      : confidence >= 60 ? '60-69'
      : confidence >= 50 ? '50-59'
      : '0-49';
    if (!this.confidenceHits[bucket]) this.confidenceHits[bucket] = { hits: 0, total: 0 };
    this.confidenceHits[bucket].total++;
    if (wasCorrect) this.confidenceHits[bucket].hits++;
  }

  getConfidenceCalibration() {
    const result = {};
    for (const [bucket, data] of Object.entries(this.confidenceHits)) {
      result[bucket] = {
        hits: data.hits,
        total: data.total,
        accuracy: data.total > 0 ? Math.round((data.hits / data.total) * 100) : 0,
      };
    }
    return result;
  }

  process(signals) {
    const buySignals = signals.filter(s => s.direction === 'BUY' || s.direction === 'STRONG_BUY').sort((a,b) => b.confidence - a.confidence);
    const sellSignals = signals.filter(s => s.direction === 'SELL' || s.direction === 'STRONG_SELL').sort((a,b) => b.confidence - a.confidence);

    // Check SL/TP via cached CG prices first (fresher than signal prices)
    for (const coinId of Object.keys(this.positions)) {
      const cached = this.priceCache[coinId];
      if (cached && (Date.now() - cached.fetchedAt) < 120_000) {
        const trigger = this.checkSLTP(coinId, cached.price);
        if (trigger) {
          this.closePosition(coinId, cached.price, trigger);
        }
      }
    }

    // Exit positions that contradict new signal
    for (const coinId of Object.keys(this.positions)) {
      const pos = this.positions[coinId];
      const sig = signals.find(s => s.coinId === coinId);
      if (!sig) continue;

      const shouldExit = (pos.direction === 'LONG' && (sig.direction === 'SELL' || sig.direction === 'STRONG_SELL'))
                      || (pos.direction === 'SHORT' && (sig.direction === 'BUY' || sig.direction === 'STRONG_BUY'));

      if (shouldExit) {
        this.closePosition(coinId, sig.price, 'SIGNAL_REVERSAL');
      }
    }

    // Enter new positions
    const openCount = Object.keys(this.positions).length;
    const slots = Math.min(5 - openCount, buySignals.length + sellSignals.length);
    if (slots <= 0) return;

    let entered = 0;
    for (const s of buySignals) {
      if (entered >= slots) break;
      if (this.positions[s.coinId]) continue;
      this.openPosition(s.coinId, 'LONG', s.price, `Signal: ${s.description || 'BUY signal'}`, s.confidence);
      entered++;
    }
    for (const s of sellSignals) {
      if (entered >= slots) break;
      if (this.positions[s.coinId]) continue;
      this.openPosition(s.coinId, 'SHORT', s.price, `Signal: ${s.description || 'SELL signal'}`, s.confidence);
      entered++;
    }

    if (openCount === 0 && entered > 0) this.startPricePolling();
  }

  openPosition(coinId, direction, price, reason, confidence) {
    const alloc = this.balance * this.maxPerPosition;
    const size = alloc / price;
    const slPrice = direction === 'LONG' ? price * (1 - this.slPct) : price * (1 + this.slPct);
    const tpPrice = direction === 'LONG' ? price * (1 + this.tpPct) : price * (1 - this.tpPct);
    this.positions[coinId] = {
      direction, entryPrice: price, size, entryAt: Date.now(), reason,
      confidence: confidence || 50,
      slPrice, tpPrice, pnl: 0, pnlPct: 0,
      trailingStopPrice: null, peakPrice: price,
    };
    this.balance -= alloc * (direction === 'LONG' ? 1 : 0);
  }

  closePosition(coinId, exitPrice, reason = 'SIGNAL_REVERSAL') {
    const pos = this.positions[coinId];
    if (!pos) return;

    const entryVal = pos.size * pos.entryPrice;
    const exitVal = pos.size * exitPrice;
    const pnl = pos.direction === 'LONG' ? exitVal - entryVal : entryVal - exitVal;
    const pnlPct = (pnl / entryVal) * 100;

    const trade = {
      coinId, direction: pos.direction,
      entryPrice: pos.entryPrice, exitPrice, size: pos.size,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
      entered: new Date(pos.entryAt).toISOString(),
      exited: new Date().toISOString(),
      reason: pos.reason,
      exitReason: reason,
      duration: Math.round((Date.now() - pos.entryAt) / 1000 / 60),
    };
    this.trades.push(trade);
    this.balance += entryVal + pnl;

    // Record confidence calibration
    this.recordConfidenceCalibration(pos.confidence, pnl > 0);

    delete this.positions[coinId];
    if (Object.keys(this.positions).length === 0) this.stopPricePolling();
  }

  getStatus(signals) {
    const openPositions = Object.entries(this.positions).map(([coinId, pos]) => {
      // Prefer cached CG price, then signal price, then entry
      const cached = this.priceCache[coinId];
      const sig = signals?.find(s => s.coinId === coinId);
      const markPrice = cached?.price || sig?.price || pos.entryPrice;

      const entryVal = pos.size * pos.entryPrice;
      const exitVal = pos.size * markPrice;
      const pnl = pos.direction === 'LONG' ? exitVal - entryVal : entryVal - exitVal;
      const pnlPct = (pnl / entryVal) * 100;
      return {
        coinId, direction: pos.direction,
        entryPrice: pos.entryPrice, currentPrice: markPrice, size: pos.size,
        value: Math.round(entryVal * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        slPrice: pos.slPrice, tpPrice: pos.tpPrice,
        duration: Math.round((Date.now() - pos.entryAt) / 1000 / 60),
        reason: pos.reason,
      };
    });

    const closedTrades = [...this.trades].reverse().slice(0, 100);
    const wins = this.trades.filter(t => t.pnl > 0).length;
    const losses = this.trades.filter(t => t.pnl < 0).length;
    const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0);
    const totalInvested = this.trades.reduce((s, t) => s + t.size * t.entryPrice, 0) + openPositions.reduce((s, p) => s + p.value, 0);
    const totalReturn = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
    const sharpeNumerator = this.trades.length > 1
      ? this.trades.reduce((s, t) => s + t.pnlPct, 0) / this.trades.length
      : 0;
    const sharpeDenom = this.trades.length > 1
      ? Math.sqrt(this.trades.reduce((s, t) => s + (t.pnlPct - sharpeNumerator) ** 2, 0) / (this.trades.length - 1))
      : 1;
    const sharpeRatio = sharpeDenom > 0 ? sharpeNumerator / sharpeDenom * Math.sqrt(365) : 0;

    return {
      balance: Math.round(this.balance * 100) / 100,
      startBalance: this.startBalance,
      equity: Math.round((this.balance + openPositions.reduce((s, p) => s + p.pnl, 0)) * 100) / 100,
      totalTrades: this.trades.length,
      wins, losses,
      winRate: this.trades.length > 0 ? Math.round((wins / this.trades.length) * 100) : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      avgTradePnl: this.trades.length > 0 ? Math.round((totalPnl / this.trades.length) * 100) / 100 : 0,
      bestTrade: this.trades.length > 0 ? Math.round(Math.max(...this.trades.map(t => t.pnlPct)) * 100) / 100 : 0,
      worstTrade: this.trades.length > 0 ? Math.round(Math.min(...this.trades.map(t => t.pnlPct)) * 100) / 100 : 0,
      avgDuration: this.trades.length > 0 ? Math.round(this.trades.reduce((s, t) => s + t.duration, 0) / this.trades.length) : 0,
      openPositions,
      recentTrades: closedTrades.slice(0, 30),
      confidenceCalibration: this.getConfidenceCalibration(),
      lastUpdated: new Date().toISOString(),
    };
  }
}

const trader = new PaperTrader();

/* ─────────────────────────────────────────────
   SIGNAL HISTORY — log every signal generation
   ───────────────────────────────────────────── */
class SignalHistory {
  constructor() {
    this.entries = [];
    this.maxEntries = 500;
  }

  record(signals, overview, timestamp) {
    const snapshot = {
      timestamp: timestamp || new Date().toISOString(),
      overview: { ...overview },
      signals: signals.map(s => ({
        coinId: s.coinId, symbol: s.symbol, direction: s.direction,
        confidence: s.confidence, score: s.score, price: s.price,
        rsi: s.rsi,
      })),
    };
    this.entries.push(snapshot);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getTimeline(limit = 30) {
    return [...this.entries].reverse().slice(0, limit);
  }

  getPerformance() {
    // For each coin, count how many times it was BUY vs SELL vs HOLD
    const coinStats = {};
    for (const entry of this.entries) {
      for (const s of entry.signals) {
        if (!coinStats[s.coinId]) {
          coinStats[s.coinId] = { symbol: s.symbol, buys: 0, sells: 0, holds: 0, total: 0, avgConf: 0, confSum: 0 };
        }
        const cs = coinStats[s.coinId];
        cs.total++;
        cs.confSum += s.confidence;
        if (s.direction === 'BUY' || s.direction === 'STRONG_BUY') cs.buys++;
        else if (s.direction === 'SELL' || s.direction === 'STRONG_SELL') cs.sells++;
        else cs.holds++;
      }
    }
    for (const cs of Object.values(coinStats)) {
      cs.avgConf = cs.total > 0 ? Math.round(cs.confSum / cs.total) : 0;
    }
    return {
      totalEntries: this.entries.length,
      firstEntry: this.entries.length > 0 ? this.entries[0].timestamp : null,
      lastEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : null,
      coins: Object.values(coinStats).sort((a, b) => b.total - a.total),
    };
  }
}

const signalHistory = new SignalHistory();

/* ─────────────────────────────────────────────
   BACKTEST ENGINE — replay last 30 days
   ───────────────────────────────────────────── */
let backtestCache = null;

async function getOHLC(days = 30) {
  const cacheKey = `bt_${days}`;
  if (backtestCache?.key === cacheKey && (Date.now() - backtestCache.fetched) < 3600_000) {
    return backtestCache.data;
  }
  // Use the existing market data sparklines (168 pts = 7 days hourly)
  // For >7 days, fetch market data for each past day range
  const result = {};
  let fetched = 0;

  // First, get today's sparkline from the existing market endpoint (always succeeds)
  const marketData = await fetchMarketData();
  if (marketData) {
    for (const coin of COINS) {
      const md = marketData[coin.id];
      if (md?.sparkline?.length >= 50) {
        result[coin.id] = md.sparkline;
        fetched++;
      }
    }
  }

  // For longer backtests, try to get additional history
  if (days > 7) {
    const extraDays = Math.min(days, 30);
    // Try fetching a few more days individually
    const topCoins = COINS.slice(0, 6); // limit to avoid rate limits
    for (const coin of topCoins) {
      if (result[coin.id] && result[coin.id].length >= 168) continue; // already have 7d
      try {
        const res = await fetchWithTimeout(
          `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart?vs_currency=usd&days=${extraDays}`,
          12000
        );
        if (res.ok) {
          const data = await res.json();
          const prices = (data.prices || []).map(p => p[1]);
          if (prices.length > 50) {
            result[coin.id] = prices;
            fetched++;
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      } catch (_) {}
    }
  }

  backtestCache = { key: cacheKey, data: result, fetched: Date.now() };
  console.log(`📊 Backtest: ${Object.keys(result).length}/${COINS.length} coins, ${days}d`);
  return result;
}

// Replay signals across historical data
function runBacktest(ohlc, coinIds = null) {
  const coinsToTest = coinIds || COINS.map(c => c.id);
  const results = {};

  for (const coinId of coinsToTest) {
    const prices = ohlc[coinId];
    if (!prices || prices.length < 100) continue;

    const coin = COINS.find(c => c.id === coinId);
    const trader = new PaperTrader();

    // Slide a 50-point window and generate signals every 6 periods
    const WINDOW = 50;
    const STEP = 6;
    let totalBuys = 0, totalSells = 0, winBuys = 0, winSells = 0;
    let buyPnl = 0, sellPnl = 0;

    for (let start = 0; start + WINDOW + 12 < prices.length; start += STEP) {
      const windowPrices = prices.slice(start, start + WINDOW);
      const lookahead = prices.slice(start + WINDOW, start + WINDOW + 12); // 12h forward

      // Compute indicators on window
      const currentPrice = windowPrices[windowPrices.length - 1];
      const rsiVal = rsi(windowPrices);
      const ema8 = ema(windowPrices, 8);
      const ema21 = ema(windowPrices, 21);
      const bollinger = bb(windowPrices);
      const bbPos = (currentPrice - bollinger.lower) / (bollinger.upper - bollinger.lower || 1);
      const m = macd(windowPrices);
      const emaRatio = ema8 / ema21;

      // Score it (simplified — same logic as computeSignal)
      let score = 0;
      const windowStart = windowPrices[0];
      const trendStrength = windowPrices.length > 168
        ? ((currentPrice - windowPrices[windowPrices.length - 169]) / windowPrices[windowPrices.length - 169]) * 100
        : 0;
      const trendBull = trendStrength > 10 || emaRatio > 1.02 ? 0.5 : 1.0;
      const trendBear = trendStrength < -8 || emaRatio < 0.98 ? 0.5 : 1.0;

      if (rsiVal < 30) score += Math.round(4 * trendBull);
      else if (rsiVal < 38) score += Math.round(2 * trendBull);
      else if (rsiVal > 78) score += Math.round(-3 * trendBear);
      else if (rsiVal > 68) score += Math.round(-1 * trendBear);

      if (emaRatio > 1.025) score += 3;
      else if (emaRatio > 1.008) score += 1;
      else if (emaRatio < 0.975) score -= 3;
      else if (emaRatio < 0.992) score -= 1;

      if (bbPos < 0.05) score += 3;
      else if (bbPos < 0.2) score += 1;
      else if (bbPos > 0.95) score -= 2;
      else if (bbPos > 0.85) score -= 1;

      if (m.line > 0) score += 2;
      else if (m.line < 0) score -= 2;

      // Get the forward price change over next 24h
      const forwardPrice = lookahead[lookahead.length - 1] || currentPrice;
      const forwardChange = ((forwardPrice - currentPrice) / currentPrice) * 100;

      let direction;
      if (score >= 3) direction = 'STRONG_BUY';
      else if (score >= 1) direction = 'BUY';
      else if (score <= -3) direction = 'STRONG_SELL';
      else if (score <= -1) direction = 'SELL';
      else direction = 'HOLD';

      if (direction === 'BUY' || direction === 'STRONG_BUY') {
        totalBuys++;
        // Check SL/TP over the next 24h
        let tradePnl = forwardChange;
        // Simulate SL: if at any point -5% intraday, SL hits
        // Simulate TP: if +12% at any point, TP hits
        for (const p of lookahead) {
          const chg = ((p - currentPrice) / currentPrice) * 100;
          if (chg <= -5) { tradePnl = -5; break; }
          if (chg >= 12) { tradePnl = 12; break; }
        }
        if (tradePnl > 0) winBuys++;
        buyPnl += tradePnl;
      } else if (direction === 'SELL' || direction === 'STRONG_SELL') {
        totalSells++;
        let tradePnl = -forwardChange; // short pnl
        for (const p of lookahead) {
          const chg = ((currentPrice - p) / currentPrice) * 100;
          if (chg <= -5) { tradePnl = -5; break; }
          if (chg >= 12) { tradePnl = 12; break; }
        }
        if (tradePnl > 0) winSells++; else if (tradePnl < 0) {}
        sellPnl += tradePnl;
      }
    }

    results[coinId] = {
      symbol: coin?.sym || coinId,
      name: coin?.name || coinId,
      totalSignals: totalBuys + totalSells,
      buys: totalBuys, buyWinRate: totalBuys > 0 ? Math.round((winBuys / totalBuys) * 100) : 0,
      sells: totalSells, sellWinRate: totalSells > 0 ? Math.round((winSells / totalSells) * 100) : 0,
      avgBuyPnl: totalBuys > 0 ? Math.round((buyPnl / totalBuys) * 10) / 10 : 0,
      avgSellPnl: totalSells > 0 ? Math.round((sellPnl / totalSells) * 10) / 10 : 0,
      totalBuyPnl: Math.round(buyPnl * 10) / 10,
      totalSellPnl: Math.round(sellPnl * 10) / 10,
      netPnl: Math.round((buyPnl + sellPnl) * 10) / 10,
    };
  }

  const coins = Object.values(results);
  const trades = coins.reduce((s, c) => s + c.totalSignals, 0);
  const wins = coins.reduce((s, c) => s + Math.round(c.buys * c.buyWinRate / 100) + Math.round(c.sells * c.sellWinRate / 100), 0);

  return {
    generatedAt: new Date().toISOString(),
    totalSignals: trades,
    overallWinRate: trades > 0 ? Math.round((wins / trades) * 100) : 0,
    totalNetPnl: Math.round(coins.reduce((s, c) => s + c.netPnl, 0) * 10) / 10,
    avgBuyWinRate: Math.round(coins.filter(c => c.buys > 0).reduce((s, c) => s + c.buyWinRate, 0) / Math.max(1, coins.filter(c => c.buys > 0).length)),
    avgSellWinRate: Math.round(coins.filter(c => c.sells > 0).reduce((s, c) => s + c.sellWinRate, 0) / Math.max(1, coins.filter(c => c.sells > 0).length)),
    avgNetPnlPerCoin: coins.length > 0 ? Math.round(coins.reduce((s, c) => s + c.netPnl, 0) / coins.length * 10) / 10 : 0,
    coins: Object.values(results).sort((a, b) => b.netPnl - a.netPnl),
  };
}

/* ─────────────────────────────────────────────
   WARM UP HERMES
   ───────────────────────────────────────────── */
console.log('🔥 Warming up Hermes (async)...');
setTimeout(() => {
  try {
    const warm = spawnSync('/opt/hermes/.venv/bin/python3',
      ['/opt/data/crypto-signals/hermes_chat.py', 'ping'],
      { timeout: 120000, env: { ...process.env, HERMES_HOME: '/opt/data', HERMES_QUIET: '1' },
        encoding: 'utf-8', cwd: '/opt/hermes' });
    if (warm.status === 0) console.log('✅ Hermes ready');
    else console.log('⚠️ Hermes warm-up:', (warm.stderr || '').substring(0, 100));
  } catch (e) {
    console.log('⚠️ Hermes warm-up error:', e.message.substring(0, 100));
  }
}, 100);

/* ─────────────────────────────────────────────
   MARKET OVERVIEW / SENTIMENT PROXY
   ───────────────────────────────────────────── */
function marketOverview(allSignals) {
  const btcSig = allSignals.find(s => s.coinId === 'bitcoin');
  const bullish = allSignals.filter(s => s.direction === 'BUY' || s.direction === 'STRONG_BUY').length;
  const bearish = allSignals.filter(s => s.direction === 'SELL' || s.direction === 'STRONG_SELL').length;
  const avgConf = allSignals.reduce((s, sig) => s + sig.confidence, 0) / allSignals.length;
  const largestGain = allSignals.reduce((best, s) => s.change24h > (best?.change24h || -Infinity) ? s : best, null);
  const largestLoss = allSignals.reduce((worst, s) => s.change24h < (worst?.change24h || Infinity) ? s : worst, null);

  // Sentiment: weighted by confidence
  const totalConf = allSignals.reduce((s, sig) => s + sig.confidence, 0) || 1;
  const bullConf = allSignals.filter(s => s.direction === 'BUY' || s.direction === 'STRONG_BUY').reduce((s, sig) => s + sig.confidence, 0);
  const bearConf = allSignals.filter(s => s.direction === 'SELL' || s.direction === 'STRONG_SELL').reduce((s, sig) => s + sig.confidence, 0);
  const weightedSentiment = totalConf > 0 ? (bullConf / totalConf) * 100 : 50;
  const neutralConf = totalConf - bullConf - bearConf;
  const netSentiment = ((bullConf + neutralConf * 0.5) / totalConf) * 100;

  return {
    btcPrice: btcSig?.price || 0,
    btcChange24h: btcSig?.change24h || 0,
    trackedCoins: allSignals.length,
    bullish,
    bearish,
    neutral: allSignals.length - bullish - bearish,
    sentimentLabel: netSentiment > 65 ? 'Bullish' : netSentiment < 35 ? 'Bearish' : 'Neutral',
    sentimentScore: Math.round(netSentiment),
    avgConfidence: Math.round(avgConf),
    bestPerformer: largestGain ? { id: largestGain.coinId, name: largestGain.name, change: largestGain.change24h } : null,
    worstPerformer: largestLoss ? { id: largestLoss.coinId, name: largestLoss.name, change: largestLoss.change24h } : null,
    signalQuality: allSignals.filter(s => s.confidence >= 70).length,
    topSignals: allSignals.filter(s => s.direction === 'STRONG_BUY' || s.direction === 'STRONG_SELL').length,
    actionableSignals: allSignals.filter(s => s.direction === 'STRONG_BUY').map(s => ({
      symbol: s.symbol, confidence: s.confidence, entryPrice: s.entryPrice, stopLoss: s.stopLoss, takeProfit: s.takeProfit
    })),
  };
}

/* ─────────────────────────────────────────────
   API ROUTES
   ───────────────────────────────────────────── */

/* GET /api/health — production health check */
app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  const uptimeStr = uptime < 60 ? `${uptime}s`
    : uptime < 3600 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
    : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
  res.json({
    status: 'ok',
    version: 2,
    uptime: uptimeStr,
    uptimeSeconds: uptime,
    started: new Date(START_TIME).toISOString(),
    coins: COINS.length,
    cacheAge: lastMarketFetch > 0 ? Math.round((Date.now() - lastMarketFetch) / 1000) + 's' : 'none',
    cacheFresh: (Date.now() - lastMarketFetch) < MARKET_TTL,
    memory: process.memoryUsage().rss > 1e9
      ? (process.memoryUsage().rss / 1e9).toFixed(2) + 'GB'
      : (process.memoryUsage().rss / 1e6).toFixed(0) + 'MB',
    paperTrades: trader.trades.length,
    openPositions: Object.keys(trader.positions).length,
    timestamp: new Date().toISOString(),
  });
});

/* GET /api/signals — main endpoint */
app.get('/api/signals', async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    if (!marketData) {
      return res.json({ success: false, error: 'Could not fetch market data', dataSource: 'error' });
    }

    // Fetch Binance derivatives data in parallel
    const binanceData = await fetchBinanceData();

    let signals = COINS.map(coin => computeSignal(coin, marketData[coin.id], binanceData)).filter(Boolean);
    signals = applyConvictionFirewall(signals);

    // Process paper trading
    trader.process(signals);

    const overview = marketOverview(signals);
    const portfolio = trader.getStatus(signals);

    // Record signal history
    signalHistory.record(signals, overview);

    signals.sort((a, b) => b.confidence - a.confidence);

    res.json({
      success: true,
      count: signals.length,
      generatedAt: new Date().toISOString(),
      signals,
      overview,
      portfolio,
      dataSource: binanceData ? 'coingecko-live+binance' : 'coingecko-live',
    });
  } catch (e) {
    console.error('Signals error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET /api/signals/:coinId — single coin detail */
app.get('/api/signals/:coinId', async (req, res) => {
  try {
    const coin = COINS.find(c => c.id === req.params.coinId);
    if (!coin) return res.status(404).json({ success: false, error: 'Not found' });

    const marketData = await fetchMarketData();
    if (!marketData || !marketData[coin.id]) {
      return res.status(503).json({ success: false, error: 'Market data unavailable' });
    }

    const sig = computeSignal(coin, marketData[coin.id]);
    res.json({ success: true, signal: sig });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET /api/conviction — only top actionable signals (no noise) */
app.get('/api/conviction', async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    if (!marketData) return res.status(503).json({ success: false, error: 'Data unavailable' });

    let signals = COINS.map(coin => computeSignal(coin, marketData[coin.id])).filter(Boolean);
    signals = applyConvictionFirewall(signals);

    const topSignals = signals
      .filter(s => s.direction === 'STRONG_BUY' || s.direction === 'STRONG_SELL')
      .sort((a, b) => b.confidence - a.confidence);

    const overview = marketOverview(signals);

    res.json({
      success: true,
      count: topSignals.length,
      generatedAt: new Date().toISOString(),
      signals: topSignals.map(s => ({
        coinId: s.coinId, name: s.name, symbol: s.symbol,
        price: s.price, direction: s.direction, confidence: s.confidence,
        entryPrice: s.entryPrice, stopLoss: s.stopLoss, takeProfit: s.takeProfit,
        reasons: s.reasons,
      })),
      overview: { topSignals: topSignals.length, sentimentLabel: overview.sentimentLabel, sentimentScore: overview.sentimentScore },
      dataSource: 'coingecko-live',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET /api/portfolio — paper trading status */
app.get('/api/portfolio', async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    if (marketData) {
      const signals = COINS.map(coin => computeSignal(coin, marketData[coin.id])).filter(Boolean);
      res.json({ success: true, portfolio: trader.getStatus(signals) });
    } else {
      res.json({ success: true, portfolio: trader.getStatus([]) });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET /api/overview — market sentiment */
app.get('/api/overview', async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    if (!marketData) return res.status(503).json({ success: false, error: 'Data unavailable' });

    const signals = COINS.map(coin => computeSignal(coin, marketData[coin.id])).filter(Boolean);
    // Don't trigger paper trading on overview-only requests
    res.json({ success: true, overview: marketOverview(signals) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* GET /api/history — signal timeline */
app.get('/api/history', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  res.json({
    success: true,
    timeline: signalHistory.getTimeline(limit),
    performance: signalHistory.getPerformance(),
  });
});

/* GET /api/backtest — run backtest over last 30 days */
app.get('/api/backtest', async (req, res) => {
  try {
    const days = Math.min(60, Math.max(7, parseInt(req.query.days) || 30));
    const ohlc = await getOHLC(days);
    const result = runBacktest(ohlc);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Backtest error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* POST /api/refresh — force refresh market data */
app.post('/api/refresh', async (req, res) => {
  lastMarketFetch = 0; // invalidate cache
  cachedMarket = null;
  try {
    const marketData = await fetchMarketData();
    res.json({ success: true, message: marketData ? 'Refreshed' : 'Failed' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

/* POST /api/chat — Hermes AI chat */
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
      { role: 'system', content: 'You are Hermes, an AI assistant on a crypto signal platform. You analyze market signals, technical patterns (RSI, EMAs, Bollinger Bands, MACD), and answer trading questions. Be direct and helpful. You can reference current market data if relevant.' }
    ]);
  }

  const history = chatSessions.get(sid);
  history.push({ role: 'user', content: message });
  if (history.length > MAX_CHAT_HISTORY) {
    history.splice(1, history.length - MAX_CHAT_HISTORY);
  }

  try {
    const result = spawnSync(
      '/opt/hermes/.venv/bin/python3',
      ['/opt/data/crypto-signals/hermes_chat.py', message],
      { timeout: 180000, maxBuffer: 50 * 1024,
        env: { ...process.env, HERMES_HOME: '/opt/data', HERMES_QUIET: '1' },
        encoding: 'utf-8', cwd: '/opt/hermes' }
    );

    let reply = "I'm not sure how to respond to that.";
    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed?.reply) reply = parsed.reply;
      } catch { reply = result.stdout.trim(); }
    } else if (result.stderr) {
      console.error('Chat stderr:', result.stderr.substring(0, 200));
    }

    history.push({ role: 'assistant', content: reply });
    res.json({ success: true, reply, sessionId: sid });
  } catch (err) {
    const fallbacks = [
      "I'm in offline mode. Check the signal board — look for RSI < 35 oversold plays or > 65 overbought warnings.",
      "AI backend isn't reachable. The dashboard shows CoinGecko live data with RSI, EMA crossovers, MACD, and Bollinger analysis per coin.",
    ];
    const reply = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    history.push({ role: 'assistant', content: reply });
    res.json({ success: true, reply, sessionId: sid, fallback: true });
  }
});

/* ─────────────────────────────────────────────
   STATIC FILES + SPA FALLBACK
   ───────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'dist')));
app.get('{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

/* ─────────────────────────────────────────────
   START
   ───────────────────────────────────────────── */
const PORT = process.env.PORT || 5151;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Crypto Signals on :${PORT} (${COINS.length} coins, CoinGecko live)`);
  // Pre-warm backtest data in background
  setTimeout(async () => {
    console.log('📊 Pre-warming backtest data...');
    await getOHLC(30);
    console.log('📊 Backtest data ready');
  }, 5000);
});
