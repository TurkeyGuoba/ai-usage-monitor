#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Usage Monitor — stats server
================================
Local, read-only usage/cost monitor for AI coding agents.
Reads usage data from each installed agent and serves aggregated JSON
to UI plugins (Hermes desktop plugin included).

Supported agents:
  - Hermes Agent        ~/.hermes/state.db            (SQLite, rich fields)
  - Claude Code         ~/.claude/projects/**/*.jsonl (usage in assistant msgs)
  - Codex CLI           ~/.codex/sessions/*.jsonl     (response usage)

Endpoints:
  GET /health
  GET /api/config                 price table + currency config
  GET /api/stats?days=30          totals + daily + by_model + by_provider
  GET /api/live?limit=8           recent sessions (title, model, usage, cost)

Pure stdlib (sqlite3 + http.server + json). Binds 127.0.0.1 only.
CORS is wide open (Access-Control-Allow-Origin: *) because desktop plugins
run from file:// (origin null) inside Electron with webSecurity on.

Usage:  python stats_server.py [--port 9543] [--home <hermes-home>]
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Paths & config
# --------------------------------------------------------------------------

DEFAULT_HERMES_HOME = os.environ.get(
    "HERMES_HOME", os.path.join(os.path.expanduser("~"), ".hermes")
)
if sys.platform == "win32" and not os.environ.get("HERMES_HOME"):
    # Windows desktop install keeps HERMES_HOME under LOCALAPPDATA
    local = os.environ.get("LOCALAPPDATA", "")
    if local and os.path.isdir(os.path.join(local, "hermes")):
        DEFAULT_HERMES_HOME = os.path.join(local, "hermes")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PRICES_PATH = os.path.join(BASE_DIR, "prices.json")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULT_PRICES = {
    "_comment": "Prices in USD per 1M tokens. Key = provider, value = {model_prefix: {input, output, cache_read}}. Longest matching model prefix wins.",
    "siliconflow": {
        "deepseek-ai/DeepSeek-V4-Flash-0731": {"input": 0.14, "output": 0.28, "cache_read": 0.028},
        "deepseek-ai/DeepSeek-V3": {"input": 0.27, "output": 1.10, "cache_read": 0.07},
    },
    "deepseek": {
        "deepseek-v4-flash": {"input": 0.14, "output": 0.28, "cache_read": 0.014},
        "deepseek-chat": {"input": 0.14, "output": 0.28, "cache_read": 0.014},
        "deepseek-reasoner": {"input": 0.28, "output": 0.56, "cache_read": 0.028},
    },
    "anthropic": {
        "claude-sonnet-4.6": {"input": 3.0, "output": 15.0, "cache_read": 0.30},
        "claude-sonnet-4.5": {"input": 3.0, "output": 15.0, "cache_read": 0.30},
        "claude-opus-4.6": {"input": 5.0, "output": 25.0, "cache_read": 0.50},
        "claude-haiku-3.5": {"input": 0.80, "output": 4.0, "cache_read": 0.08},
    },
    "openai": {
        "gpt-5": {"input": 1.25, "output": 10.0, "cache_read": 0.125},
        "gpt-4o": {"input": 2.50, "output": 10.0, "cache_read": 0.125},
    },
}

DEFAULT_CONFIG = {
    "_comment": "Local config. usd_cny is the USD->CNY rate used when currency=CNY; edit freely. monitor_enabled is the plugin on/off switch (watchdog honours it).",
    "usd_cny": 7.2,
    "currency_auto": True,
    "monitor_enabled": True,
}

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "600",
}


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path, obj):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


PRICES = load_json(PRICES_PATH, DEFAULT_PRICES)
CONFIG = load_json(CONFIG_PATH, DEFAULT_CONFIG)
CONFIG_LOCK = __import__("threading").Lock()


def set_monitor_enabled(enabled):
    with CONFIG_LOCK:
        CONFIG["monitor_enabled"] = bool(enabled)
        save_json(CONFIG_PATH, CONFIG)


def price_for(provider, model):
    """Return (input_per_m, output_per_m, cache_per_m) or None. Longest prefix wins."""
    table = PRICES.get(provider or "")
    if not table:
        return None
    model = model or ""
    best = None
    for prefix, p in table.items():
        if prefix and model.startswith(prefix):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, p)
    if best is None:
        return None
    p = best[1]
    return (p.get("input", 0), p.get("output", 0), p.get("cache_read", 0))


def compute_cost_usd(provider, model, input_tokens, output_tokens, cache_read_tokens):
    """Recompute cost from the price table (USD). Returns (cost, used_price)."""
    prices = price_for(provider, model)
    if prices is None:
        return None, None
    i, o, c = prices
    cost = (input_tokens or 0) / 1e6 * i + (output_tokens or 0) / 1e6 * o + (cache_read_tokens or 0) / 1e6 * c
    return round(cost, 6), {"input": i, "output": o, "cache_read": c}


def cache_hit_pct(cache_read, input_tokens):
    denom = (cache_read or 0) + (input_tokens or 0)
    if denom <= 0:
        return 0.0
    return round(100.0 * (cache_read or 0) / denom, 1)


def reltime(ts):
    """Compact relative time for UI: '3m' '2h' '1d' '2026-08-01'."""
    if not ts:
        return ""
    now = time.time()
    dt = now - ts
    if dt < 60:
        return "now"
    if dt < 3600:
        return f"{int(dt//60)}m"
    if dt < 86400:
        return f"{int(dt//3600)}h"
    if dt < 7 * 86400:
        return f"{int(dt//86400)}d"
    return time.strftime("%m-%d", time.localtime(ts))


# --------------------------------------------------------------------------
# Adapter: Hermes Agent (SQLite)
# --------------------------------------------------------------------------

def _hermes_db_path(home):
    return os.path.join(home, "state.db")


def hermes_collect(home, days, cutoff):
    db_path = _hermes_db_path(home)
    if not os.path.isfile(db_path):
        return []
    uri = "file:{}?mode=ro".format(urllib.parse.quote(db_path.replace("\\", "/")))
    conn = sqlite3.connect(uri, uri=True, timeout=20)
    conn.row_factory = sqlite3.Row
    rows = []
    try:
        # sessions main table
        for r in conn.execute(
            """
            SELECT model, COALESCE(NULLIF(billing_provider,''),'unknown') AS provider,
                   input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
                   COALESCE(api_call_count,0) AS api_calls,
                   COALESCE(estimated_cost_usd,0) AS est_cost,
                   started_at, title, id
            FROM sessions
            WHERE started_at > ?
            """,
            (cutoff,),
        ):
            rows.append(dict(r))
        # aux calls from session_model_usage — ONLY task rows (task != '').
        # The task='' row duplicates the main-loop counters already in
        # `sessions`; summing it would double-count (verified 2026-08-14:
        # siliconflow main-loop numbers appeared identically in both tables).
        for r in conn.execute(
            """
            SELECT model, COALESCE(NULLIF(billing_provider,''),'unknown') AS provider,
                   input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
                   COALESCE(api_call_count,0) AS api_calls,
                   COALESCE(estimated_cost_usd,0) AS est_cost,
                   last_seen AS started_at, '' AS title, '' AS id
            FROM session_model_usage
            WHERE last_seen > ? AND task != ''
            """,
            (cutoff,),
        ):
            d = dict(r)
            d["aux"] = True
            rows.append(d)
    finally:
        conn.close()
    return rows


# --------------------------------------------------------------------------
# Adapter: Claude Code (JSONL)
# --------------------------------------------------------------------------

def _iter_jsonl(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def claude_collect(home, days, cutoff):
    base = os.path.join(home, ".claude", "projects")
    rows = []
    for path in glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True):
        session_ts = os.path.getmtime(path)
        if session_ts < cutoff:
            continue
        usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
        for obj in _iter_jsonl(path):
            if not isinstance(obj, dict):
                continue
            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue
            u = msg.get("usage")
            if not isinstance(u, dict):
                continue
            usage["input"] += u.get("input_tokens", 0) or 0
            usage["output"] += u.get("output_tokens", 0) or 0
            usage["cache_read"] += u.get("cache_read_input_tokens", 0) or 0
            usage["cache_write"] += u.get("cache_creation_input_tokens", 0) or 0
        if usage["input"] or usage["output"] or usage["cache_read"]:
            rows.append(
                {
                    "model": "claude (from CLI)",
                    "provider": "anthropic",
                    "input_tokens": usage["input"],
                    "output_tokens": usage["output"],
                    "cache_read_tokens": usage["cache_read"],
                    "reasoning_tokens": 0,
                    "api_calls": max(1, (usage["input"] + usage["output"]) // 2000),
                    "est_cost": 0.0,
                    "started_at": session_ts,
                    "title": os.path.basename(os.path.dirname(path)),
                    "id": path,
                    "aux": False,
                }
            )
    return rows


# --------------------------------------------------------------------------
# Adapter: Codex CLI (JSONL)
# --------------------------------------------------------------------------

def _find_usage(obj, acc):
    """Recursively find usage dicts (input/output/cache fields) in a JSON object."""
    if isinstance(obj, dict):
        keys = set(obj.keys())
        if keys & {"input_tokens", "prompt_tokens", "input"} and keys & {"output_tokens", "completion_tokens", "output"}:
            acc.append(obj)
        for v in obj.values():
            _find_usage(v, acc)
    elif isinstance(obj, list):
        for v in obj:
            _find_usage(v, acc)


def codex_collect(home, days, cutoff):
    base = os.path.join(home, ".codex", "sessions")
    rows = []
    for path in glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True):
        session_ts = os.path.getmtime(path)
        if session_ts < cutoff:
            continue
        usage = {"input": 0, "output": 0, "cache_read": 0}
        found = False
        for obj in _iter_jsonl(path):
            acc = []
            _find_usage(obj, acc)
            for u in acc:
                found = True
                usage["input"] += u.get("input_tokens", 0) or u.get("prompt_tokens", 0) or 0
                usage["output"] += u.get("output_tokens", 0) or u.get("completion_tokens", 0) or 0
                usage["cache_read"] += u.get("cache_read_input_tokens", 0) or u.get("cached_tokens", 0) or 0
        if found:
            rows.append(
                {
                    "model": "codex (from CLI)",
                    "provider": "openai",
                    "input_tokens": usage["input"],
                    "output_tokens": usage["output"],
                    "cache_read_tokens": usage["cache_read"],
                    "reasoning_tokens": 0,
                    "api_calls": max(1, (usage["input"] + usage["output"]) // 2000),
                    "est_cost": 0.0,
                    "started_at": session_ts,
                    "title": os.path.basename(os.path.dirname(path)),
                    "id": path,
                    "aux": False,
                }
            )
    return rows


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def _agent_for_row(row, agent_names):
    return row.get("agent", "hermes")


def collect_stats(days, hermes_home):
    cutoff = time.time() - days * 86400
    rows = []
    rows += hermes_collect(hermes_home, days, cutoff)
    rows += claude_collect(os.path.expanduser("~"), days, cutoff)
    rows += codex_collect(os.path.expanduser("~"), days, cutoff)

    totals_map = {}
    daily_map = {}
    by_model_map = {}
    by_provider_map = {}
    by_agent_map = {}

    def add(d, key, r):
        e = d.setdefault(key, {
            "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
            "estimated_cost": 0.0, "sessions": 0, "api_calls": 0,
        })
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "api_calls"):
            e[k] += r.get(k) or 0
        e["estimated_cost"] += r.get("computed_cost", 0.0) or 0.0
        e["sessions"] += 1 if not r.get("aux") else 0

    for r in rows:
        # cost: price table first, fall back to Hermes estimate
        cost, prices = compute_cost_usd(
            r.get("provider"), r.get("model"),
            r.get("input_tokens"), r.get("output_tokens"), r.get("cache_read_tokens"),
        )
        if cost is not None:
            r["computed_cost"] = cost
            r["price_used"] = prices
        else:
            r["computed_cost"] = round(r.get("est_cost") or 0.0, 6)
            r["price_used"] = None

        add(totals_map, "total", r)
        day = time.strftime("%Y-%m-%d", time.localtime(r.get("started_at") or time.time()))
        add(daily_map, day, r)
        model_key = (r.get("model") or "unknown") + "|" + (r.get("provider") or "unknown")
        add(by_model_map, model_key, r)
        prov_key = r.get("provider") or "unknown"
        add(by_provider_map, prov_key, r)
        agent_key = r.get("agent") or "hermes"
        add(by_agent_map, agent_key, r)

    def finalize(m, key_name):
        out = []
        for k, v in m.items():
            v[key_name] = k
            v["cache_hit_pct"] = cache_hit_pct(v["cache_read_tokens"], v["input_tokens"])
            out.append(v)
        return out

    totals = totals_map.get("total", {})
    totals["cache_hit_pct"] = cache_hit_pct(totals.get("cache_read_tokens", 0), totals.get("input_tokens", 0))

    def _has_usage(row):
        """Drop noise rows (empty sessions, NULL providers) that never made a call."""
        return (
            (row.get("api_calls") or 0) > 0
            or (row.get("input_tokens") or 0) > 0
            or (row.get("output_tokens") or 0) > 0
            or (row.get("cache_read_tokens") or 0) > 0
        )

    daily = sorted(finalize(daily_map, "day"), key=lambda d: d["day"])
    by_model = sorted(finalize(by_model_map, "model"), key=lambda m: m["estimated_cost"], reverse=True)
    by_provider = sorted(finalize(by_provider_map, "provider"), key=lambda p: p["estimated_cost"], reverse=True)
    by_agent = sorted(finalize(by_agent_map, "agent"), key=lambda a: a["estimated_cost"], reverse=True)

    # Hide providers/models/agents with zero usage (e.g. billing_provider NULL
    # on an empty session surfaced as "unknown").
    by_model = [m for m in by_model if _has_usage(m)]
    by_provider = [p for p in by_provider if _has_usage(p)]
    by_agent = [a for a in by_agent if _has_usage(a)]

    # Placeholder provider names (NULL billing_provider -> "unknown", model
    # auto-fallback -> "auto") can't be fixed at the source — hide them so the
    # per-provider breakdown only shows real APIs. Totals still include them.
    _PLACEHOLDER_PROVIDERS = {"unknown", "auto"}
    by_provider = [p for p in by_provider if p.get("provider") not in _PLACEHOLDER_PROVIDERS]

    return {
        "ok": True,
        "days": days,
        "generated_at": time.time(),
        "totals": totals,
        "daily": daily,
        "by_model": by_model,
        "by_provider": by_provider,
        "by_agent": by_agent,
    }


def collect_live(hermes_home, limit=8):
    rows = []
    db_path = _hermes_db_path(hermes_home)
    if os.path.isfile(db_path):
        uri = "file:{}?mode=ro".format(urllib.parse.quote(db_path.replace("\\", "/")))
        conn = sqlite3.connect(uri, uri=True, timeout=20)
        conn.row_factory = sqlite3.Row
        try:
            for r in conn.execute(
                """
                SELECT id, title, model, COALESCE(NULLIF(billing_provider,''),'unknown') AS provider,
                       COALESCE(input_tokens,0) AS input_tokens,
                       COALESCE(output_tokens,0) AS output_tokens,
                       COALESCE(cache_read_tokens,0) AS cache_read_tokens,
                       COALESCE(estimated_cost_usd,0) AS est_cost,
                       COALESCE(api_call_count,0) AS api_calls,
                       started_at, COALESCE(last_activity_at, started_at) AS last_activity_at
                FROM sessions
                WHERE started_at IS NOT NULL
                  AND (COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
                       + COALESCE(cache_read_tokens,0) + COALESCE(api_call_count,0)) > 0
                ORDER BY COALESCE(last_activity_at, started_at) DESC
                LIMIT ?
                """,
                (limit * 3,),
            ):
                rows.append(dict(r))
        finally:
            conn.close()

    out = []
    for r in rows[:limit]:
        cost, prices = compute_cost_usd(
            r.get("provider"), r.get("model"),
            r.get("input_tokens"), r.get("output_tokens"), r.get("cache_read_tokens"),
        )
        r["estimated_cost"] = cost if cost is not None else round(r.get("est_cost") or 0.0, 6)
        r["price_used"] = prices
        r["cache_hit_pct"] = cache_hit_pct(r["cache_read_tokens"], r["input_tokens"])
        r["reltime"] = reltime(r.get("last_activity_at"))
        out.append(r)
    return {"ok": True, "generated_at": time.time(), "sessions": out}


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "AIUsageMonitor/1.0"

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_POST(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/control":
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
                enabled = bool(body.get("enabled"))
                set_monitor_enabled(enabled)
                # The process STAYS ALIVE (watchdog keeps it up); the switch
                # only gates the data endpoints. This keeps the toggle always
                # reachable — no "server is down so I can't turn it back on".
                self._send({"ok": True, "monitor_enabled": enabled})
                return
            self._send({"ok": False, "error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            try:
                self._send({"ok": False, "error": str(exc)}, 500)
            except Exception:
                pass

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/health":
                return self._send({"ok": True, "pid": os.getpid()})
            if parsed.path == "/api/config":
                return self._send({
                    "ok": True,
                    "prices": {p: {m: pr for m, pr in t.items()} for p, t in PRICES.items() if not p.startswith("_")},
                    "usd_cny": CONFIG.get("usd_cny", 7.2),
                    "currency_auto": CONFIG.get("currency_auto", True),
                    "monitor_enabled": CONFIG.get("monitor_enabled", True),
                })
            if parsed.path == "/api/stats":
                if not CONFIG.get("monitor_enabled", True):
                    return self._send({"ok": False, "disabled": True, "monitor_enabled": False}, 503)
                days = int(qs.get("days", ["30"])[0])
                days = max(1, min(days, 365))
                return self._send(collect_stats(days, self.server.hermes_home))
            if parsed.path == "/api/live":
                if not CONFIG.get("monitor_enabled", True):
                    return self._send({"ok": False, "disabled": True, "monitor_enabled": False}, 503)
                limit = int(qs.get("limit", ["8"])[0])
                return self._send(collect_live(self.server.hermes_home, limit))
            self._send({"ok": False, "error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            try:
                self._send({"ok": False, "error": str(exc)}, 500)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        # Request log — only when STATS_REQ_LOG=1 is set (diagnostics).
        try:
            import os
            if os.environ.get("STATS_REQ_LOG"):
                _p = os.path.join(os.environ.get("TEMP", "/tmp"), "stats_server_req.log")
                with open(_p, "a", encoding="utf-8") as _f:
                    _f.write("%s %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass


class Server(ThreadingHTTPServer):
    def __init__(self, addr, handler, hermes_home):
        self.hermes_home = hermes_home
        super().__init__(addr, handler)


def main():
    ap = argparse.ArgumentParser(description="AI Usage Monitor stats server")
    ap.add_argument("--port", type=int, default=9543)
    ap.add_argument("--home", default=DEFAULT_HERMES_HOME, help="Hermes home (default: auto-detect)")
    ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    if not os.path.isfile(_hermes_db_path(args.home)):
        print("WARNING: no state.db found at {}".format(_hermes_db_path(args.home)), file=sys.stderr)
        print("The Hermes adapter will return no data. Claude Code / Codex adapters still work.", file=sys.stderr)

    srv = Server((args.bind, args.port), Handler, args.home)
    print("AI Usage Monitor listening on http://{}:{}".format(args.bind, args.port))
    print("Hermes home: {}".format(args.home))
    print("Price table: {} entries across {} providers".format(
        sum(len(v) for k, v in PRICES.items() if not k.startswith("_")),
        sum(1 for k in PRICES if not k.startswith("_")),
    ))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
