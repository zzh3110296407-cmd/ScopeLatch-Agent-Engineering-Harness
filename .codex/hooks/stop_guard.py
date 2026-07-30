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

from pre_tool_use_policy import active_harness_binding


def run(cmd: list[str], *, cwd: Path | None = None, timeout: int | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )


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

    active, reason = active_harness_binding(root, payload, allow_closed=True)
    if not active:
        return block(
            "Worktree has changes but no unique authoritative Harness run is available "
            f"for this session: {reason}. Set HARNESS_RUN_ID or create a fresh plan."
        )
    run_dir = active["run_dir"]
    manifest = active["manifest"]
    manifest_file = run_dir / "run-manifest.json"

    if closeout_is_incomplete(run_dir, manifest) and auto_closeout_enabled(root):
        closeout_result = run_auto_closeout(root, run_dir)
        if closeout_result.returncode != 0:
            return block(
                "Automatic Harness closeout failed. Resolve the reported Guard or validation failure before stopping. "
                + summarize_process_failure(closeout_result)
            )
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception as exc:
            return block(f"Automatic Harness closeout completed but its manifest is unreadable: {exc}.")

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


def closeout_is_incomplete(run_dir: Path, manifest: dict) -> bool:
    required = [
        run_dir / "validation-result.json",
        run_dir / "post-validation-guard-result.json",
        run_dir / "pr-report.md",
    ]
    return (
        manifest.get("status") != "passed"
        or manifest.get("phase") not in {"closeout-complete", "repair-closeout-complete"}
        or any(not item.exists() for item in required)
    )


def auto_closeout_enabled(root: Path) -> bool:
    override = os.environ.get("HARNESS_STOP_AUTOCLOSEOUT")
    if override is not None:
        return override.lower() not in {"0", "false", "off"}
    return bool(load_harness_policy(root).get("autoCloseoutOnStop", True))


def run_auto_closeout(root: Path, run_dir: Path) -> subprocess.CompletedProcess:
    policy = load_harness_policy(root)
    configured = policy.get("autoCloseoutTimeoutSeconds", 900)
    override = os.environ.get("HARNESS_STOP_AUTOCLOSEOUT_TIMEOUT_SECONDS")
    try:
        timeout = int(override or configured)
    except (TypeError, ValueError):
        timeout = 900
    timeout = max(30, min(timeout, 3600))
    try:
        return run(
            ["node", "harness/cli.mjs", "closeout", "--run", str(run_dir)],
            cwd=root,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(
            exc.cmd,
            124,
            stdout=exc.stdout or "",
            stderr=f"Automatic closeout timed out after {timeout} seconds.\n{exc.stderr or ''}",
        )


def load_harness_policy(root: Path) -> dict:
    for relative in (".harness/harness.config.json", ".harness/harness.config.example.json"):
        file = root / relative
        if not file.exists():
            continue
        try:
            return (json.loads(file.read_text(encoding="utf-8")) or {}).get("policy") or {}
        except Exception:
            continue
    return {}


def summarize_process_failure(result: subprocess.CompletedProcess) -> str:
    combined = "\n".join(part.strip() for part in (result.stdout or "", result.stderr or "") if part.strip())
    lines = [line.strip() for line in combined.splitlines() if line.strip()]
    summary = " | ".join(lines[-6:]) if lines else "No diagnostic output was produced."
    return f"Exit code {result.returncode}: {summary[:1800]}"


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
