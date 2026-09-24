#!/usr/bin/env python3
"""Reject known customer, credential, PII, and internal-doc exposure."""

from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def joined(*parts: str) -> str:
    return "".join(parts)


BANNED_LITERALS = (
    joined("sk-", "b1383d225ee44f118ad99e359ec9e5d8"),
    joined("/Users/", "wangtai"),
    joined("C:\\Users\\", "wangtai"),
    joined("pathlyapp/", "steerable-framework"),
    joined("github.com/deeppath/", "steerable-framework"),
    joined("proj/", "yizhuang-agent"),
    joined("时", "踪"),
    joined("亦", "庄"),
    joined("测", "井"),
    joined("CIF", "Log"),
    joined("cif", "log"),
    joined("cf", "log"),
    joined("Modu", "Flow"),
    joined("modu", "flow"),
    joined("e", "town"),
    joined("a", "roli"),
)
BANNED_ROOT_DOCS = {
    "ALIGN_TODO.md",
    "CORELOOP_TODO.md",
    "EVALS_TODO.md",
    "HARNESS_TODO.md",
    "PARITY_TODO.md",
    "TODO.md",
}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")


def tracked_files() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=ROOT, text=False
    )
    return [item.decode() for item in output.split(b"\0") if item]


def main() -> int:
    failures: list[str] = []
    for relative in tracked_files():
        path = Path(relative)
        full = ROOT / relative
        if not full.is_file():
            continue
        if relative in BANNED_ROOT_DOCS:
            failures.append(f"{relative}: internal planning document is public")
        if relative.startswith("evals/notes/") or relative.startswith("docs/migration/"):
            failures.append(f"{relative}: internal forensic/migration document is public")
        if path.name.startswith(".env") and path.name != ".env.example":
            failures.append(f"{relative}: environment file is tracked")
        if path.suffix.lower() in SENSITIVE_SUFFIXES:
            failures.append(f"{relative}: credential-shaped file is tracked")
        try:
            text = full.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for literal in BANNED_LITERALS:
            if literal in text:
                failures.append(f"{relative}: contains banned public literal {literal!r}")
        if relative == "wrangler.jsonc" and '"account_id"' in text:
            failures.append(f"{relative}: Cloudflare account_id must come from secrets")

    if failures:
        print("public exposure gate failed:")
        for failure in failures:
            print(f"  {failure}")
        return 1
    print("OK: public tree contains no known customer, credential, PII, or internal-doc exposure")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
