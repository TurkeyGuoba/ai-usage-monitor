/**
 * AI Usage Monitor — Hermes desktop plugin
 * ----------------------------------------
 * Top: live stats for the CURRENT session (tokens, cache hit, cost,
 *      context exhaustion).
 * Middle: per-API-provider breakdown + recent sessions.
 * Bottom: overall totals (unchanged content).
 *
 * Data comes from the local stats server:
 *   python stats_server.py --port 9543
 * Current-session live usage comes from the gateway `session.usage` RPC.
 *
 * Install: <hermes home>/desktop-plugins/usage-monitor/plugin.js
 * Then: ⌘K → Reload desktop plugins
 *
 * Open source (MIT). https://github.com/TurkeyGuoba/ai-usage-monitor
 */

import { cn, host, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs, Fragment } from 'react/jsx-runtime'
import { useEffect, useState, useCallback } from 'react'

const STATS_URL = 'http://127.0.0.1:9543'
const POLL_MS = 15000
const FETCH_TIMEOUT_MS = 8000

let pluginCtx = null // set in register(); used for ctx.storage

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

const STR = {
  zh: {
    paneTitle: '模型监测',
    currentTitle: '当前会话',
    totalTokens: '总 Token',
    cacheHit: '缓存命中率',
    cost: '总费用(预估)',
    sessions: '会话数',
    byProvider: '按 API 提供商',
    recent: '最近会话',
    totalsTitle: '总统计',
    serverDown: '监测服务未运行',
    serverHint: '启动: python stats_server.py (端口 9543)',
    noData: '暂无数据',
    noTitle: '(无标题)',
    active: '活跃',
    unknown: '未知',
    input: '输入',
    output: '输出',
    cache: '缓存',
    costCol: '费用',
    calls: '调用',
    subInput: '输入',
    subOutput: '输出',
    cacheRead: '缓存读',
    apiCalls: 'API 调用',
    inDays: '天内',
    provider: '提供商',
    model: '模型',
    est: '预估',
    sessionTokens: '本会话 Token',
    sessionCost: '本会话费用',
    contextUsed: '上下文占用',
    notStarted: '未开始',
    ctxTitle: '上下文耗尽',
    on: '监测中',
    off: '已关闭',
    starting: '启动中…',
    turnedOff: '监测已关闭(点击开关重新开启)',
  },
  en: {
    paneTitle: 'Model Monitor',
    currentTitle: 'Current Session',
    totalTokens: 'Total Tokens',
    cacheHit: 'Cache Hit',
    cost: 'Total Cost (est.)',
    sessions: 'Sessions',
    byProvider: 'By API Provider',
    recent: 'Recent Sessions',
    totalsTitle: 'Totals',
    serverDown: 'Monitor server not running',
    serverHint: 'Start: python stats_server.py (port 9543)',
    noData: 'No data',
    noTitle: '(untitled)',
    active: 'active',
    unknown: 'unknown',
    input: 'input',
    output: 'output',
    cache: 'cache',
    costCol: 'cost',
    calls: 'calls',
    subInput: 'input',
    subOutput: 'output',
    cacheRead: 'cache read',
    apiCalls: 'API calls',
    inDays: 'days',
    provider: 'provider',
    model: 'model',
    est: 'est.',
    sessionTokens: 'Session Tokens',
    sessionCost: 'Session Cost',
    contextUsed: 'Context Used',
    notStarted: 'not started',
    ctxTitle: 'Context Exhaustion',
    on: 'on',
    off: 'off',
    starting: 'starting…',
    turnedOff: 'Monitoring off (click the switch to re-enable)',
  },
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtTokens(n) {
  if (n == null) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

function fmtMoney(usd, currency, rate) {
  if (usd == null || usd === 0) return currency === 'CNY' ? '¥0' : '$0'
  const v = currency === 'CNY' ? usd * (rate || 7.2) : usd
  const sym = currency === 'CNY' ? '¥' : '$'
  if (v < 0.01) return sym + v.toFixed(4)
  return sym + v.toFixed(3)
}

function fmtPct(n) {
  return (n == null ? 0 : n).toFixed(1) + '%'
}

async function fetchJson(path, opts) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(
      STATS_URL + path,
      Object.assign({ cache: 'no-store' }, opts, { signal: ctrl.signal })
    )
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, sub, tone }) {
  return jsxs('div', {
    className:
      'flex flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2',
    children: [
      jsx('div', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: label
      }),
      jsx('div', {
        className: cn(
          'text-sm font-semibold leading-tight',
          tone === 'accent' ? 'text-(--ui-accent)' : 'text-foreground'
        ),
        children: value
      }),
      sub
        ? jsx('div', { className: 'text-[0.625rem] text-(--ui-text-quaternary)', children: sub })
        : null
    ]
  })
}

