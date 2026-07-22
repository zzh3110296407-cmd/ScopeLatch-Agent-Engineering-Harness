#!/usr/bin/env python3
"""Codex PreToolUse policy hook for destructive commands and Harness leases."""

import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BLOCK_PATTERNS = [
    (r"\brm\s+-rf\s+(/|\$HOME|~|\*)", "Dangerous recursive delete."),
    (r"\bsudo\b", "sudo is not allowed from Codex."),
    (r"\bchmod\s+-R\s+777\b", "chmod -R 777 is not allowed."),
    (r"\bchown\s+-R\b", "Recursive chown is not allowed."),
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard is blocked."),
    (r"\bgit\s+clean\s+-fd", "git clean -fd is blocked."),
    (r"\bgit\s+restore\b", "git restore is blocked because it can overwrite uncommitted work."),
    (r"\bgit\s+checkout\s+--\b", "git checkout -- is blocked because it can overwrite uncommitted work."),
    (r"\bgit\s+push\b", "Codex should not push directly."),
    (r"\bRemove-Item\b(?=[^\r\n]*-(?:Recurse|r)\b)(?=[^\r\n]*-(?:Force|f)\b)", "PowerShell recursive forced delete is blocked."),
    (r"\b(?:rmdir|rd)\b(?=[^\r\n]*/s\b)(?=[^\r\n]*/q\b)", "Windows recursive quiet directory delete is blocked."),
    (r"\bdel\b(?=[^\r\n]*/[fsq]*f)(?=[^\r\n]*/[fsq]*s)", "Windows forced recursive file delete is blocked."),
    (r"\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b", "Windows disk-destructive command is blocked."),
    (r"\b(curl|wget)\b.*\|\s*(sh|bash)\b", "Piping remote scripts into shell is blocked."),
    (r"\b(printenv|env)\b.*(OPENAI|TOKEN|SECRET|KEY|PASSWORD)", "Secret-like environment dump is blocked."),
]

WARN_PATTERNS = [
    (r"\bpnpm\s+install\b|\bnpm\s+install\b|\byarn\s+install\b", "Dependency install changes lockfiles; explain why if this is required."),
    (r"\bprisma\s+migrate\b|\bdrizzle-kit\b|\bmigrate\b", "Migration command detected; verify DB change budget and rollback policy."),
]

WRITE_COMMAND_PATTERNS = [
    r"\bSet-Content\b",
    r"\bAdd-Content\b",
    r"\bOut-File\b",
    r"\bNew-Item\b",
    r"\bCopy-Item\b",
    r"\bMove-Item\b",
    r"\bRemove-Item\b",
    r"\bRename-Item\b",
    r"\b(cat|echo)\b[^|\n\r]*(>|>>)",
    r"\btee\b",
    r"\bsed\b[^|\n\r]*\s-i\b",
    r"\btouch\b",
    r"\b(cp|mv|rm|mkdir|rmdir)\b",
    r"\bgit\s+(?:apply|mv|rm)\b",
    r"\bpatch\b[^\n\r]*\s-i\b",
    r"\bperl\b[^\n\r]*\s-(?:p?i|i?p)\b",
    r"\bpython\b[^|\n\r]*\b(write_text|write_bytes|open\(|shutil\.copy|Path\().*",
    r"\bnode\b[^|\n\r]*\b(writeFileSync|appendFileSync|rmSync|renameSync|mkdirSync|copyFileSync)\b",
    r"\b(?:WriteAllText|WriteAllBytes|AppendAllText|File\.WriteAllText)\b",
]

WRITE_TOOL_NAMES = {
    "apply_patch",
    "functions.apply_patch",
}

HARNESS_COMMAND_PATTERN = re.compile(
    r"\bnode\s+harness[\\/]+cli\.mjs\s+(plan|prompt|run|repair|ci|pr-report|validate|closeout|codex|index|guard|post-check|security|benchmark|sandbox|knowledge|status|version|init)\b",
    flags=re.IGNORECASE,
)
GIT_COMMIT_PATTERN = re.compile(r"\bgit\s+commit\b", flags=re.IGNORECASE)


def emit(payload: dict) -> None:
    print(json.dumps(payload))


