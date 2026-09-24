#!/usr/bin/env python3
"""Download verified CoreLoop wheels and the Rust sidecar binary.

Wheels come from PyPI. The sidecar binary comes from the public
opensteerable GitHub Release for the same lockstep version. A file is
kept only after its SHA-256 matches the published digest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

NATIVE_PROJECT = "steerable-agent-runtime-native"
RELEASE_REPO = "pathlyapp/opensteerable"
WHEEL_PLATFORMS = (
    "manylinux-x64",
    "manylinux-arm64",
    "musllinux-x64",
    "musllinux-arm64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
)
SIDECAR_TARGETS = ("darwin-arm64", "darwin-x64", "linux-x64", "win32-x64")
ROOT = Path(__file__).resolve().parents[1]


def lockstep_version(root: Path = ROOT) -> str:
    """Return the runtime package version and require the native pin to match."""
    text = (root / "packages" / "agent-runtime" / "py" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    match = re.search(r"(?m)^version = \"([^\"]+)\"", text)
    if match is None:
        raise SystemExit("runtime pyproject.toml has no version")
    version = match.group(1)
    pin = f"{NATIVE_PROJECT}=={version}"
    if pin not in text:
        raise SystemExit(f"runtime is not pinned to {pin}")
    return version


def host_wheel_platform() -> str:
    """Map this machine to a published wheel platform tag."""
    system = platform.system()
    machine = platform.machine().lower()
    arm = machine in {"arm64", "aarch64"}
    if system == "Darwin":
        return "darwin-arm64" if arm else "darwin-x64"
    if system == "Windows":
        return "win32-x64"
    if system == "Linux":
        return "manylinux-arm64" if arm else "manylinux-x64"
    raise SystemExit(f"unsupported host platform {system} {machine}")


def host_sidecar_target() -> str:
    """Map this machine to a published sidecar target name."""
    system = platform.system()
    machine = platform.machine().lower()
    arm = machine in {"arm64", "aarch64"}
    if system == "Darwin":
        return "darwin-arm64" if arm else "darwin-x64"
    if system == "Windows":
        return "win32-x64"
    if system == "Linux" and not arm:
        return "linux-x64"
    raise SystemExit(f"unsupported sidecar host {system} {machine}")


def _wheel_matches(filename: str, wheel_platform: str) -> bool:
    if not filename.endswith(".whl"):
        return False
    if wheel_platform == "manylinux-x64":
        return "manylinux" in filename and "x86_64" in filename and "musllinux" not in filename
    if wheel_platform == "manylinux-arm64":
        return "manylinux" in filename and "aarch64" in filename and "musllinux" not in filename
    if wheel_platform == "musllinux-x64":
        return "musllinux" in filename and "x86_64" in filename
    if wheel_platform == "musllinux-arm64":
        return "musllinux" in filename and "aarch64" in filename
    if wheel_platform == "darwin-arm64":
        return "macosx" in filename and filename.endswith("arm64.whl")
    if wheel_platform == "darwin-x64":
        return "macosx" in filename and "x86_64" in filename
    if wheel_platform == "win32-x64":
        return "win_amd64" in filename
    raise SystemExit(f"unknown wheel platform {wheel_platform}")


def select_wheel(files: list[dict], wheel_platform: str) -> dict:
    """Pick the single binary wheel for ``wheel_platform``."""
    matches = [
        item
        for item in files
        if item.get("packagetype") == "bdist_wheel"
        and _wheel_matches(str(item.get("filename", "")), wheel_platform)
    ]
    if len(matches) != 1:
        names = [item.get("filename") for item in matches]
        raise SystemExit(
            f"expected one {wheel_platform} wheel for {NATIVE_PROJECT}, found {names}"
        )
    return matches[0]


def fetch_bytes(url: str, opener=urllib.request.urlopen) -> bytes:
    """Download ``url`` or raise ``SystemExit`` with the status."""
    try:
        with opener(url) as response:
            status = getattr(response, "status", None) or getattr(response, "code", 200)
            if status != 200:
                raise SystemExit(f"download failed ({status}): {url}")
            return response.read()
    except SystemExit:
        raise
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"download failed ({exc.code}): {url}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"download failed: {url}: {exc.reason}") from exc


def verify_bytes(blob: bytes, expected: str, label: str) -> None:
    """Reject bytes whose SHA-256 is not ``expected``."""
    actual = hashlib.sha256(blob).hexdigest()
    if actual != expected:
        raise SystemExit(f"checksum mismatch for {label}")


def pypi_json_url(version: str) -> str:
    return f"https://pypi.org/pypi/{NATIVE_PROJECT}/{version}/json"


def load_pypi_release(version: str, opener=urllib.request.urlopen) -> dict:
    """Return the PyPI JSON object for one native version."""
    payload = fetch_bytes(pypi_json_url(version), opener)
    return json.loads(payload.decode("utf-8"))


def download_wheel(
    version: str,
    wheel_platform: str,
    dest: Path,
    *,
    opener=urllib.request.urlopen,
) -> Path:
    """Download one verified native wheel into ``dest``."""
    release = load_pypi_release(version, opener)
    chosen = select_wheel(release["urls"], wheel_platform)
    blob = fetch_bytes(str(chosen["url"]), opener)
    verify_bytes(blob, str(chosen["digests"]["sha256"]), str(chosen["filename"]))
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / str(chosen["filename"])
    path.write_bytes(blob)
    return path


def verify_wheel_file(wheel: Path, *, opener=urllib.request.urlopen) -> None:
    """Reject a local wheel whose bytes do not match the PyPI digest."""
    match = re.search(r"-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)-cp", wheel.name)
    if match is None:
        raise SystemExit(f"cannot read the version from {wheel.name}")
    release = load_pypi_release(match.group(1), opener)
    chosen = next(
        (
            item
            for item in release["urls"]
            if item.get("packagetype") == "bdist_wheel" and item.get("filename") == wheel.name
        ),
        None,
    )
    if chosen is None:
        raise SystemExit(f"PyPI has no wheel {wheel.name}")
    verify_bytes(wheel.read_bytes(), str(chosen["digests"]["sha256"]), wheel.name)


def egress_filename(version: str, target: str) -> str:
    """Return the published egress-proxy filename for one target."""
    if target not in SIDECAR_TARGETS:
        raise SystemExit(f"unknown egress target {target}")
    suffix = ".exe" if target == "win32-x64" else ""
    return f"steerable-egress-proxy-bin-{version}-{target}{suffix}"


def egress_manifest_name(version: str) -> str:
    return f"steerable-egress-proxy-bin-{version}-manifest.json"


def download_egress(
    version: str,
    target: str,
    dest: Path,
    *,
    opener=urllib.request.urlopen,
) -> Path:
    """Download one verified egress-proxy binary into ``dest``."""
    manifest_url = release_asset_url(version, egress_manifest_name(version))
    manifest = json.loads(fetch_bytes(manifest_url, opener).decode("utf-8"))
    if manifest.get("version") != version or manifest.get("kind") != "rust-egress-proxy":
        raise SystemExit("egress manifest header mismatch")
    entry = next(
        (item for item in manifest.get("files", []) if item.get("target") == target),
        None,
    )
    if entry is None:
        raise SystemExit(f"egress manifest has no {target}")
    filename = str(entry["name"])
    if filename != egress_filename(version, target):
        raise SystemExit(f"unexpected egress filename {filename}")
    blob = fetch_bytes(release_asset_url(version, filename), opener)
    verify_bytes(blob, str(entry["sha256"]), filename)
    if len(blob) != int(entry["bytes"]):
        raise SystemExit(f"egress size mismatch for {filename}")
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / filename
    path.write_bytes(blob)
    if not filename.endswith(".exe"):
        path.chmod(0o755)
    (dest / f"{filename}.sha256").write_text(
        f"{entry['sha256']}  {filename}\n",
        encoding="utf-8",
    )
    return path


def sidecar_filename(version: str, target: str) -> str:
    """Return the published sidecar filename for one target."""
    if target not in SIDECAR_TARGETS:
        raise SystemExit(f"unknown sidecar target {target}")
    suffix = ".exe" if target == "win32-x64" else ""
    return f"steerable-sidecar-bin-{version}-{target}{suffix}"


def manifest_name(version: str) -> str:
    return f"steerable-sidecar-bin-{version}-manifest.json"


def release_asset_url(version: str, filename: str) -> str:
    return (
        f"https://github.com/{RELEASE_REPO}/releases/download/v{version}/{filename}"
    )


def download_sidecar(
    version: str,
    target: str,
    dest: Path,
    *,
    opener=urllib.request.urlopen,
) -> Path:
    """Download one verified sidecar binary into ``dest``."""
    manifest_url = release_asset_url(version, manifest_name(version))
    manifest = json.loads(fetch_bytes(manifest_url, opener).decode("utf-8"))
    if manifest.get("version") != version or manifest.get("kind") != "rust-sidecar":
        raise SystemExit("sidecar manifest header mismatch")
    entry = next(
        (item for item in manifest.get("files", []) if item.get("target") == target),
        None,
    )
    if entry is None:
        raise SystemExit(f"sidecar manifest has no {target}")
    filename = str(entry["name"])
    if filename != sidecar_filename(version, target):
        raise SystemExit(f"unexpected sidecar filename {filename}")
    blob = fetch_bytes(release_asset_url(version, filename), opener)
    verify_bytes(blob, str(entry["sha256"]), filename)
    if len(blob) != int(entry["bytes"]):
        raise SystemExit(f"sidecar size mismatch for {filename}")
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / filename
    path.write_bytes(blob)
    if not filename.endswith(".exe"):
        path.chmod(0o755)
    (dest / f"{filename}.sha256").write_text(
        f"{entry['sha256']}  {filename}\n",
        encoding="utf-8",
    )
    return path


def smoke_sidecar(binary: Path, timeout: float = 15) -> None:
    """Start a sidecar and require the ready marker plus ``system.ping``."""
    proc = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "STEERABLE_SIDECAR_FAKE_LLM": "1"},
    )
    ready: list[str] = []

    def read_ready() -> None:
        assert proc.stderr is not None
        for raw in proc.stderr:
            text = raw.decode("utf-8", errors="replace")
            if text.startswith("__SIDECAR_READY__:"):
                ready.append(text)
                return

    thread = threading.Thread(target=read_ready)
    thread.start()
    thread.join(timeout)
    if not ready:
        proc.kill()
        raise SystemExit("sidecar did not report ready")
    if '"engine": "rust"' not in ready[0] and '"engine":"rust"' not in ready[0]:
        proc.kill()
        raise SystemExit(f"sidecar ready marker is not rust: {ready[0]!r}")
    assert proc.stdin is not None and proc.stdout is not None
    lifecycle = proc.stdout.readline()
    if b"lifecycle.ready" not in lifecycle:
        proc.kill()
        raise SystemExit(f"sidecar missed lifecycle.ready: {lifecycle!r}")
    proc.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"system.ping"}\n')
    proc.stdin.flush()
    ping = proc.stdout.readline()
    proc.kill()
    proc.wait(timeout=5)
    if b'"id": 1' not in ping and b'"id":1' not in ping:
        raise SystemExit(f"sidecar ping failed: {ping!r}")
    if b"rust" not in ping:
        raise SystemExit(f"sidecar ping did not report rust: {ping!r}")


def _resolve_version(args: argparse.Namespace) -> str:
    if args.lockstep:
        return lockstep_version()
    if not args.version:
        raise SystemExit("pass --version or --lockstep")
    return args.version


def main(argv: list[str] | None = None) -> None:
    """Download wheels, download a sidecar, or smoke-test a sidecar binary."""
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    wheel = sub.add_parser("wheel", help="download one verified native wheel")
    wheel.add_argument("--version")
    wheel.add_argument("--lockstep", action="store_true")
    wheel.add_argument("--platform", choices=[*WHEEL_PLATFORMS, "host"], default="host")
    wheel.add_argument("--out", required=True, type=Path)

    sidecar = sub.add_parser("sidecar", help="download one verified Rust sidecar")
    sidecar.add_argument("--version")
    sidecar.add_argument("--lockstep", action="store_true")
    sidecar.add_argument("--target", choices=[*SIDECAR_TARGETS, "host"], default="host")
    sidecar.add_argument("--out", required=True, type=Path)

    egress = sub.add_parser("egress", help="download one verified egress proxy binary")
    egress.add_argument("--version")
    egress.add_argument("--lockstep", action="store_true")
    egress.add_argument("--target", choices=[*SIDECAR_TARGETS, "host"], default="host")
    egress.add_argument("--out", required=True, type=Path)

    verify = sub.add_parser("verify-wheels", help="download every platform wheel and verify it")
    verify.add_argument("--version")
    verify.add_argument("--lockstep", action="store_true")
    verify.add_argument("--out", type=Path, default=Path("dist/native"))

    smoke = sub.add_parser("smoke-sidecar", help="ping a downloaded sidecar binary")
    smoke.add_argument("--binary", required=True, type=Path)

    args = parser.parse_args(argv)
    if args.command == "wheel":
        wheel_platform = host_wheel_platform() if args.platform == "host" else args.platform
        path = download_wheel(_resolve_version(args), wheel_platform, args.out)
        print(path)
    elif args.command == "sidecar":
        target = host_sidecar_target() if args.target == "host" else args.target
        path = download_sidecar(_resolve_version(args), target, args.out)
        print(path)
    elif args.command == "egress":
        target = host_sidecar_target() if args.target == "host" else args.target
        path = download_egress(_resolve_version(args), target, args.out)
        print(path)
    elif args.command == "verify-wheels":
        version = _resolve_version(args)
        for wheel_platform in WHEEL_PLATFORMS:
            print(download_wheel(version, wheel_platform, args.out))
    elif args.command == "smoke-sidecar":
        smoke_sidecar(args.binary)
        print(f"sidecar smoke ok: {args.binary}")
    else:
        raise SystemExit(f"unknown command {args.command}")


if __name__ == "__main__":
    main(sys.argv[1:])
