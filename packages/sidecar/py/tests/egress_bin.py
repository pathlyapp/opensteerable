"""Spawn the closed-source egress proxy binary for sidecar tests.

The Python package is gone. Tests that need a live proxy start
``steerable-egress-proxy`` from ``STEERABLE_EGRESS_PROXY_BIN`` or from a
local Cargo target. Public CI skips when that binary is not present.
"""

from __future__ import annotations

import os
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]


def find_egress_binary() -> Path | None:
    """Return a built proxy binary, or None when this tree cannot run one."""
    override = os.environ.get("STEERABLE_EGRESS_PROXY_BIN", "").strip()
    if override and Path(override).is_file():
        return Path(override)
    name = "steerable-egress-proxy.exe" if os.name == "nt" else "steerable-egress-proxy"
    for kind in ("debug", "release"):
        candidate = ROOT.joinpath("packages", "egress-proxy", "rs", "target", kind, name)
        if candidate.is_file():
            return candidate
    return None


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


@dataclass
class EgressProxyProcess:
    proc: subprocess.Popen[str]
    port: int
    control_port: int

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def start_egress_proxy(allow: list[str], *, control_token: str = "tok-test") -> EgressProxyProcess:
    """Start the proxy on an ephemeral port and wait until it listens."""
    binary = find_egress_binary()
    if binary is None:
        pytest.skip("steerable-egress-proxy binary is not built")
    port = _free_port()
    env = os.environ.copy()
    env["STEERABLE_EGRESS_CONTROL_TOKEN"] = control_token
    args = [str(binary), "--bind", f"127.0.0.1:{port}", "--control-port", "0", "--control-token-env", "STEERABLE_EGRESS_CONTROL_TOKEN"]
    for host in allow:
        args.extend(["--allow", host])
    proc = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )
    assert proc.stdout is not None
    control_port = 0
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                err = proc.stderr.read() if proc.stderr is not None else ""
                raise RuntimeError(f"egress proxy exited: {err}")
            continue
        if line.startswith("EGRESS_CONTROL_PORT="):
            control_port = int(line.strip().split("=", 1)[1])
            break
    if control_port == 0:
        proc.kill()
        raise RuntimeError("egress proxy did not report a control port")
    return EgressProxyProcess(proc=proc, port=port, control_port=control_port)
