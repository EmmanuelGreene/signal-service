import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

/* ─── Types ─── */
interface Signal {
  coinId: string; name: string; symbol: string; price: number;
  mcap: number; vol24h: number;
  change24h: number; change7d: number;
  rsi: number; ema8: number; ema21: number;
  bbPos: number; macd: number; volRatio: number;
  score: number;
  direction: 'STRONG_BUY'|'BUY'|'HOLD'|'SELL'|'STRONG_SELL';
  confidence: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reasons: string[]; description: string;
  timestamp: string;
}

interface Position {
  coinId: string; direction: string; entryPrice: number; currentPrice: number; size: number;
  value: number; pnl: number; pnlPct: number; duration: number; reason: string;
}
interface Trade {
  coinId: string; direction: string; entryPrice: number; exitPrice: number; size: number;
  pnl: number; pnlPct: number; entered: string; exited: string; reason: string; duration: number;
}
interface Portfolio {
  balance: number; startBalance: number; equity: number;
  totalTrades: number; wins: number; losses: number; winRate: number;
  totalPnl: number; totalReturn: number;
  sharpeRatio: number; avgTradePnl: number;
  bestTrade: number; worstTrade: number;
  openPositions: Position[];
  recentTrades: Trade[]; lastUpdated: string;
}
interface Overview {
  btcPrice: number; btcChange24h: number;
  trackedCoins: number; bullish: number; bearish: number; neutral: number;
  sentimentLabel: string; sentimentScore: number;
  avgConfidence: number; signalQuality: number;
  bestPerformer: { id: string; name: string; change: number } | null;
  worstPerformer: { id: string; name: string; change: number } | null;
}
interface BacktestCoin {
  symbol: string; name: string; buys: number; sells: number;
  buyWinRate: number; sellWinRate: number;
  avgBuyPnl: number; avgSellPnl: number; netPnl: number;
}
interface BacktestResult {
  totalSignals: number; overallWinRate: number;
  totalNetPnl: number; avgNetPnlPerCoin: number;
  avgBuyWinRate: number; avgSellWinRate: number;
  coins: BacktestCoin[];
}

