"""Harness host-side validation guard.

This guard is defense in depth for local H7 execution. Formal OS-level
isolation remains an H8 CI sandbox responsibility.
"""

from __future__ import annotations

import os
import builtins
import io
import pathlib
import socket
import subprocess
from typing import Any


_OriginalSocketConnect = socket.socket.connect


def _deny_network(*_args: Any, **_kwargs: Any) -> Any:
    raise OSError("HARNESS_NETWORK_DENIED: network access is disabled for this validation.")


def _isolated_socketpair(
    family: int = socket.AF_INET,
    type: int = socket.SOCK_STREAM,
    proto: int = 0,
) -> tuple[socket.socket, socket.socket]:
    """Create asyncio's authenticated local self-pipe without opening network access."""
    if family == socket.AF_INET:
        host = "127.0.0.1"
    elif family == socket.AF_INET6:
        host = "::1"
    else:
        raise ValueError("Harness socketpair supports only AF_INET and AF_INET6.")
    if type != socket.SOCK_STREAM or proto != 0:
        raise ValueError("Harness socketpair requires SOCK_STREAM with protocol zero.")

    listener = socket.socket(family, type, proto)
    server = None
    client = None
    try:
        listener.bind((host, 0))
        listener.listen()
        address, port = listener.getsockname()[:2]
        client = socket.socket(family, type, proto)
        client.setblocking(False)
        try:
            _OriginalSocketConnect(client, (address, port))
        except (BlockingIOError, InterruptedError):
            pass
        client.setblocking(True)
        server, _ = listener.accept()
    except BaseException:
        if client is not None:
            client.close()
        if server is not None:
            server.close()
        raise
    finally:
        listener.close()

    try:
        if (
            server.getsockname() != client.getpeername()
            or client.getsockname() != server.getpeername()
        ):
            raise ConnectionError("Unexpected Harness socketpair peer.")
    except BaseException:
        server.close()
        client.close()
        raise
    return server, client


if os.environ.get("HARNESS_NETWORK_MODE", "deny") == "deny":
    socket.socketpair = _isolated_socketpair
    socket.create_connection = _deny_network
    socket.getaddrinfo = _deny_network
    socket.socket.connect = _deny_network
    socket.socket.connect_ex = _deny_network


_MAX_PROCESSES = max(1, min(64, int(os.environ.get("HARNESS_MAX_PROCESSES", "16"))))
_active_children = 0
_OriginalPopen = subprocess.Popen
_CANDIDATE_ROOT = pathlib.Path(os.environ.get("HARNESS_CANDIDATE_ROOT", os.getcwd())).resolve()
_SCRATCH_ROOT = (
    pathlib.Path(os.environ["HARNESS_SCRATCH_ROOT"]).resolve()
    if os.environ.get("HARNESS_SCRATCH_ROOT")
    else None
)
try:
    import json

    _WRITABLE_PATHS = [
        pathlib.Path(item).resolve()
        for item in json.loads(os.environ.get("HARNESS_WRITABLE_PATHS", "[]"))
    ]
except (TypeError, ValueError):
    _WRITABLE_PATHS = []


class _GuardedPopen(_OriginalPopen[Any]):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        global _active_children
        if kwargs.get("shell"):
            raise RuntimeError("HARNESS_SHELL_FORBIDDEN: child shell execution is disabled.")
        if _active_children + 1 >= _MAX_PROCESSES:
            raise RuntimeError(
                f"HARNESS_PROCESS_LIMIT_EXCEEDED: maximum concurrent process count is {_MAX_PROCESSES}."
            )
        _active_children += 1
        self._harness_process_slot_released = False
        try:
            super().__init__(*args, **kwargs)
        except BaseException:
            self._release_harness_process_slot()
            raise

    def _release_harness_process_slot(self) -> None:
        global _active_children
        if self._harness_process_slot_released:
            return
        self._harness_process_slot_released = True
        _active_children = max(0, _active_children - 1)

    def wait(self, *args: Any, **kwargs: Any) -> int:
        result = super().wait(*args, **kwargs)
        self._release_harness_process_slot()
        return result

    def communicate(self, *args: Any, **kwargs: Any) -> tuple[Any, Any]:
        result = super().communicate(*args, **kwargs)
        self._release_harness_process_slot()
        return result

    def poll(self) -> int | None:
        result = super().poll()
        if result is not None:
            self._release_harness_process_slot()
        return result


subprocess.Popen = _GuardedPopen


def _is_within(target: pathlib.Path, root: pathlib.Path | None) -> bool:
    if root is None:
        return False
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def _assert_writable(target: Any) -> None:
    if isinstance(target, int):
        return
    resolved = pathlib.Path(target).resolve()
    if _is_within(resolved, _SCRATCH_ROOT) or any(
        _is_within(resolved, allowed) for allowed in _WRITABLE_PATHS
    ):
        return
    safe_path = (
        str(resolved.relative_to(_CANDIDATE_ROOT))
        if _is_within(resolved, _CANDIDATE_ROOT)
        else "<outside-candidate>"
    )
    raise PermissionError(f"HARNESS_WRITE_BOUNDARY_DENIED: {safe_path}")


_original_open = builtins.open
_original_io_open = io.open


def _guarded_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
    if any(flag in mode for flag in ("w", "a", "x", "+")):
        _assert_writable(file)
    return _original_open(file, mode, *args, **kwargs)


def _guarded_io_open(file: Any, mode: str = "r", *args: Any, **kwargs: Any) -> Any:
    if any(flag in mode for flag in ("w", "a", "x", "+")):
        _assert_writable(file)
    return _original_io_open(file, mode, *args, **kwargs)


builtins.open = _guarded_open
io.open = _guarded_io_open


def _guard_one_path(name: str) -> None:
    original = getattr(os, name, None)
    if original is None:
        return

    def guarded(target: Any, *args: Any, **kwargs: Any) -> Any:
        _assert_writable(target)
        return original(target, *args, **kwargs)

    setattr(os, name, guarded)


for _method in (
    "chmod",
    "chown",
    "lchown",
    "mkdir",
    "makedirs",
    "remove",
    "removedirs",
    "rmdir",
    "unlink",
    "truncate",
    "utime",
):
    _guard_one_path(_method)


for _method in ("rename", "renames", "replace"):
    _original = getattr(os, _method, None)
    if _original is None:
        continue

    def _guarded_two_path(source: Any, destination: Any, *args: Any, __original: Any = _original, **kwargs: Any) -> Any:
        _assert_writable(destination)
        return __original(source, destination, *args, **kwargs)

    setattr(os, _method, _guarded_two_path)


_original_os_open = os.open


def _guarded_os_open(file: Any, flags: int, *args: Any, **kwargs: Any) -> Any:
    write_mask = (
        os.O_WRONLY
        | os.O_RDWR
        | os.O_APPEND
        | os.O_CREAT
        | os.O_TRUNC
    )
    if flags & write_mask:
        _assert_writable(file)
    return _original_os_open(file, flags, *args, **kwargs)


os.open = _guarded_os_open
