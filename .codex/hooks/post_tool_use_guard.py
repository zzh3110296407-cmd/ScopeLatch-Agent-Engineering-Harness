#!/usr/bin/env python3
"""Codex PostToolUse hook that verifies actual repository side effects."""

import json
import subprocess
import sys
from pathlib import Path

from pre_tool_use_policy import active_harness_binding, git_root


def emit(payload: dict) -> None:
    print(json.dumps(payload))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    root = git_root()
    if not root:
        return 0
    binding, reason = active_harness_binding(root, payload, allow_closed=True)
    if not binding:
        emit({
            "decision": "block",
            "reason": f"Harness post-tool guard could not verify the active lease: {reason}. Create a fresh plan before continuing."
        })
        return 0

    result = subprocess.run(
        ["node", "harness/cli.mjs", "post-check", "--run", str(binding["run_dir"])],
        cwd=str(root),
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=60,
    )
    if result.returncode != 0:
        details = post_check_summary(result.stdout)
        emit({
            "decision": "block",
            "reason": "Harness detected an unapproved repository side effect after the tool call. " + details
        })
        return 0
    emit({"continue": True})
    return 0


def post_check_summary(stdout: str) -> str:
    try:
        report = json.loads(stdout.strip().splitlines()[-1])
        findings = report.get("findings") or []
        ids = [str(item.get("id")) for item in findings if item.get("id")]
        files = []
        for item in findings:
            files.extend(str(value) for value in (item.get("files") or []))
        return f"Findings: {', '.join(ids[:6]) or 'unknown'}; files: {', '.join(files[:8]) or 'unknown'}."
    except Exception:
        return "The read-only post-check failed; inspect the active Harness run before continuing."


if __name__ == "__main__":
    raise SystemExit(main())