/** Context-exhaustion card with a progress bar. */
function ContextCard({ t, used, max, pct }) {
  const has = used != null && max != null && max > 0
  const p = has ? Math.max(0, Math.min(100, pct != null ? pct : (used / max) * 100)) : 0
  const hot = p >= 85
  return jsxs('div', {
    className:
      'flex flex-col gap-1.5 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between',
        children: [
          jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t.contextUsed }),
          jsx('div', {
            className: cn(
              'text-sm font-semibold leading-tight',
              hot ? 'text-(--ui-accent)' : 'text-foreground'
            ),
            children: has ? fmtPct(p) : t.notStarted
          })
        ]
      }),
      jsx('div', {
        className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-stroke-secondary)',
        children: jsx('div', {
          className: cn('h-full rounded-full transition-all', hot ? 'bg-(--ui-accent)' : 'bg-(--ui-accent)/70'),
          style: { width: has ? p + '%' : '0%' }
        })
      }),
      jsx('div', {
        className: 'text-[0.625rem] text-(--ui-text-quaternary)',
        children: has
          ? fmtTokens(used) + ' / ' + fmtTokens(max)
          : (t.ctxTitle + ' —')
      })
    ]
  })
}

/** Top block: the CURRENT session's live usage. */
function CurrentSession({ current, liveRow, t, currency, rate }) {
  const u = current || {}
  const model = (u.model || (liveRow && liveRow.model) || t.unknown).split('/').pop()
  const input = u.input != null ? u.input : (liveRow && liveRow.input_tokens)
  const output = u.output != null ? u.output : (liveRow && liveRow.output_tokens)
  const cachePct = liveRow && liveRow.cache_hit_pct != null ? liveRow.cache_hit_pct : null
  const cost = liveRow && liveRow.estimated_cost != null ? liveRow.estimated_cost : null
  const calls = u.calls != null ? u.calls : (liveRow && liveRow.api_calls)

  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx('span', { className: 'font-medium', children: model }),
          jsx('span', {
            className: 'rounded bg-(--ui-accent)/15 px-1 py-px text-[0.625rem] text-(--ui-accent)',
            children: t.active
          }),
          jsx('span', {
            className: 'ml-auto text-[0.625rem] text-(--ui-text-tertiary)',
            children: calls != null ? calls + ' ' + t.calls : ''
          })
        ]
      }),
      jsxs('div', {
        className: 'grid grid-cols-2 gap-1.5',
        children: [
          jsx(StatCard, {
            label: t.sessionTokens,
            value: fmtTokens((input || 0) + (output || 0)),
            sub: t.subInput + ' ' + fmtTokens(input || 0) + ' / ' + t.subOutput + ' ' + fmtTokens(output || 0)
          }),
          jsx(StatCard, {
            label: t.cacheHit,
            value: cachePct != null ? fmtPct(cachePct) : '—',
            sub: t.cacheRead + (liveRow ? ' ' + fmtTokens(liveRow.cache_read_tokens) : ''),
            tone: 'accent'
          }),
          jsx(StatCard, {
            label: t.sessionCost,
            value: cost != null ? fmtMoney(cost, currency, rate) : '—',
            sub: t.est
          }),
          jsx(ContextCard, {
            t,
            used: u.context_used,
            max: u.context_max,
            pct: u.context_percent
          })
        ]
      })
    ]
  })
}

