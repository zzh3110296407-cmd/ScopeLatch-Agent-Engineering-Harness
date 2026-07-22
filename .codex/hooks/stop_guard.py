#!/usr/bin/env python3
"""Codex Stop hook for harness validation reminders.

If a worktree has changed and the latest harness run has no validation result,
this asks Codex to continue once and either run validation or explain why it
cannot be run. To disable strict continuation, set HARNESS_STOP_GUARD=off.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from pre_tool_use_policy import session_fingerprint, session_identity


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def emit(payload: dict) -> None:
    print(json.dumps(payload))


def block(reason: str) -> int:
    emit({
        "decision": "block",
        "reason": reason,
    })
    return 0


def allow() -> int:
    emit({"continue": True})
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    if os.environ.get("HARNESS_STOP_GUARD", "on").lower() in {"0", "false", "off"}:
        return allow()

    if payload.get("stop_hook_active"):
        return allow()

    root_res = run(["git", "rev-parse", "--show-toplevel"])
    if root_res.returncode != 0:
        return allow()

    root = Path(root_res.stdout.strip())
    status = run(["git", "status", "--porcelain", "-uall"])
    if status.returncode != 0 or not status.stdout.strip():
        return allow()

    latest = root / ".harness" / "state" / "latest-run.json"
    if not latest.exists():
        return block("Worktree has changes but no harness run exists. Run `node harness/cli.mjs plan \"<task>\"`, inspect the plan, then continue.")

    try:
        state = json.loads(latest.read_text(encoding="utf-8"))
        run_dir = Path(state["runDir"])
    except Exception as exc:
        return block(f"Worktree has changes but latest harness state cannot be read safely: {exc}. Run `node harness/cli.mjs plan \"<task>\"` again.")

    if not run_dir.exists():
        return block(f"Worktree has changes but latest harness run directory is missing: {run_dir}. Run `node harness/cli.mjs plan \"<task>\"` again.")

    manifest_file = run_dir / "run-manifest.json"
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return block(f"Harness manifest cannot be read safely: {exc}. Create a fresh plan.")
    binding = manifest.get("binding") or {}
    if int(manifest.get("schemaVersion") or 0) < 4:
        return block("The latest Harness run uses a legacy lease. Create a fresh session-bound plan.")
    expected_session = binding.get("sessionFingerprint")
    current_session = session_fingerprint(session_identity(payload))
    if binding.get("sessionBindingRequired", True) and (not expected_session or expected_session != current_session):
        return block("The latest Harness run is not bound to this Codex session. Create and validate a plan in the current session.")

    validation = run_dir / "validation-result.json"
    if not validation.exists():
        return block("Worktree has changes but no validation result exists for the latest harness run. Run `node harness/cli.mjs validate --plan .harness/runs/<latest>/validation-plan.json` or explain exactly why validation cannot run.")

    post_guard = run_dir / "post-validation-guard-result.json"
    if not post_guard.exists():
        return block("Validation exists, but the required post-validation Guard is missing. Run Harness validate or closeout again.")
    try:
        post_guard_result = json.loads(post_guard.read_text(encoding="utf-8"))
    except Exception:
        return block("The post-validation Guard result is unreadable. Run Harness validate or closeout again.")
    if post_guard_result.get("status") == "failed":
        return block("The post-validation Guard failed. Resolve its findings before stopping.")

    if manifest.get("status") != "passed" or manifest.get("phase") not in {
        "closeout-complete",
        "repair-closeout-complete",
    }:
        return block(
            "Validation evidence exists, but Harness closeout is incomplete "
            f"(status={manifest.get('status')}, phase={manifest.get('phase')}). "
            "Run `node harness/cli.mjs closeout --run .harness/runs/<latest>`."
        )

    report = run_dir / "pr-report.md"
    if not report.exists():
        return block("Harness closeout is missing pr-report.md. Run the closeout command again.")

    newer = changed_files_newer_than_validation(root, status.stdout, validation)
    if newer:
        listed = ", ".join(newer[:8])
        suffix = "" if len(newer) <= 8 else f", ... +{len(newer) - 8} more"
        return block(f"Worktree has files newer than the latest validation result: {listed}{suffix}. Re-run Harness validation for the current changes.")

    return allow()


def changed_files_newer_than_validation(root: Path, porcelain: str, validation: Path) -> list[str]:
    validation_mtime = validation.stat().st_mtime
    newer: list[str] = []
    for rel in changed_paths_from_porcelain(porcelain):
        file = root / rel
        try:
            if file.is_file() and file.stat().st_mtime > validation_mtime + 0.5:
                newer.append(rel.as_posix())
        except OSError:
            continue
    return newer


def changed_paths_from_porcelain(porcelain: str) -> list[Path]:
    paths: list[Path] = []
    for line in porcelain.splitlines():
        if len(line) < 4:
            continue
        body = line[3:]
        if " -> " in body:
            body = body.split(" -> ", 1)[1]
        paths.append(Path(unquote_git_path(body)))
    return paths


def unquote_git_path(value: str) -> str:
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        body = value[1:-1]
        return (
            body
            .replace(r"\\", "\\")
            .replace(r"\"", '"')
            .replace(r"\t", "\t")
            .replace(r"\n", "\n")
            .replace(r"\r", "\r")
        )
    return value


if __name__ == "__main__":
    raise SystemExit(main())
