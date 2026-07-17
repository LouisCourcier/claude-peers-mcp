#!/usr/bin/env python3
"""UserPromptSubmit hook: push session activity (prompt head + branch) to the
claude-peers broker so peers see a live identity. Fail-open and SILENT: this
hook must never write to stdout (it would be injected as context) and always
exits 0."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

PROMPT_HEAD_LEN = 80
ANCESTOR_WALK_MAX = 6


def resolve_claude_pid() -> int | None:
    """Walk up the process tree to the first ancestor whose command mentions claude."""
    override = os.environ.get("CLAUDE_PEERS_PID_OVERRIDE")
    if override:
        return int(override)
    pid = os.getppid()
    for _ in range(ANCESTOR_WALK_MAX):
        if pid <= 1:
            return None
        out = subprocess.run(
            ["ps", "-o", "ppid=,command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=1,
        ).stdout.strip()
        if not out:
            return None
        ppid_str, _, command = out.partition(" ")
        if "claude" in command:
            return pid
        pid = int(ppid_str)
    return None


def current_branch(cwd: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return None  # best-effort: a git failure must not suppress the activity POST
    return out.stdout.strip() or None if out.returncode == 0 else None


def main() -> None:
    data = json.load(sys.stdin)
    prompt = (data.get("prompt") or "").strip()
    if not prompt:
        return
    claude_pid = resolve_claude_pid()
    if claude_pid is None:
        return
    payload = {
        "claude_pid": claude_pid,
        "prompt_head": prompt[:PROMPT_HEAD_LEN],
        "branch": current_branch(data.get("cwd") or os.getcwd()),
    }
    port = os.environ.get("CLAUDE_PEERS_PORT", "7899")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/update-activity",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=1).read()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
