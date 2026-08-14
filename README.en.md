# AI Usage Monitor

**Local, read-only usage & cost monitoring for AI coding agents — with a Hermes desktop plugin.**

Track cache-hit rate, token consumption, spend, and per-API-provider breakdowns
(DeepSeek, SiliconFlow, Anthropic, OpenAI, ...) across your AI agents, entirely
offline. Nothing leaves your machine: the server reads each agent's local
history files and serves JSON to UI plugins.

![MIT](https://img.shields.io/badge/license-MIT-green) ![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue) ![Platform: Windows/macOS/Linux](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey) ![Release](https://img.shields.io/github/v/release/TurkeyGuoba/ai-usage-monitor)

**English** | [简体中文](README.md)

## Features

- **Cache-hit rate** — per provider, per model, per day (cache_read / (input + cache_read))
- **Token consumption** — totals, daily breakdown, per model, per provider
- **Cost** — recomputed from a **local, editable price table** (`prices.json`),
  not the agent's built-in estimate, so it matches the vendor console
  (e.g. SiliconFlow pricing verified against their website)
- **Multi-currency** — USD or CNY (¥). Auto-follows the Hermes UI language
  (Chinese → CNY) with a manual ¥/$ toggle in the pane
- **Per-API-provider breakdown** — cost, tokens, cache-hit and call counts
  grouped by billing provider (`deepseek`, `siliconflow`, `anthropic`, `openai`, ...)
- **Recent sessions** — title + relative time so you can tell which conversation
  burned the tokens at a glance
- **Multi-agent** — Hermes Agent out of the box; Claude Code and Codex CLI
  adapters included (JSONL parsers)
- **Zero dependencies** — pure Python stdlib (`sqlite3` + `http.server`)
- **Read-only & local** — binds `127.0.0.1` only, opens the state DB in
  read-only mode, never writes anything

## Architecture

```
┌─────────────────────┐        HTTP/JSON (CORS *)        ┌──────────────────────┐
│  stats_server.py    │ ◄──────────────────────────────► │  Hermes desktop       │
│  (127.0.0.1:9543)   │          /api/stats              │  plugin (right pane)  │
│                     │          /api/live               │  ─ or any UI you like │
│  ┌───────────────┐  │          /api/config             └──────────────────────┘
│  │ HermesAdapter │──┤  reads  ~/.hermes/state.db (SQLite)
│  │ ClaudeAdapter │──┤  reads  ~/.claude/projects/**/*.jsonl
│  │ CodexAdapter  │──┤  reads  ~/.codex/sessions/**/*.jsonl
│  └───────────────┘  │
└─────────────────────┘
        prices.json (USD per 1M tokens, editable)
        config.json  (usd_cny rate, currency_auto)
```

The desktop plugin runs from `file://` inside Electron (origin `null`), so the
server sends `Access-Control-Allow-Origin: *` for every response. Since it only
binds to 127.0.0.1 and serves read-only aggregate data, this is safe for a
local-only tool. If you expose it beyond loopback, put an auth proxy in front.

## Quick start

### 1. Start the server

```bash
python stats_server.py --port 9543
# → AI Usage Monitor listening on http://127.0.0.1:9543
```

Requirements: Python 3.8+ (no third-party packages).

On Windows you can also double-click `start-server.bat`.

### 2. Install the Hermes desktop plugin

```bash
# <hermes home> is ~/.hermes (Linux/macOS) or %LOCALAPPDATA%\hermes (Windows)
mkdir -p "$HERMES_HOME/desktop-plugins/usage-monitor"
cp plugin/usage-monitor/plugin.js "$HERMES_HOME/desktop-plugins/usage-monitor/"
```

Then in the Hermes desktop app: **⌘K → Reload desktop plugins**.
A new right-side pane **"Model Monitor"** appears, refreshing every 15 s.

> The plugin fetches `http://127.0.0.1:9543`; if the server is down the pane
> shows a hint instead of failing silently.

### 3. Check the API

```bash
curl http://127.0.0.1:9543/health
curl "http://127.0.0.1:9543/api/stats?days=30"
curl "http://127.0.0.1:9543/api/live?limit=8"
curl http://127.0.0.1:9543/api/config
```

## Pricing & currency

Costs are **recomputed locally** from `prices.json` — unit prices in **USD per
1M tokens**, keyed by provider, with model-prefix matching (longest prefix
wins). Example (matches the SiliconFlow console as of 2026-08):

```json
"siliconflow": {
  "deepseek-ai/DeepSeek-V4-Flash-0731": { "input": 0.14, "output": 0.28, "cache_read": 0.028 }
}
```

- Edit `prices.json` freely; restart the server to reload.
- Unknown (provider, model) pairs fall back to the agent's own cost estimate
  (Hermes `estimated_cost_usd`) and are marked by the absence of a price entry.
- Currency: `config.json` → `usd_cny` (default 7.2) is the USD→CNY rate.
  `currency_auto: true` makes the plugin follow the Hermes UI language
  (Chinese → ¥). The ¥/$ toggle in the pane overrides it for the session.

## Supported agents

| Agent | Data source | Status |
|-------|-------------|--------|
| Hermes Agent | `~/.hermes/state.db` (sessions + session_model_usage) | ✅ production-tested |
| Claude Code | `~/.claude/projects/**/*.jsonl` (assistant `usage` fields) | ✅ parser included |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` (recursive `usage` scan) | ✅ parser included |

Claude Code / Codex rows are aggregated into the same totals, provider
breakdown (`anthropic` / `openai`) and recent-session list. Note the server
auto-detects the Hermes home: `$HERMES_HOME`, else `~/.hermes`, else
`%LOCALAPPDATA%\hermes` on Windows. Override with `--home`.

### Testing the adapters

```bash
python tests/mock_adapters.py   # builds fake JSONL histories and asserts parsing
```

## API reference

### `GET /api/stats?days=30` (1–365)

```json
{
  "ok": true, "days": 30, "generated_at": 1786700000,
  "totals": {
    "input_tokens": 9727630, "output_tokens": 3226386,
    "cache_read_tokens": 516047616, "cache_hit_pct": 98.1,
    "estimated_cost": 9.9024, "sessions": 26, "api_calls": 2860
  },
  "daily": [{ "day": "2026-08-14", "input_tokens": 1140085, "...": "" }],
  "by_model": [{ "model": "deepseek-v4-flash|deepseek", "estimated_cost": 8.29, "...": "" }],
  "by_provider": [{ "provider": "siliconflow", "cache_hit_pct": 85.0, "estimated_cost": 1.60, "...": "" }],
  "by_agent": [{ "agent": "hermes", "...": "" }]
}
```

### `GET /api/live?limit=8`

Recent sessions with `title`, `reltime` ("now", "5m", "3h", "2d", "08-01"),
`model`, `provider`, token counts, `cache_hit_pct`, `estimated_cost`.

### `GET /api/config`

`{ prices, usd_cny, currency_auto }` — lets the UI render the price table and
convert currency without hardcoding.

## Contributing

New agent adapters are ~40 lines: collect a list of rows
`{model, provider, input_tokens, output_tokens, cache_read_tokens, api_calls, started_at, title}`,
then register it in `collect_stats()`. PRs welcome.

## License

MIT — do whatever you want, attribution appreciated.
