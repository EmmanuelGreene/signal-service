import { useState, useEffect, useCallback } from 'react'
import './App.css'

interface Signal {
  coinId: string
  name: string
  symbol: string
  image: string
  price: number
  change24h: number
  change7d: number
  rsi: number
  volumeRatio: number
  direction: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL'
  confidence: number
  description: string
  reasons: string[]
  bullScore: number
  bearScore: number
  timestamp: string
}

function fmtPrice(p: number): string {
  if (p < 0.01) return `$${p.toFixed(6)}`
  if (p < 1) return `$${p.toFixed(4)}`
  if (p < 1000) return `$${p.toFixed(2)}`
  if (p < 1e6) return `$${(p / 1000).toFixed(1)}K`
  return `$${(p / 1e6).toFixed(2)}M`
}

function dirLabel(d: string) {
  switch(d) {
    case 'STRONG_BUY': return '▲▲ STRONG BUY'
    case 'BUY': return '▲ BUY'
    case 'SELL': return '▼ SELL'
    case 'STRONG_SELL': return '▼▼ STRONG SELL'
    default: return '— HOLD'
  }
}

function dirColor(d: string) {
  if (d === 'STRONG_BUY') return '#00c853'
  if (d === 'BUY') return '#69f0ae'
  if (d === 'STRONG_SELL') return '#ff1744'
  if (d === 'SELL') return '#ff8a80'
  return '#9e9e9e'
}

function confColor(c: number) {
  if (c >= 80) return '#00c853'
  if (c >= 60) return '#ffd600'
  return '#78909c'
}

function App() {
  const [signals, setSignals] = useState<Signal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<string>('ALL')
  const [sort, setSort] = useState<string>('confidence')
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdate, setLastUpdate] = useState('')

  const loadSignals = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/signals')
      const d = await r.json()
      if (d.success && d.signals) {
        setSignals(d.signals)
        setLastUpdate(d.generatedAt)
        setRefreshing(d.refreshing || false)
      } else {
        setError('API error')
      }
    } catch(e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSignals(); const i = setInterval(loadSignals, 60_000); return () => clearInterval(i) }, [loadSignals])

  const refresh = async () => {
    setRefreshing(true)
    await fetch('/api/refresh', { method: 'POST' })
    setTimeout(loadSignals, 3000)
  }

  const filtered = signals
    .filter(s => tab === 'ALL' || s.direction === tab)
    .sort((a, b) => {
      if (sort === 'confidence') return b.confidence - a.confidence
      if (sort === 'rsi') return a.rsi - b.rsi
      if (sort === 'change24h') return Math.abs(b.change24h) - Math.abs(a.change24h)
      if (sort === 'change7d') return Math.abs(b.change7d) - Math.abs(a.change7d)
      return 0
    })

  const tabs = ['ALL', 'STRONG_BUY', 'BUY', 'SELL', 'STRONG_SELL', 'HOLD']
  const counts: Record<string, number> = { ALL: signals.length }
  signals.forEach(s => { counts[s.direction] = (counts[s.direction] || 0) + 1 })

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="brand">📊 Crypto Signals <span className="badge beta">BETA</span></div>
          <div className="subtitle">Real-time RSI + momentum + volume analysis across top cryptos</div>
        </div>
        <div className="header-right">
          {lastUpdate && <span className="update-time">Updated {new Date(lastUpdate).toLocaleTimeString()}</span>}
          {refreshing && <span className="refreshing">⟳ Refreshing...</span>}
          <button className="btn" onClick={refresh} disabled={refreshing}>↻ Sync</button>
        </div>
      </header>

      <div className="tabs">
        {tabs.map(t => {
          const isActive = tab === t
          const c = t === 'ALL' ? '#58a6ff'
            : t === 'STRONG_BUY' ? '#00c853'
            : t === 'BUY' ? '#69f0ae'
            : t === 'SELL' ? '#ff8a80'
            : t === 'STRONG_SELL' ? '#ff1744'
            : '#9e9e9e'
          return (
            <button
              key={t}
              className={`tab ${isActive ? 'active' : ''}`}
              style={isActive ? { borderColor: c, color: c } : {}}
              onClick={() => setTab(t)}
            >
              {t === 'ALL' ? 'All' : dirLabel(t).replace('▲▲ ', '').replace('▲ ', '').replace('▼▼ ', '').replace('▼ ', '')} {counts[t] ? `(${counts[t]})` : ''}
            </button>
          )
        })}
      </div>

      <div className="toolbar">
        <div className="sort-ctrls">
          <span className="sort-label">Sort:</span>
          {['confidence', 'rsi', 'change24h', 'change7d'].map(s => (
            <button key={s} className={`sort-btn ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
              {s === 'confidence' ? 'Confidence' : s === 'rsi' ? 'RSI' : s === 'change24h' ? '24h Δ' : '7d Δ'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading && signals.length === 0 ? (
        <div className="loading"><div className="spinner" /> Fetching live data from CoinGecko...</div>
      ) : (
        <div className="grid">
          {filtered.map(s => {
            const score = s.bullScore - s.bearScore
            return (
              <div key={s.coinId} className="card" style={{ borderLeftColor: dirColor(s.direction) }}>
                <div className="card-top">
                  <div className="card-coin">
                    <div className="coin-avatar">{s.symbol.slice(0, 2)}</div>
                    <div>
                      <div className="coin-name">{s.name}</div>
                      <div className="coin-sym">{s.symbol}</div>
                    </div>
                  </div>
                  <div className="card-dir" style={{ background: dirColor(s.direction), color: s.direction.includes('STRONG') ? '#fff' : '#000' }}>
                    {dirLabel(s.direction === 'STRONG_BUY' ? 'STRONG_BUY' : s.direction === 'STRONG_SELL' ? 'STRONG_SELL' : s.direction)}
                  </div>
                </div>

                <div className="card-price-row">
                  <span className="price">{fmtPrice(s.price)}</span>
                  <span className={`chg chg-${s.change24h >= 0 ? 'up' : 'dn'}`}>
                    {s.change24h >= 0 ? '+' : ''}{s.change24h}%
                  </span>
                </div>

                <div className="card-conf">
                  <div className="conf-bar-bg">
                    <div className="conf-bar" style={{ width: `${s.confidence}%`, background: confColor(s.confidence) }} />
                  </div>
                  <span className="conf-pct" style={{ color: confColor(s.confidence) }}>{s.confidence}%</span>
                </div>

                <div className="card-metrics">
                  <div><span className="ml">7d</span><span className={`mv ${s.change7d >= 0 ? 'up' : 'dn'}`}>{s.change7d >= 0 ? '+' : ''}{s.change7d}%</span></div>
                  <div><span className="ml">RSI</span><span className="mv" style={{ color: s.rsi < 35 ? '#00c853' : s.rsi > 65 ? '#ff1744' : '#e6edf3' }}>{s.rsi}</span></div>
                  <div><span className="ml">Signal</span><span className="mv">{score > 0 ? `+${score}` : score}</span></div>
                  <div><span className="ml">Vol</span><span className="mv">{s.volumeRatio}x</span></div>
                </div>

                <div className="card-desc">{s.description}</div>

                <div className="card-reasons">
                  {s.reasons.slice(0, 3).map((r, i) => (
                    <div key={i} className="reason">{r}</div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default App
