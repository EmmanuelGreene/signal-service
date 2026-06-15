import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

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

async function fetchWithTimeout(url, ms = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

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
    return null;
  }
}

/* ─────────────────────────────────────────────
   SIGNAL COMPUTATION
   ───────────────────────────────────────────── */
function computeSignal(coin, md) {
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
    timestamp: new Date().toISOString(),
  };
}

/* ─────────────────────────────────────────────
   RELATIVE RANKING — always produces actionables
   ───────────────────────────────────────────── */
function applyRelativeRanking(signals) {
  if (signals.length < 3) return signals;

  const scores = signals.map(s => ({ id: s.coinId, score: s.score }));
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top3 = sorted.slice(0, 3);
  const bot3 = sorted.slice(-3);

  for (const s of signals) {
    const isTop = top3.find(t => t.id === s.coinId);
    const isBot = bot3.find(t => t.id === s.coinId);

    if (isTop && s.direction === 'HOLD') {
      s.direction = 'BUY';
      s.confidence = Math.round(Math.max(s.confidence, 55));
      s.reasons.unshift('Top 3 signal score — relative strength leader');
      s.description = s.reasons.slice(0, 2).join('. ');
    }
    if (isBot && s.direction === 'HOLD') {
      s.direction = 'SELL';
      s.confidence = Math.round(Math.max(s.confidence, 55));
      s.reasons.unshift('Bottom 3 signal score — relative weakness');
      s.description = s.reasons.slice(0, 2).join('. ');
    }
    // Promote strong ones
    if (isTop && s.direction === 'BUY' && s.confidence < 85) {
      s.direction = 'STRONG_BUY';
      s.confidence = Math.round(Math.min(95, s.confidence + 12));
    }
    if (isBot && s.direction === 'SELL' && s.confidence < 85) {
      s.direction = 'STRONG_SELL';
      s.confidence = Math.round(Math.min(95, s.confidence + 12));
    }
    s.confidence = Math.min(98, Math.max(10, s.confidence));
  }

  return signals;
}

/* ─────────────────────────────────────────────
   PAPER TRADING ENGINE
   ───────────────────────────────────────────── */
class PaperTrader {
  constructor() {
    this.positions = {};   // coinId -> {entryPrice, size, direction, entryAt, reason}
    this.trades = [];      // closed trades
    this.startBalance = 10000;
    this.balance = 10000;
    this.maxPerPosition = 0.20; // 20% per position
  }

  process(signals) {
    const buySignals = signals.filter(s => s.direction === 'BUY' || s.direction === 'STRONG_BUY').sort((a,b) => b.confidence - a.confidence);
    const sellSignals = signals.filter(s => s.direction === 'SELL' || s.direction === 'STRONG_SELL').sort((a,b) => b.confidence - a.confidence);

    // Exit positions that contradict new signal
    for (const coinId of Object.keys(this.positions)) {
      const pos = this.positions[coinId];
      const sig = signals.find(s => s.coinId === coinId);
      if (!sig) continue;

      const shouldExit = (pos.direction === 'LONG' && (sig.direction === 'SELL' || sig.direction === 'STRONG_SELL'))
                      || (pos.direction === 'SHORT' && (sig.direction === 'BUY' || sig.direction === 'STRONG_BUY'));

      if (shouldExit) {
        this.closePosition(coinId, sig.price);
      }
    }

    // Enter new positions (limit to 5 concurrent)
    const openCount = Object.keys(this.positions).length;
    const slots = Math.min(5 - openCount, buySignals.length + sellSignals.length);
    if (slots <= 0) return;

    let entered = 0;
    for (const s of buySignals) {
      if (entered >= slots) break;
      if (this.positions[s.coinId]) continue;
      this.openPosition(s.coinId, 'LONG', s.price, `Signal: ${s.description || 'BUY signal'}`);
      entered++;
    }
    for (const s of sellSignals) {
      if (entered >= slots) break;
      if (this.positions[s.coinId]) continue;
      // For short, flip the direction meaning
      this.openPosition(s.coinId, 'SHORT', s.price, `Signal: ${s.description || 'SELL signal'}`);
      entered++;
    }
  }