function ProviderTable({ providers, t, currency, rate }) {
  // Defensive: hide placeholder provider names the server may still emit
  // (older stats_server versions surface NULL billing_provider as "unknown").
  const visible = (providers || []).filter((p) => p && !['unknown', 'auto'].includes(p.provider))
  if (!visible || visible.length === 0) {
    return jsx('div', {
      className: 'py-3 text-center text-xs text-(--ui-text-tertiary)',
      children: t.noData
    })
  }
  const head = jsxs('div', {
    className:
      'flex items-center gap-2 border-b border-(--ui-stroke-secondary) pb-1 text-[0.625rem] text-(--ui-text-quaternary)',
    children: [
      jsx('div', { className: 'w-16 shrink-0', children: t.provider }),
      jsx('div', { className: 'w-11 shrink-0 text-right', children: t.input }),
      jsx('div', { className: 'w-11 shrink-0 text-right', children: t.output }),
      jsx('div', { className: 'w-12 shrink-0 text-right', children: t.cache }),
      jsx('div', { className: 'w-14 shrink-0 text-right', children: t.costCol }),
      jsx('div', { className: 'flex-1 text-right', children: t.calls })
    ]
  })
  const rows = visible.map((p) =>
    jsxs(
      'div',
      {
        className: cn(
          'flex items-center gap-2 border-b border-(--ui-stroke-secondary)/60 py-1.5 text-xs',
          'last:border-b-0'
        ),
        children: [
          jsx('div', {
            className: 'w-16 shrink-0 truncate font-medium',
            title: p.provider,
            children: p.provider
          }),
          jsx('div', { className: 'w-11 shrink-0 text-right tabular-nums', children: fmtTokens(p.input_tokens) }),
          jsx('div', { className: 'w-11 shrink-0 text-right tabular-nums', children: fmtTokens(p.output_tokens) }),
          jsx('div', { className: 'w-12 shrink-0 text-right tabular-nums', children: fmtPct(p.cache_hit_pct) }),
          jsx('div', {
            className: 'w-14 shrink-0 text-right tabular-nums',
            children: fmtMoney(p.estimated_cost, currency, rate)
          }),
          jsx('div', { className: 'flex-1 text-right tabular-nums text-(--ui-text-tertiary)', children: p.api_calls })
        ]
      },
      p.provider
    )
  )
  return jsxs('div', { children: [head, ...rows] })
}

function LiveSessions({ sessions, t, currency, rate }) {
  if (!sessions || sessions.length === 0) {
    return jsx('div', {
      className: 'py-3 text-center text-xs text-(--ui-text-tertiary)',
      children: t.noData
    })
  }
  const items = sessions.map((s) => {
    const title = (s.title || '').trim() ? s.title : t.noTitle
    const model = (s.model || t.unknown).split('/').pop()
    return jsxs(
      'div',
      {
        className:
          'flex flex-col gap-0.5 border-b border-(--ui-stroke-secondary)/60 py-1.5 last:border-b-0',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5 text-xs',
            children: [
              jsx('span', {
                className: 'shrink-0 rounded bg-(--ui-stroke-secondary)/70 px-1 text-[0.625rem] text-(--ui-text-tertiary)',
                children: s.reltime || ''
              }),
              jsx('span', {
                className: 'flex-1 truncate font-medium',
                title: s.title || '',
                children: title
              })
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-2 pl-7 text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [
              jsx('span', { className: 'truncate', children: model + (s.provider && s.provider !== 'unknown' ? ' · ' + s.provider : '') }),
              jsx('span', { className: 'ml-auto shrink-0 tabular-nums', children: fmtTokens(s.input_tokens) }),
              jsx('span', { className: 'shrink-0 tabular-nums', children: fmtPct(s.cache_hit_pct) }),
              jsx('span', { className: 'shrink-0 tabular-nums', children: fmtMoney(s.estimated_cost, currency, rate) })
            ]
          })
        ]
      },
      s.id
    )
  })
  return jsxs('div', { children: items })
}

/* ------------------------------------------------------------------ */
/* Main pane                                                           */
/* ------------------------------------------------------------------ */