def run(cmd: list[str], cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def git_root() -> Path | None:
    res = run(["git", "rev-parse", "--show-toplevel"])
    if res.returncode != 0 or not res.stdout.strip():
        return None
    return Path(res.stdout.strip())


def git_value(root: Path, *args: str) -> str | None:
    res = run(["git", *args], cwd=str(root))
    return res.stdout.strip() if res.returncode == 0 and res.stdout.strip() else None


def session_identity(payload: dict) -> str | None:
    delegated = os.environ.get("HARNESS_SESSION_ID")
    if delegated:
        return delegated
    for key in ("session_id", "sessionId", "thread_id", "threadId", "conversation_id", "conversationId"):
        value = payload.get(key)
        if value:
            return str(value)
    for key in ("CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CONVERSATION_ID"):
        value = os.environ.get(key)
        if value:
            return value
    return None


def session_fingerprint(value: str | None) -> str | None:
    if not value:
        return None
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def active_harness_binding(root: Path, payload: dict | None = None, allow_closed: bool = False) -> tuple[dict | None, str | None]:
    latest = root / ".harness" / "state" / "latest-run.json"
    if not latest.exists():
        return None, "no active Harness plan"
    try:
        state = json.loads(latest.read_text(encoding="utf-8"))
        run_dir = Path(state["runDir"])
        if not run_dir.is_absolute():
            run_dir = root / run_dir
        run_dir = run_dir.resolve()
    except Exception:
        return None, "invalid latest-run state"

    runs_root = (root / ".harness" / "runs").resolve()
    if run_dir != runs_root and runs_root not in run_dir.parents:
        return None, "active run is outside .harness/runs"

    required = [
        "context-pack.md",
        "impact-report.json",
        "validation-plan.json",
        "run-manifest.json",
    ]
    if not run_dir.exists() or not all((run_dir / name).exists() for name in required):
        return None, "active run artifacts are incomplete"

    try:
        manifest = json.loads((run_dir / "run-manifest.json").read_text(encoding="utf-8"))
    except Exception:
        return None, "run manifest is unreadable"

    binding = manifest.get("binding") or {}
    if int(manifest.get("schemaVersion") or 0) < 4 or not binding:
        return None, "legacy Harness plan cannot authorize writes; create a fresh plan"
    allowed_statuses = {"planned", "running", "repairing", "repair-prompt-ready"}
    if allow_closed:
        allowed_statuses.update({"guarded", "passed", "failed"})
    if manifest.get("status") not in allowed_statuses:
        return None, f"Harness plan is closed with status={manifest.get('status')}"
    if state.get("runId") != manifest.get("runId"):
        return None, "latest-run and manifest run IDs do not match"
    if state.get("taskFingerprint") != binding.get("taskFingerprint"):
        return None, "task fingerprint does not match the active run"

    expected_run = os.environ.get("HARNESS_RUN_ID")
    expected_task = os.environ.get("HARNESS_TASK_FINGERPRINT")
    if expected_run and expected_run != manifest.get("runId"):
        return None, "active run does not match HARNESS_RUN_ID"
    if expected_task and expected_task != binding.get("taskFingerprint"):
        return None, "active run does not match HARNESS_TASK_FINGERPRINT"

    expected_session = binding.get("sessionFingerprint")
    current_session = session_fingerprint(session_identity(payload or {}))
    if binding.get("sessionBindingRequired", True) and not expected_session:
        return None, "Harness plan has no session binding"
    if expected_session and not current_session:
        return None, "current Codex session identity is unavailable"
    if expected_session and current_session != expected_session:
        return None, "Harness plan belongs to a different Codex session"

    try:
        expires_at = datetime.fromisoformat(str(binding["expiresAt"]).replace("Z", "+00:00"))
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires_at:
            return None, "Harness plan has expired"
    except Exception:
        return None, "Harness plan expiry is invalid"

    branch = git_value(root, "rev-parse", "--abbrev-ref", "HEAD")
    commit = git_value(root, "rev-parse", "HEAD")
    if binding.get("branch") != branch:
        return None, "Harness plan belongs to a different branch"
    if binding.get("commit") != commit:
        return None, "Harness plan belongs to a different commit"
    return {"state": state, "manifest": manifest, "run_dir": run_dir}, None


def tool_name(payload: dict) -> str:
    raw = payload.get("tool_name") or payload.get("tool") or payload.get("name") or ""
    return str(raw)


def is_write_attempt(payload: dict, command: str) -> bool:
    if tool_name(payload) in WRITE_TOOL_NAMES:
        return True
    return any(re.search(pattern, command, flags=re.IGNORECASE | re.DOTALL) for pattern in WRITE_COMMAND_PATTERNS)


def extract_write_paths(payload: dict, command: str) -> list[str]:
    tool_input = payload.get("tool_input") or {}
    patch = tool_input.get("patch") or tool_input.get("input") or ""
    paths = []
    if isinstance(patch, str):
        paths.extend(re.findall(r"^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$", patch, flags=re.MULTILINE))

    if isinstance(command, str):
        path_arg = re.compile(r"-(?:LiteralPath|Path|Destination)\s+(?:\"([^\"]+)\"|'([^']+)'|([^\s;|]+))", re.IGNORECASE)
        for match in path_arg.finditer(command):
            paths.append(next((part for part in match.groups() if part), ""))
        redirect = re.compile(r"(?:>>|>)\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s;|]+))")
        for match in redirect.finditer(command):
            paths.append(next((part for part in match.groups() if part), ""))
        dotnet_path = re.compile(r"(?:WriteAllText|WriteAllBytes|AppendAllText)\s*\(\s*(?:\"([^\"]+)\"|'([^']+)')", re.IGNORECASE)
        for match in dotnet_path.finditer(command):
            paths.append(next((part for part in match.groups() if part), ""))
    return sorted({path.strip() for path in paths if path and path.strip()})


def normalize_write_path(root: Path, payload: dict, value: str) -> str | None:
    tool_input = payload.get("tool_input") or {}
    workdir = tool_input.get("workdir") or tool_input.get("cwd") or str(root)
    base = Path(workdir)
    if not base.is_absolute():
        base = root / base
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        resolved = candidate.resolve()
        return resolved.relative_to(root.resolve()).as_posix()
    except Exception:
        return None


def path_is_allowed(path_value: str, manifest: dict) -> bool:
    binding = manifest.get("binding") or {}
    allowed_files = {str(item).replace("\\", "/") for item in binding.get("allowedFiles") or []}
    allowed_patterns = [str(item).replace("\\", "/") for item in binding.get("allowedPathPatterns") or []]
    return path_value in allowed_files or any(fnmatch.fnmatchcase(path_value, pattern) for pattern in allowed_patterns)


def closeout_is_complete(binding: dict) -> tuple[bool, str | None]:
    manifest = binding["manifest"]
    run_dir = binding["run_dir"]
    if manifest.get("status") != "passed" or manifest.get("phase") not in {
        "closeout-complete",
        "repair-closeout-complete",
    }:
        return False, f"manifest status={manifest.get('status')} phase={manifest.get('phase')}"
    validation_file = run_dir / "validation-result.json"
    post_guard_file = run_dir / "post-validation-guard-result.json"
    report_file = run_dir / "pr-report.md"
    required = [validation_file, post_guard_file, report_file]
    missing = [file.name for file in required if not file.exists()]
    if missing:
        return False, "missing " + ", ".join(missing)
    try:
        validation = json.loads(validation_file.read_text(encoding="utf-8"))
        post_guard = json.loads(post_guard_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return False, f"unreadable closeout evidence: {exc}"
    if validation.get("status") not in {"passed", "passed-or-skipped"}:
        return False, f"validation status={validation.get('status')}"
    if post_guard.get("status") != "passed":
        return False, f"post-validation Guard status={post_guard.get('status')}"
    return True, None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command") or tool_input.get("cmd") or ""
    if not isinstance(command, str):
        return 0

    for pattern, reason in BLOCK_PATTERNS:
        if re.search(pattern, command, flags=re.IGNORECASE | re.DOTALL):
            emit({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"Harness blocked command: {reason}"
                }
            })
            return 0

    if is_write_attempt(payload, command) and not HARNESS_COMMAND_PATTERN.search(command):
        root = git_root()
        binding, reason = active_harness_binding(root, payload) if root else (None, None)
        if root and not binding:
            emit({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"Harness plan required before file-changing commands ({reason}). Run `node harness/cli.mjs plan \"<task>\"`, inspect the generated context, then retry."
                }
            })
            return 0
        if root and binding:
            raw_paths = extract_write_paths(payload, command)
            if not raw_paths:
                emit({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "Harness could not determine the target path for this write. Use apply_patch or an explicit -LiteralPath/-Path inside the planned scope."
                    }
                })
                return 0
            normalized = [normalize_write_path(root, payload, item) for item in raw_paths]
            denied = [raw for raw, rel in zip(raw_paths, normalized) if rel is None or not path_is_allowed(rel, binding["manifest"])]
            if denied:
                emit({
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "Harness blocked out-of-scope write targets: " + ", ".join(denied[:8])
                    }
                })
                return 0

    if GIT_COMMIT_PATTERN.search(command):
        root = git_root()
        binding, reason = active_harness_binding(root, payload, allow_closed=True) if root else (None, None)
        complete, closeout_reason = closeout_is_complete(binding) if binding else (False, reason)
        if root and not complete:
            emit({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        "Harness requires a validated Harness closeout before git commit "
                        f"({closeout_reason}). Run `node harness/cli.mjs closeout --run .harness/runs/<latest>` first."
                    )
                }
            })
            return 0

    warnings = [reason for pattern, reason in WARN_PATTERNS if re.search(pattern, command, flags=re.IGNORECASE | re.DOTALL)]
    if warnings:
        emit({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": "Harness warning: " + " ".join(warnings)
            }
        })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
