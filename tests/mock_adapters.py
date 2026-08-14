#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Mock-based tests for the Claude Code / Codex JSONL adapters.
Builds fake session files in a temp home, runs the collectors, asserts parsing.

Usage:  python tests/mock_adapters.py
No dependencies beyond stdlib.
"""

import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import stats_server as ss  # noqa: E402


def write_jsonl(path, items):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")


def main():
    tmp = tempfile.mkdtemp(prefix="ai-usage-monitor-test-")
    now = time.time()
    cutoff = now - 60 * 86400  # 60 days: everything fits

    # ---- Claude Code: one session, 3 assistant messages with usage ----
    cc_dir = os.path.join(tmp, ".claude", "projects", "my-project")
    cc_path = os.path.join(cc_dir, "session-abc123.jsonl")
    write_jsonl(cc_path, [
        {"type": "user", "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "message": {
            "role": "assistant", "content": "hello",
            "usage": {"input_tokens": 1000, "output_tokens": 500,
                      "cache_creation_input_tokens": 8000,
                      "cache_read_input_tokens": 4000},
        }},
        {"type": "assistant", "message": {
            "role": "assistant", "content": "again",
            "usage": {"input_tokens": 2000, "output_tokens": 700,
                      "cache_creation_input_tokens": 0,
                      "cache_read_input_tokens": 6000},
        }},
    ])
    os.utime(cc_path, (now, now))

    rows = ss.claude_collect(tmp, 30, cutoff)
    assert len(rows) == 1, f"claude: expected 1 row, got {len(rows)}"
    r = rows[0]
    assert r["input_tokens"] == 3000, r
    assert r["output_tokens"] == 1200, r
    assert r["cache_read_tokens"] == 10000, r
    assert r["provider"] == "anthropic", r
    assert r["title"] == "my-project", r
    print("✅ Claude Code adapter: 3 msgs → 1 session, tokens summed correctly")

    # ---- Codex: response usage buried in nested payloads ----
    cx_dir = os.path.join(tmp, ".codex", "sessions")
    cx_path = os.path.join(cx_dir, "sess-xyz.jsonl")
    write_jsonl(cx_path, [
        {"type": "message", "payload": {"role": "user", "content": [{"type": "input_text", "text": "hi"}]}},
        {"type": "response_item", "payload": {
            "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "hi there"}],
        }},
        {"type": "response", "response": {
            "usage": {"input_tokens": 1234, "output_tokens": 567,
                      "cache_read_input_tokens": 89},
        }},
    ])
    os.utime(cx_path, (now, now))

    rows = ss.codex_collect(tmp, 30, cutoff)
    assert len(rows) == 1, f"codex: expected 1 row, got {len(rows)}"
    r = rows[0]
    assert r["input_tokens"] == 1234, r
    assert r["output_tokens"] == 567, r
    assert r["cache_read_tokens"] == 89, r
    assert r["provider"] == "openai", r
    print("✅ Codex adapter: nested usage found and summed correctly")

    # ---- Cost recompute from price table ----
    cost, prices = ss.compute_cost_usd("siliconflow", "deepseek-ai/DeepSeek-V4-Flash-0731",
                                       1_000_000, 500_000, 2_000_000)
    assert prices == {"input": 0.14, "output": 0.28, "cache_read": 0.028}, prices
    assert abs(cost - (0.14 + 0.14 + 0.056)) < 1e-4, cost
    print("✅ Price table: siliconflow deepseek-v4-flash-0731 → $0.336/1M in + $0.5M out + $2M cache")

    # ---- Longest prefix wins ----
    cost2, prices2 = ss.compute_cost_usd("siliconflow", "deepseek-ai/DeepSeek-V4-Flash",
                                         1_000_000, 0, 0)
    assert prices2 == {"input": 0.14, "output": 0.28, "cache_read": 0.028}, prices2
    print("✅ Price matching: prefix fallback works")

    # ---- Unknown provider → None ----
    assert ss.compute_cost_usd("mystery-provider", "whatever", 1, 1, 1)[0] is None
    print("✅ Unknown provider → falls back to agent estimate (None)")

    print("\nAll adapter tests passed 🎉")


if __name__ == "__main__":
    main()