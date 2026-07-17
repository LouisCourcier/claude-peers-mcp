"""Tests for the peers_activity UserPromptSubmit hook."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOOK = Path(__file__).parent / "peers_activity.py"


class _Capture(BaseHTTPRequestHandler):
    received: list[dict] = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        _Capture.received.append({"path": self.path, "body": json.loads(body)})
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


def _run_hook(stdin_text: str, port: int, extra_env: dict | None = None):
    import os

    env = dict(os.environ)
    env["CLAUDE_PEERS_PORT"] = str(port)
    env.update(extra_env or {})
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=stdin_text,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


def _with_server(fn):
    server = HTTPServer(("127.0.0.1", 0), _Capture)
    _Capture.received = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        return fn(server.server_address[1])
    finally:
        server.shutdown()


def test_posts_activity_with_pid_override():
    def run(port):
        payload = json.dumps(
            {
                "prompt": "analyse complete du provider bloomberg",
                "cwd": str(HOOK.parent),
            }
        )
        result = _run_hook(payload, port, {"CLAUDE_PEERS_PID_OVERRIDE": "4242"})
        assert result.returncode == 0
        assert result.stdout == ""
        assert len(_Capture.received) == 1
        req = _Capture.received[0]
        assert req["path"] == "/update-activity"
        assert req["body"]["claude_pid"] == 4242
        assert req["body"]["prompt_head"] == "analyse complete du provider bloomberg"

    _with_server(run)


def test_prompt_head_truncated_to_80():
    def run(port):
        payload = json.dumps({"prompt": "x" * 300, "cwd": "/tmp"})
        result = _run_hook(payload, port, {"CLAUDE_PEERS_PID_OVERRIDE": "1"})
        assert result.returncode == 0
        assert result.stdout == ""
        assert len(_Capture.received[0]["body"]["prompt_head"]) == 80

    _with_server(run)


def test_garbage_stdin_is_silent_noop():
    result = _run_hook("not json at all", 1, None)
    assert result.returncode == 0
    assert result.stdout == ""


def test_broker_down_is_silent_noop():
    payload = json.dumps({"prompt": "hello there general kenobi today", "cwd": "/tmp"})
    result = _run_hook(
        payload, 1, {"CLAUDE_PEERS_PID_OVERRIDE": "1"}
    )  # port 1: nothing listens
    assert result.returncode == 0
    assert result.stdout == ""