/* ─── Helpers ─── */
function fmtPrice(p: number): string {
  if (!p) return '$0';
  if (p < 0.01) return `$${p.toFixed(6)}`;
  if (p < 1) return `$${p.toFixed(4)}`;
  if (p < 1000) return `$${p.toFixed(2)}`;
  if (p < 1e6) return `$${(p/1000).toFixed(1)}K`;
  return `$${(p/1e6).toFixed(2)}M`;
}
function fmtLarge(n: number): string {
  if (!n) return '$0';
  if (n >= 1e12) return `$${(n/1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  return `$${(n/1000).toFixed(0)}K`;
}
function fmtPct(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function dirLabel(d: string): string {
  switch(d) { case 'STRONG_BUY': return '▲▲ STRONG BUY'; case 'BUY': return '▲ BUY'; case 'SELL': return '▼ SELL'; case 'STRONG_SELL': return '▼▼ STRONG SELL'; default: return '— HOLD'; }
}
function dirColor(d: string): string {
  switch(d) { case 'STRONG_BUY': return '#00c853'; case 'BUY': return '#69f0ae'; case 'STRONG_SELL': return '#ff1744'; case 'SELL': return '#ff8a80'; default: return '#9e9e9e'; }
}
function confColor(c: number): string { return c >= 80 ? '#00c853' : c >= 60 ? '#ffd600' : '#78909c'; }

/* ─── Chat Component ─── */
function ChatSidebar() {
  const [messages, setMessages] = useState<{role:string,content:string}[]>([
    { role: 'assistant', content: "Hey, I'm Hermes. Ask me about any coin or the market." }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sid, setSid] = useState<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  const send = async () => {
    if (!input.trim() || loading) return;
    const msg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setLoading(true);
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, sessionId: sid }) });
      const d = await r.json();
      if (d.sessionId) setSid(d.sessionId);
      setMessages(prev => [...prev, { role: 'assistant', content: d.reply }]);
    } catch { setMessages(prev => [...prev, { role: 'assistant', content: 'AI offline. Check the dashboard signals.' }]); }
    finally { setLoading(false); }
  };
  return (
    <div className="chat-sidebar">
      <div className="chat-header">💬 Trade Chat</div>
      <div className="chat-messages">
        {messages.map((m, i) => (<div key={i} className={`chat-msg ${m.role}`}><div className="chat-bubble">{m.content}</div></div>))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input className="chat-input" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Ask about a coin..." disabled={loading} />
        <button className="chat-send" onClick={send} disabled={loading}>{loading ? '…' : '→'}</button>
      </div>
    </div>
  );
}

/* ─── Backtest Panel ─── */
function BacktestPanel({ data }: { data: BacktestResult | null }) {
  if (!data) return null;
  const coins = data.coins || [];
  const sorted = [...coins].sort((a, b) => b.netPnl - a.netPnl);
  return (
    <details className="backtest-panel">
      <summary className="backtest-summary">
        📊 Backtest: {data.totalSignals} signals · {data.overallWinRate}% WR · {data.totalNetPnl >= 0 ? '+' : ''}{data.totalNetPnl}% net
      </summary>
      <div className="backtest-body">
        <div className="backtest-stats">
          <span>Buy WR: <b className="up">{data.avgBuyWinRate}%</b></span>
          <span>Sell WR: <b className="dn">{data.avgSellWinRate}%</b></span>
          <span>Net/Coin: <b>{data.avgNetPnlPerCoin >= 0 ? '+' : ''}{data.avgNetPnlPerCoin}%</b></span>
        </div>
        <div className="bt-grid">
          {sorted.map(c => (
            <div key={c.symbol} className="bt-coin">
              <span className="bt-sym">{c.symbol}</span>
              <span className={`bt-pnl ${c.netPnl >= 0 ? 'up' : 'dn'}`}>{c.netPnl >= 0 ? '+' : ''}{c.netPnl}%</span>
              <span className="bt-detail">B:{c.buys}({c.buyWinRate}% {c.avgBuyPnl >= 0 ? '+' : ''}{c.avgBuyPnl.toFixed(1)})</span>
              <span className="bt-detail">S:{c.sells}({c.sellWinRate}% {c.avgSellPnl >= 0 ? '+' : ''}{c.avgSellPnl.toFixed(1)})</span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

/* ─── Signal Card ─── */
function SignalCard({ s }: { s: Signal }) {
  return (
    <div className="card" style={{ borderLeftColor: dirColor(s.direction) }}>
      <div className="card-top">
        <div className="card-coin">
          <div className="coin-avatar">{s.symbol.slice(0, 2)}</div>
          <div>
            <div className="coin-name">{s.name}</div>
            <div className="coin-sym">{s.symbol} · {fmtLarge(s.mcap)}</div>
          </div>
        </div>
        <div className="card-dir" style={{ background: dirColor(s.direction), color: s.direction.includes('STRONG') ? '#fff' : '#000' }}>
          {dirLabel(s.direction)}
        </div>
      </div>

      <div className="card-price-row">
        <span className="price">{fmtPrice(s.price)}</span>
        <span className={`chg ${s.change24h >= 0 ? 'up' : 'dn'}`}>{fmtPct(s.change24h)}</span>
      </div>

      <div className="card-conf">
        <div className="conf-bar-bg"><div className="conf-bar" style={{ width: `${s.confidence}%`, background: confColor(s.confidence) }} /></div>
        <span className="conf-pct" style={{ color: confColor(s.confidence) }}>{s.confidence}%</span>
      </div>

      {/* Entry / Stop / Target — only for actionable signals */}
      {(s.direction === 'BUY' || s.direction === 'STRONG_BUY' || s.direction === 'SELL' || s.direction === 'STRONG_SELL') && s.entryPrice && (
        <div className="card-entry">
          <div><span className="ml">Entry</span><span className="ev">{fmtPrice(s.entryPrice)}</span></div>
          <div><span className="ml">Stop</span><span className="ev dn">{fmtPrice(s.stopLoss!)}</span></div>
          <div><span className="ml">Target</span><span className="ev up">{fmtPrice(s.takeProfit!)}</span></div>
        </div>
      )}

      <div className="card-metrics">
        <div><span className="ml">Score</span><span className={`mv ${s.score > 0 ? 'up' : s.score < 0 ? 'dn' : ''}`}>{s.score > 0 ? '+' : ''}{s.score}</span></div>
        <div><span className="ml">RSI</span><span className="mv" style={{ color: s.rsi < 35 ? '#00c853' : s.rsi > 65 ? '#ff1744' : '#e6edf3' }}>{s.rsi}</span></div>
        <div><span className="ml">7d</span><span className={`mv ${s.change7d >= 0 ? 'up' : 'dn'}`}>{fmtPct(s.change7d)}</span></div>
        <div><span className="ml">BB%</span><span className="mv">{s.bbPos.toFixed(2)}</span></div>
      </div>

      <div className="card-metrics">
        <div><span className="ml">EMA8</span><span className="mv">{fmtPrice(s.ema8)}</span></div>
        <div><span className="ml">EMA21</span><span className="mv">{fmtPrice(s.ema21)}</span></div>
        <div><span className="ml">MACD</span><span className={`mv ${s.macd > 0 ? 'up' : 'dn'}`}>{s.macd.toFixed(1)}</span></div>
        <div><span className="ml">Vol/MCap</span><span className="mv">{s.volRatio.toFixed(1)}%</span></div>
      </div>

      <div className="card-reasons">
        {s.reasons.map((r, i) => (<div key={i} className="reason">{r}</div>))}
      </div>
    </div>
  );
}

/* ─── Main App ─── */
function App() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<string>('ALL');
  const [sort, setSort] = useState<string>('confidence');
  const [showChat, setShowChat] = useState(false);
  const [dataSource, setDataSource] = useState('');
  const [lastUpdate, setLastUpdate] = useState('');
  const [btLoading, setBtLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/signals');
      const d = await r.json();
      if (d.success) {
        setSignals(d.signals || []);
        setOverview(d.overview || null);
        setPortfolio(d.portfolio || null);
        setDataSource(d.dataSource || '');
        setLastUpdate(d.generatedAt || '');
      } else { setError(d.error || 'API error'); }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const loadBacktest = useCallback(async () => {
    setBtLoading(true);
    try {
      const r = await fetch('/api/backtest?days=7');
      const d = await r.json();
      if (d.success) setBacktest(d as BacktestResult);
    } catch (_) {}
    finally { setBtLoading(false); }
  }, []);

  useEffect(() => { load(); const i = setInterval(load, 60_000); return () => clearInterval(i); }, [load]);
  useEffect(() => { loadBacktest(); }, [loadBacktest]);

  const refresh = async () => {
    setLoading(true);
    await fetch('/api/refresh', { method: 'POST' });
    setTimeout(() => { load(); loadBacktest(); }, 2000);
  };

  const filtered = signals
    .filter(s => tab === 'ALL' || s.direction === tab)
    .sort((a, b) => {
      if (sort === 'confidence') return b.confidence - a.confidence;
      if (sort === 'rsi') return a.rsi - b.rsi;
      if (sort === 'score') return b.score - a.score;
      if (sort === 'change24h') return Math.abs(b.change24h) - Math.abs(a.change24h);
      return 0;
    });

  const tabs = ['ALL', 'STRONG_BUY', 'BUY', 'SELL', 'STRONG_SELL', 'HOLD'];
  const counts: Record<string, number> = { ALL: signals.length };
  signals.forEach(s => { counts[s.direction] = (counts[s.direction] || 0) + 1; });

  return (
    <div className="app">
      <div className={`main-area ${showChat ? 'with-chat' : ''}`}>
        <header className="header">
          <div className="header-left">
            <div className="brand">📊 Crypto Signals <span className="badge beta">LIVE</span></div>
            <div className="subtitle">CoinGecko · RSI · EMA(8/21) · MACD · BB · Paper Trading</div>
          </div>
          <div className="header-right">
            {lastUpdate && <span className="update-time">{new Date(lastUpdate).toLocaleTimeString()}</span>}
            {dataSource && <span className="data-source">{dataSource}</span>}
            <button className="btn" onClick={refresh} disabled={loading}>↻ Refresh</button>
            <button className={`btn ${showChat ? 'active' : ''}`} onClick={() => setShowChat(!showChat)}>💬</button>
          </div>
        </header>

        {/* OVERVIEW BAR */}
        {overview && (
          <div className="overview-bar">
            <div className="ov-item"><span className="ov-label">BTC</span><span className="ov-val">{fmtPrice(overview.btcPrice)}</span><span className={`ov-chg ${overview.btcChange24h >= 0 ? 'up' : 'dn'}`}>{fmtPct(overview.btcChange24h)}</span></div>
            <div className="ov-divider" />
            <div className="ov-item"><span className="ov-label">Sentiment</span><span className={`ov-val ${overview.sentimentLabel === 'Bullish' ? 'up' : overview.sentimentLabel === 'Bearish' ? 'dn' : ''}`}>{overview.sentimentLabel} ({overview.sentimentScore})</span></div>
            <div className="ov-divider" />
            <div className="ov-item"><span className="ov-label">BUY/SELL</span><span className="ov-val up">{overview.bullish}</span><span className="ov-sep">/</span><span className="ov-val dn">{overview.bearish}</span><span className="ov-text">({overview.neutral} HOLD)</span></div>
            <div className="ov-divider" />
            <div className="ov-item"><span className="ov-label">Avg Conf</span><span className="ov-val">{overview.avgConfidence}%</span></div>
            {overview.bestPerformer && (<><div className="ov-divider" /><div className="ov-item"><span className="ov-label">Best</span><span className="ov-val up">{overview.bestPerformer.name} {fmtPct(overview.bestPerformer.change)}</span></div></>)}
            {overview.worstPerformer && (<><div className="ov-divider" /><div className="ov-item"><span className="ov-label">Worst</span><span className="ov-val dn">{overview.worstPerformer.name} {fmtPct(overview.worstPerformer.change)}</span></div></>)}
          </div>
        )}

        {/* PORTFOLIO BAR */}
        {portfolio && (
          <div className="portfolio-bar">
            <div className="pv-item"><span className="pv-label">Paper P&L</span><span className={`pv-val ${portfolio.totalPnl >= 0 ? 'up' : 'dn'}`}>{fmtPct(portfolio.totalReturn)}</span><span className="pv-sub">(${portfolio.totalPnl >= 0 ? '+' : ''}${Math.abs(portfolio.totalPnl).toFixed(0)})</span></div>
            <div className="ov-divider" />
            <div className="pv-item"><span className="pv-label">Equity</span><span className="pv-val">{fmtPrice(portfolio.equity)}</span></div>
            <div className="ov-divider" />
            <div className="pv-item"><span className="pv-label">Win Rate</span><span className="pv-val">{portfolio.winRate}%</span><span className="pv-sub">({portfolio.wins}W/{portfolio.losses}L)</span></div>
            <div className="ov-divider" />
            <div className="pv-item"><span className="pv-label">Trades</span><span className="pv-val">{portfolio.totalTrades}</span></div>
            <div className="ov-divider" />
            <div className="pv-item"><span className="pv-label">Open</span><span className="pv-val">{portfolio.openPositions.length}</span></div>
            {portfolio.sharpeRatio > 0 && (<><div className="ov-divider" /><div className="pv-item"><span className="pv-label">Sharpe</span><span className="pv-val">{portfolio.sharpeRatio.toFixed(1)}</span></div></>)}
          </div>
        )}

        {/* BACKTEST PANEL */}
        <BacktestPanel data={backtest} />
        {btLoading && !backtest && <div className="loading"><div className="spinner" /> Running backtest...</div>}

        {/* TABS */}
        <div className="tabs">
          {tabs.map(t => {
            const isActive = tab === t;
            const c = t === 'ALL' ? '#58a6ff' : t === 'STRONG_BUY' ? '#00c853' : t === 'BUY' ? '#69f0ae' : t === 'SELL' ? '#ff8a80' : t === 'STRONG_SELL' ? '#ff1744' : '#9e9e9e';
            return (
              <button key={t} className={`tab ${isActive ? 'active' : ''}`} style={isActive ? { borderColor: c, color: c } : {}} onClick={() => setTab(t)}>
                {t === 'ALL' ? 'All' : dirLabel(t).replace(/[▲▼ ]/g, '')} {counts[t] ? `(${counts[t]})` : ''}
              </button>
            );
          })}
        </div>

        {/* SORT */}
        <div className="toolbar">
          <div className="sort-ctrls">
            <span className="sort-label">Sort:</span>
            {['confidence', 'score', 'rsi', 'change24h'].map(s => (
              <button key={s} className={`sort-btn ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
                {s === 'confidence' ? 'Confidence' : s === 'score' ? 'Score' : s === 'rsi' ? 'RSI' : '24h Δ'}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {loading && signals.length === 0 ? (
          <div className="loading"><div className="spinner" /> Fetching live data from CoinGecko...</div>
        ) : (
          <div className="grid">
            {filtered.map(s => <SignalCard key={s.coinId} s={s} />)}
          </div>
        )}
      </div>

      {showChat && <ChatSidebar />}
    </div>
  );
}

export default App