  openPosition(coinId, direction, price, reason) {
    const alloc = this.balance * this.maxPerPosition;
    const size = alloc / price;
    this.positions[coinId] = {
      direction,
      entryPrice: price,
      size,
      entryAt: Date.now(),
      reason,
      pnl: 0,
      pnlPct: 0,
    };
    this.balance -= alloc * (direction === 'LONG' ? 1 : 0); // shorts don't cost upfront in paper
    // Track the allocated balance as a hold
  }

  closePosition(coinId, exitPrice) {
    const pos = this.positions[coinId];
    if (!pos) return;

    const entryVal = pos.size * pos.entryPrice;
    const exitVal = pos.size * exitPrice;
    const pnl = pos.direction === 'LONG' ? exitVal - entryVal : entryVal - exitVal;
    const pnlPct = (pnl / entryVal) * 100;

    const trade = {
      coinId,
      direction: pos.direction,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
      entered: new Date(pos.entryAt).toISOString(),
      exited: new Date().toISOString(),
      reason: pos.reason,
      duration: Math.round((Date.now() - pos.entryAt) / 1000 / 60), // minutes
    };
    this.trades.push(trade);
    this.balance += entryVal + pnl; // restore entry + profit
    delete this.positions[coinId];
  }

  getStatus(signals) {
    const openPositions = Object.entries(this.positions).map(([coinId, pos]) => {
      const sig = signals.find(s => s.coinId === coinId);
      const markPrice = sig ? sig.price : pos.entryPrice;
      const entryVal = pos.size * pos.entryPrice;
      const exitVal = pos.size * markPrice;
      const pnl = pos.direction === 'LONG' ? exitVal - entryVal : entryVal - exitVal;
      const pnlPct = (pnl / entryVal) * 100;
      return {
        coinId,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        currentPrice: markPrice,
        size: pos.size,
        value: Math.round(entryVal * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        duration: Math.round((Date.now() - pos.entryAt) / 1000 / 60),
        reason: pos.reason,
      };
    });

    const closedTrades = [...this.trades].reverse().slice(0, 50);
    const wins = this.trades.filter(t => t.pnl > 0).length;
    const losses = this.trades.filter(t => t.pnl < 0).length;
    const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0);
    const totalInvested = this.trades.reduce((s, t) => s + t.size * t.entryPrice, 0) + openPositions.reduce((s, p) => s + p.value, 0);
    const totalReturn = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    return {
      balance: Math.round(this.balance * 100) / 100,
      startBalance: this.startBalance,
      equity: Math.round((this.balance + openPositions.reduce((s, p) => s + p.pnl, 0)) * 100) / 100,
      totalTrades: this.trades.length,
      wins,
      losses,
      winRate: this.trades.length > 0 ? Math.round((wins / this.trades.length) * 100) : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      openPositions,
      recentTrades: closedTrades.slice(0, 20),
      lastUpdated: new Date().toISOString(),
    };
  }
}

const trader = new PaperTrader();

/* ─────────────────────────────────────────────
   WARM UP HERMES
   ───────────────────────────────────────────── */
console.log('🔥 Warming up Hermes...');
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
  };
}

/* ─────────────────────────────────────────────
   API ROUTES
   ───────────────────────────────────────────── */

/* GET /api/signals — main endpoint */
app.get('/api/signals', async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    if (!marketData) {
      return res.json({ success: false, error: 'Could not fetch market data', dataSource: 'error' });
    }

    let signals = COINS.map(coin => computeSignal(coin, marketData[coin.id])).filter(Boolean);
    signals = applyRelativeRanking(signals);

    // Process paper trading
    trader.process(signals);

    const overview = marketOverview(signals);
    const portfolio = trader.getStatus(signals);

    signals.sort((a, b) => b.confidence - a.confidence);

    res.json({
      success: true,
      count: signals.length,
      generatedAt: new Date().toISOString(),
      signals,
      overview,
      portfolio,
      dataSource: 'coingecko-live',
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
});
