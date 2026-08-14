/**
 * AI Usage Monitor — Hermes desktop plugin
 * ----------------------------------------
 * Right-side pane showing token usage, cache-hit rate, cost (USD/CNY) and
 * per-API-provider breakdown for Hermes Agent (and Claude Code / Codex
 * when the stats server picks them up).
 *
 * Data comes from the local stats server:
 *   python stats_server.py --port 9543
 * (see README.md in the repo root.)
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

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

const STR = {
  zh: {
    paneTitle: '模型监测',
    totalTokens: '总 Token',
    cacheHit: '缓存命中率',
    cost: '总费用(预估)',
    sessions: '会话数',
    byProvider: '按 API 提供商',
    recent: '最近会话',
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
  },
  en: {
    paneTitle: 'Model Monitor',
    totalTokens: 'Total Tokens',
    cacheHit: 'Cache Hit',
    cost: 'Total Cost (est.)',
    sessions: 'Sessions',
    byProvider: 'By API Provider',
    recent: 'Recent Sessions',
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

async function fetchJson(path) {
  const res = await fetch(STATS_URL + path, { cache: 'no-store' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
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

function ProviderTable({ providers, t, currency, rate }) {
  if (!providers || providers.length === 0) {
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
  const rows = providers.map((p) =>
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
  const [lang, setLang] = useState('en')
  const [days, setDays] = useState(30)
  const [stats, setStats] = useState(null)
  const [live, setLive] = useState(null)
  const [err, setErr] = useState(null)
  const [usdCny, setUsdCny] = useState(7.2)
  const [currency, setCurrency] = useState(null) // null = follow language

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

  const load = useCallback(async () => {
    try {
      const [s, l, cfg] = await Promise.all([
        fetchJson('/api/stats?days=' + days),
        fetchJson('/api/live?limit=6'),
        fetchJson('/api/config')
      ])
      setStats(s)
      setLive(l)
      if (cfg && cfg.usd_cny) setUsdCny(cfg.usd_cny)
      setErr(null)
    } catch (e) {
      setErr(String(e && e.message ? e.message : e))
    }
  }, [days])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const tot = (stats && stats.totals) || null
  const providers = (stats && stats.by_provider) || []

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

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2.5 overflow-y-auto p-3 text-sm',
    children: [
      /* header */
      jsxs('div', {
        className: 'flex items-center justify-between gap-1',
        children: [
          jsx('div', {
            className: 'flex items-baseline gap-1.5',
            children: [
              jsx('span', { className: 'font-medium', children: t.paneTitle }),
              live && live.sessions && live.sessions[0]
                ? jsx('span', {
                    className: 'text-[0.625rem] text-(--ui-text-tertiary)',
                    children: t.active + ': ' + (live.sessions[0].model || t.unknown).split('/').pop()
                  })
                : null
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

      /* server-down banner */
      err
        ? jsxs('div', {
            className:
              'rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2 text-xs text-(--ui-text-secondary)',
            children: [
              jsx('div', { className: 'font-medium', children: t.serverDown }),
              jsx('div', { className: 'mt-1 text-(--ui-text-tertiary)', children: t.serverHint })
            ]
          })
        : null,

      /* summary cards */
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
        : null,

      /* per-provider */
      jsx('div', {
        className: 'text-[0.6875rem] font-medium text-(--ui-text-secondary)',
        children: t.byProvider + ' (' + days + (lang === 'zh' ? '天' : 'd') + ')'
      }),
      jsx(ProviderTable, { providers, t, currency: effCurrency, rate: usdCny }),

      /* recent sessions */
      jsx('div', {
        className: 'mt-1 text-[0.6875rem] font-medium text-(--ui-text-secondary)',
        children: t.recent
      }),
      jsx(LiveSessions, { sessions: live && live.sessions, t, currency: effCurrency, rate: usdCny })
    ]
  })
}

export default {
  id: 'usage-monitor', // must match the folder name
  name: 'Model Monitor',
  register(ctx) {
    ctx.register({
      id: 'usage-monitor-pane',
      area: 'panes',
      title: 'Model Monitor',
      data: { placement: 'right', width: '340px' },
      render: () => jsx(UsagePane, {})
    })
  }
}
