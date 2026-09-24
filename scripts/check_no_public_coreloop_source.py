#!/usr/bin/env python3
"""Fail when this public tree still contains CoreLoop or Rust sidecar source.

The check looks for the deleted source directories and for CI or script
text that would build them. Forbidden text is assembled at runtime so this
file does not contain those strings itself.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def _join(*parts: str) -> str:
    return "".join(parts)


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = (
    Path(_join("packages/", "agent-runtime/rs")),
    Path(_join("packages/", "sidecar/rs")),
    Path(_join("packages/", "egress-proxy")),
)
SKIP_PARTS = {
    ".git",
    ".venv",
    ".venv-docs",
    "site",
    "node_modules",
    "dist",
    "target",
    "__pycache__",
}
NATIVE_SDIST = re.compile(
    _join("steerable_agent_runtime_native-", r"[^\s\"']*\.tar\.gz")
)
TEXT_SUFFIXES = {
    ".py",
    ".toml",
    ".yml",
    ".yaml",
    ".md",
    ".sh",
    ".json",
    ".lock",
    ".mjs",
    ".ts",
}
FORBIDDEN_SNIPPETS = (
    _join("packages/", "agent-runtime/rs"),
    _join("packages/", "sidecar/rs"),
    _join("packages/", "egress-proxy"),
    _join("PyO3/", "maturin-action"),
    _join("maturin ", "build"),
    _join("maturin ", "develop"),
    _join("command: ", "sdist"),
)


def scan(root: Path = ROOT) -> list[str]:
    """Return human-readable findings under ``root``."""
    findings: list[str] = []
    for relative in SOURCE_DIRS:
        if (root / relative).exists():
            findings.append(f"source directory present: {relative.as_posix()}")
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if SKIP_PARTS.intersection(path.parts):
            continue
        relative = path.relative_to(root)
        if relative.suffix not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeError:
            continue
        for snippet in FORBIDDEN_SNIPPETS:
            if snippet in text:
                findings.append(f"{relative.as_posix()}: contains {snippet}")
        if NATIVE_SDIST.search(text):
            findings.append(f"{relative.as_posix()}: references a native sdist")
    return findings


def main() -> int:
    findings = scan()
    if findings:
        print("public CoreLoop source gate failed:", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print("OK: public tree has no CoreLoop, Rust sidecar, or egress proxy source")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
