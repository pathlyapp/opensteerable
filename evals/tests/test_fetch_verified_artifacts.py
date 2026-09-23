"""Verified downloads of the published CoreLoop wheel and Rust sidecar."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import pytest

from scripts import fetch_verified_artifacts as fetch


class _Response:
    def __init__(self, payload: bytes, status: int = 200) -> None:
        self._payload = payload
        self.status = status

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *_args: object) -> bool:
        return False


def _opener(routes: dict[str, bytes]):
    def opener(url: str) -> _Response:
        if url not in routes:
            raise fetch.urllib.error.HTTPError(url, 404, "missing", hdrs=None, fp=io.BytesIO())  # type: ignore[arg-type]
        return _Response(routes[url])

    return opener


def test_download_wheel_checks_the_pypi_digest(tmp_path: Path) -> None:
    blob = b"wheel-bytes"
    digest = hashlib.sha256(blob).hexdigest()
    filename = "steerable_agent_runtime_native-0.6.36-cp310-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
    meta = {
        "urls": [
            {
                "packagetype": "bdist_wheel",
                "filename": filename,
                "url": "https://files.example/wheel",
                "digests": {"sha256": digest},
            },
            {
                "packagetype": "sdist",
                "filename": "steerable_agent_runtime_native-0.6.36" + ".tar.gz",
                "url": "https://files.example/sdist",
                "digests": {"sha256": "abc"},
            },
        ]
    }
    routes = {
        fetch.pypi_json_url("0.6.36"): json.dumps(meta).encode(),
        "https://files.example/wheel": blob,
    }
    path = fetch.download_wheel("0.6.36", "manylinux-x64", tmp_path, opener=_opener(routes))
    assert path.name == filename
    assert path.read_bytes() == blob


def test_download_wheel_rejects_a_bad_digest(tmp_path: Path) -> None:
    filename = "steerable_agent_runtime_native-0.6.36-cp310-abi3-musllinux_1_2_x86_64.whl"
    meta = {
        "urls": [
            {
                "packagetype": "bdist_wheel",
                "filename": filename,
                "url": "https://files.example/wheel",
                "digests": {"sha256": "0" * 64},
            }
        ]
    }
    routes = {
        fetch.pypi_json_url("0.6.36"): json.dumps(meta).encode(),
        "https://files.example/wheel": b"tampered",
    }
    with pytest.raises(SystemExit, match="checksum mismatch"):
        fetch.download_wheel("0.6.36", "musllinux-x64", tmp_path, opener=_opener(routes))


def test_download_sidecar_rejects_a_missing_release(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="download failed \\(404\\)"):
        fetch.download_sidecar("0.6.36", "linux-x64", tmp_path, opener=_opener({}))


def test_download_sidecar_checks_manifest_sha256(tmp_path: Path) -> None:
    blob = b"sidecar-bytes"
    digest = hashlib.sha256(blob).hexdigest()
    filename = "steerable-sidecar-bin-0.6.36-linux-x64"
    manifest = {
        "version": "0.6.36",
        "kind": "rust-sidecar",
        "files": [
            {"target": "linux-x64", "name": filename, "sha256": digest, "bytes": len(blob)}
        ],
    }
    routes = {
        fetch.release_asset_url("0.6.36", fetch.manifest_name("0.6.36")): json.dumps(manifest).encode(),
        fetch.release_asset_url("0.6.36", filename): blob,
    }
    path = fetch.download_sidecar("0.6.36", "linux-x64", tmp_path, opener=_opener(routes))
    assert path.read_bytes() == blob
    assert (tmp_path / f"{filename}.sha256").read_text(encoding="utf-8").startswith(digest)


def test_lockstep_version_matches_the_native_pin() -> None:
    assert fetch.lockstep_version() == "0.6.36"