function UsagePane() {
  const activeSessionId = useValue(host.state.activeSessionId)
  const [lang, setLang] = useState('en')
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState(null)
  const [live, setLive] = useState(null)
  const [current, setCurrent] = useState(null)
  const [err, setErr] = useState(null)
  const [usdCny, setUsdCny] = useState(7.2)
  const [currency, setCurrency] = useState(null) // null = follow language
  const [want, setWant] = useState(() => {
    try {
      return pluginCtx ? pluginCtx.storage.get('monitorEnabled') !== false : true
    } catch (e) {
      return true
    }
  })
  const [serverEnabled, setServerEnabled] = useState(null) // authoritative from /api/config

  /* Detect Hermes language once */
  useEffect(() => {
    let alive = true
    host
      .request('config.get', { key: 'full' })
      .then((r) => {
        if (!alive) return
        const lang =
          (r && r.config && r.config.display && r.config.display.language) ||
          (typeof navigator !== 'undefined' ? navigator.language : '') ||
          ''
        setLang(lang && lang.toLowerCase().startsWith('zh') ? 'zh' : 'en')
      })
      .catch(() => {
        if (alive && typeof navigator !== 'undefined' && navigator.language) {
          setLang(navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const t = STR[lang] || STR.en
  const effCurrency = currency || (lang === 'zh' ? 'CNY' : 'USD')
  const running = !err

  const toggleMonitor = async () => {
    const next = !want
    setWant(next)
    try {
      if (pluginCtx) pluginCtx.storage.set('monitorEnabled', next)
    } catch (e) {}
    try {
      await fetchJson('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next })
      })
    } catch (e) {
      // server down: watchdog will bring it back (or keep it down) — fine
    }
    if (next) {
      // Ask for data immediately; watchdog (≤1 min) fills the gap if down.
      load()
    }
  }

  const load = useCallback(async () => {
    // /api/config is always served (even when monitoring is disabled) and is
    // the authoritative on/off source — fetch it separately so the toggle
    // can sync even while stats/live return 503.
    try {
      const cfg = await fetchJson('/api/config')
      if (cfg && cfg.usd_cny) setUsdCny(cfg.usd_cny)
      if (cfg && typeof cfg.monitor_enabled === 'boolean') {
        setServerEnabled(cfg.monitor_enabled)
        setWant(cfg.monitor_enabled)
        try {
          if (pluginCtx) pluginCtx.storage.set('monitorEnabled', cfg.monitor_enabled)
        } catch (e) {}
      }
    } catch (e) {
      /* server fully unreachable — the err banner will show */
    }
    try {
      const [s, l] = await Promise.all([
        fetchJson('/api/stats?days=' + days),
        fetchJson('/api/live?limit=6')
      ])
      setStats(s)
      setLive(l)
      setErr(null)
    } catch (e) {
      setStats(null)
      setLive(null)
      setErr(String(e && e.message ? e.message : e))
    }
  }, [days])

  /* Live current-session usage via gateway RPC */
  const loadCurrent = useCallback(async () => {
    if (!activeSessionId) return
    try {
      const r = await host.request('session.usage', { session_id: activeSessionId })
      const u = r && r.result ? r.result : r
      if (u && typeof u === 'object' && !u.error) setCurrent(u)
    } catch (e) {
      /* gateway may not expose session.usage on older backends — ignore */
    }
  }, [activeSessionId])

  useEffect(() => {
    load()
    loadCurrent()
    const timer = setInterval(() => {
      load()
      loadCurrent()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [load, loadCurrent])

  const tot = (stats && stats.totals) || null
  const providers = (stats && stats.by_provider) || []
  const liveSessions = (live && live.sessions) || []
  const currentRow =
    liveSessions.find((s) => s.id === activeSessionId) || liveSessions[0] || null

  const segBtn = (n) =>
    jsx(
      'button',
      {
        type: 'button',
        onClick: () => setDays(n),
        className: cn(
          'rounded px-2 py-0.5 text-[0.6875rem] transition-colors',
          days === n
            ? 'bg-(--ui-accent) text-foreground'
            : 'text-(--ui-text-tertiary) hover:text-foreground'
        ),
        children: lang === 'zh' ? n + '天' : n + 'd'
      },
      'seg' + n
    )

  const curBtn = (c) =>
    jsx(
      'button',
      {
        type: 'button',
        onClick: () => setCurrency(c === effCurrency ? null : c),
        title: c === 'CNY' ? (lang === 'zh' ? '人民币' : 'CNY') : 'USD',
        className: cn(
          'rounded px-1.5 py-0.5 text-[0.6875rem] tabular-nums transition-colors',
          effCurrency === c
            ? 'bg-(--ui-accent) text-foreground'
            : 'text-(--ui-text-tertiary) hover:text-foreground'
        ),
        children: c === 'CNY' ? '¥' : '$'
      },
      'cur' + c
    )

  const sectionTitle = (text) =>
    jsx('div', {
      className: 'text-[0.6875rem] font-medium text-(--ui-text-secondary)',
      children: text
    })

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2.5 overflow-y-auto p-3 text-sm',
    children: [
      /* header */
      jsxs('div', {
        className: 'flex items-center justify-between gap-1',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx('div', { className: 'font-medium', children: t.paneTitle }),
              jsx(
                'button',
                {
                  type: 'button',
                  onClick: toggleMonitor,
                  title: want ? t.on : t.off,
                  className: cn(
                    'flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.625rem] transition-colors',
                    !want
                      ? 'border-(--ui-stroke-secondary) text-(--ui-text-tertiary)'
                      : running
                        ? 'border-(--ui-accent)/50 text-(--ui-accent)'
                        : 'border-(--ui-stroke-secondary) text-(--ui-text-secondary)'
                  ),
                  children: [
                    jsx('span', {
                      className: cn(
                        'h-1.5 w-1.5 rounded-full',
                        !want
                          ? 'bg-(--ui-text-quaternary)'
                          : running
                            ? 'bg-(--ui-accent)'
                            : 'bg-(--ui-text-tertiary)'
                      )
                    }),
                    jsx('span', {
                      children: !want ? t.off : running ? t.on : t.starting
                    })
                  ]
                },
                'monitor-switch'
              )
            ]
          }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              jsxs('div', {
                className: 'flex gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5',
                children: [curBtn('CNY'), curBtn('USD')]
              }),
              jsxs('div', {
                className: 'flex gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5',
                children: [segBtn(7), segBtn(30), segBtn(90)]
              })
            ]
          })
        ]
      }),

      /* server-down banner (hidden when the user turned monitoring off) */
      err && want
        ? jsxs('div', {
            className:
              'rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2 text-xs text-(--ui-text-secondary)',
            children: [
              jsx('div', { className: 'font-medium', children: t.serverDown }),
              jsx('div', { className: 'mt-1 text-(--ui-text-tertiary)', children: t.serverHint }),
              jsx('div', {
                className: 'mt-0.5 font-mono text-[0.625rem] break-all text-(--ui-text-quaternary)',
                children: String(err).slice(0, 160)
              })
            ]
          })
        : !want
          ? jsx('div', {
              className:
                'rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2 text-xs text-(--ui-text-tertiary)',
              children: t.turnedOff
            })
          : null,

      /* ── CURRENT SESSION (first thing you see) ── */
      sectionTitle(t.currentTitle),
      jsx(CurrentSession, {
        current,
        liveRow: currentRow,
        t,
        currency: effCurrency,
        rate: usdCny
      }),

      /* ── per-provider ── */
      sectionTitle(t.byProvider + ' (' + days + (lang === 'zh' ? '天' : 'd') + ')'),
      jsx(ProviderTable, { providers, t, currency: effCurrency, rate: usdCny }),

      /* ── recent sessions ── */
      sectionTitle(t.recent),
      jsx(LiveSessions, { sessions: liveSessions, t, currency: effCurrency, rate: usdCny }),

      /* ── TOTALS at the bottom (content unchanged) ── */
      sectionTitle(t.totalsTitle),
      tot
        ? jsxs('div', {
            className: 'grid grid-cols-2 gap-1.5',
            children: [
              jsx(StatCard, {
                label: t.totalTokens,
                value: fmtTokens(tot.input_tokens + tot.output_tokens),
                sub: t.subInput + ' ' + fmtTokens(tot.input_tokens) + ' / ' + t.subOutput + ' ' + fmtTokens(tot.output_tokens)
              }),
              jsx(StatCard, {
                label: t.cacheHit,
                value: fmtPct(tot.cache_hit_pct),
                sub: t.cacheRead + ' ' + fmtTokens(tot.cache_read_tokens),
                tone: 'accent'
              }),
              jsx(StatCard, {
                label: t.cost,
                value: fmtMoney(tot.estimated_cost, effCurrency, usdCny),
                sub: (tot.api_calls || 0) + ' ' + t.apiCalls.toLowerCase()
              }),
              jsx(StatCard, {
                label: t.sessions,
                value: String(tot.sessions || 0),
                sub: days + ' ' + t.inDays
              })
            ]
          })
        : null
    ]
  })
}

export default {
  id: 'usage-monitor', // must match the folder name
  name: 'Model Monitor',
  register(ctx) {
    pluginCtx = ctx
    ctx.register({
      id: 'usage-monitor-pane',
      area: 'panes',
      title: 'Model Monitor',
      data: { placement: 'right', width: '340px' },
      render: () => jsx(UsagePane, {})
    })
  }
}
