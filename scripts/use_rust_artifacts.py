#!/usr/bin/env python3
"""Adopt an already-published independent Rust artifact bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = "pathlyapp/opensteerable"
NATIVE = "steerable-agent-runtime-native"
PIN_FILES = (
    ROOT / "packages/agent-runtime/py/pyproject.toml",
    ROOT / "pyproject.toml",
)
WHEEL_MARKERS = (
    "manylinux",
    "musllinux",
    "macosx_11_0_arm64",
    "macosx_10_12_x86_64",
    "win_amd64",
)


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def digest(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def release_url(version: str, name: str) -> str:
    return f"https://github.com/{REPO}/releases/download/rust-v{version}/{name}"


def verify_bundle(version: str) -> tuple[dict[str, object], str]:
    name = f"steerable-rust-artifacts-{version}-manifest.json"
    blob = fetch(release_url(version, name))
    manifest = json.loads(blob)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("artifactVersion") != version
        or manifest.get("releaseTag") != f"rust-v{version}"
    ):
        raise SystemExit("Rust bundle manifest header mismatch")

    pypi = json.loads(fetch(f"https://pypi.org/pypi/{NATIVE}/{version}/json"))
    wheels = [item for item in pypi["urls"] if item["packagetype"] == "bdist_wheel"]
    if any(item["packagetype"] == "sdist" for item in pypi["urls"]):
        raise SystemExit("native release contains a forbidden sdist")
    names = [item["filename"] for item in wheels]
    for marker in WHEEL_MARKERS:
        if not any(marker in filename for filename in names):
            raise SystemExit(f"native release has no {marker} wheel")
    listed = {
        item["name"]: item["sha256"]
        for item in manifest["native"]["files"]
    }
    for item in wheels:
        if listed.get(item["filename"]) != item["digests"]["sha256"]:
            raise SystemExit(f"native wheel mismatch: {item['filename']}")

    for component in manifest["components"]:
        component_blob = fetch(release_url(version, component["manifest"]))
        if digest(component_blob) != component["sha256"]:
            raise SystemExit(f"component manifest mismatch: {component['manifest']}")
        data = json.loads(component_blob)
        for item in data["files"]:
            asset = fetch(release_url(version, item["name"]))
            if len(asset) != item["bytes"] or digest(asset) != item["sha256"]:
                raise SystemExit(f"artifact mismatch: {item['name']}")
    return manifest, digest(blob)


def update_pin(path: Path, version: str) -> None:
    text = path.read_text(encoding="utf-8")
    text, count = re.subn(
        rf"{re.escape(NATIVE)}==[^\"']+",
        f"{NATIVE}=={version}",
        text,
    )
    if count < 1:
        raise SystemExit(f"{path} has no exact native pin")
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    args = parser.parse_args()
    manifest, manifest_sha = verify_bundle(args.version)
    compatibility = manifest["compatibility"]
    lock = {
        "schemaVersion": 1,
        "artifactVersion": args.version,
        "release": {
            "repository": REPO,
            "tag": f"rust-v{args.version}",
            "manifest": f"steerable-rust-artifacts-{args.version}-manifest.json",
            "sha256": manifest_sha,
        },
        "native": {
            "package": NATIVE,
            "version": args.version,
        },
        "compatibility": compatibility,
    }
    (ROOT / "rust-artifacts.lock.json").write_text(
        json.dumps(lock, indent=2) + "\n", encoding="utf-8"
    )
    for path in PIN_FILES:
        update_pin(path, args.version)
    subprocess.run(["uv", "lock"], cwd=ROOT, check=True)
    # uv records an sdist published by old releases. Public source policy
    # forbids retaining that URL even when wheels are selected.
    lock_path = ROOT / "uv.lock"
    kept = [
        line
        for line in lock_path.read_text(encoding="utf-8").splitlines(keepends=True)
        if not (NATIVE.replace("-", "_") in line and line.strip().startswith("sdist"))
    ]
    lock_path.write_text("".join(kept), encoding="utf-8")
    print(f"adopted Rust artifacts {args.version}")


if __name__ == "__main__":
    main()
