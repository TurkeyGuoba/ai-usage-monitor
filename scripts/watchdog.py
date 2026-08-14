#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI Usage Monitor — watchdog for Hermes cron (no_agent mode)
============================================================
Every tick: if http://127.0.0.1:9543/health is not OK, relaunch the stats
server as an INDEPENDENT process (pythonw, no console window) and report the
outcome. When the server is healthy, prints NOTHING (silent tick — cron
delivers nothing, keeping the channel quiet).

Independent process = launched via CREATE_NO_WINDOW pythonw, NOT tied to any
Hermes session, survives Hermes restarts. Driven by cron every 5 minutes.
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

PORT = 9543
PYW = r"C:\Users\yangx\AppData\Local\hermes\hermes-agent\venv\Scripts\pythonw.exe"
if not os.path.isfile(PYW):
    PYW = "pythonw.exe"
STATS_SERVER = r"C:\Users\yangx\Desktop\project\ai-usage-monitor\stats_server.py"
if not os.path.isfile(STATS_SERVER):
    STATS_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ai-usage-monitor", "stats_server.py")

CREATE_NO_WINDOW = 0x08000000


def healthy(timeout=3):
    try:
        r = urllib.request.urlopen("http://127.0.0.1:%d/health" % PORT, timeout=timeout)
        return r.status == 200
    except Exception:
        return False


def main():
    if healthy():
        return  # silent tick
    # The on/off switch lives at the API layer (monitor_enabled in config.json).
    # The watchdog ONLY keeps the process alive, so the toggle is always
    # reachable — even if the process crashed while disabled.
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    try:
        subprocess.Popen(
            [PYW, STATS_SERVER, "--port", str(PORT)],
            env=env,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
        )
    except Exception as exc:
        print("AI Usage Monitor relaunch FAILED: %s" % exc)
        return 1
    time.sleep(3)
    if healthy():
        print("AI Usage Monitor was down — relaunched (port %d, silent window)." % PORT)
        return 0
    print("AI Usage Monitor relaunch attempted but health check still failing (port %d)." % PORT)
    return 1


if __name__ == "__main__":
    sys.exit(main())