#!/usr/bin/env python3
"""Fail when the public tree and the private tree disagree on shared files.

The public checkout is the source for every file both trees contain. Only
the allow-listed private-only and public-only files may exist on one side,
and only KNOWN_DIVERGENCE paths may differ; an entry that stops differing
must be removed. Run the copy inside either checkout and pass the other:

    python3 scripts/check_public_private_sync.py /path/to/the/other/checkout
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def _join(*parts: str) -> str:
    return "".join(parts)


PRIVATE_ONLY_PREFIXES = (
    _join("packages/", "agent-runtime/rs/"),
    _join("packages/", "sidecar/rs/"),
    _join("packages/", "egress-proxy/"),
)
PRIVATE_ONLY_FILES = {
    ".github/workflows/publish-rust-artifacts.yml",
    ".github/workflows/publish-sidecar.yml",
    ".github/workflows/publish-github-packages.yml",
    "evals/tests/test_package_rust_sidecar.py",
    "rust-artifacts.toml",
    "scripts/check_rust_artifact_versions.py",
    "scripts/publish_github_packages.mjs",
    "scripts/release/assemble_rust_bundle.py",
    "scripts/release/bump_rust_artifacts.py",
    "scripts/release/package_rust_sidecar.py",
}
PUBLIC_ONLY_FILES = {
    "evals/tests/test_fetch_verified_artifacts.py",
    "evals/tests/test_no_public_coreloop_source.py",
    "scripts/check_no_public_coreloop_source.py",
    "scripts/fetch_verified_artifacts.py",
    "scripts/use_rust_artifacts.py",
    "rust-artifacts.lock.json",
    "wrangler.jsonc",
}
# Shared paths that are still forked on purpose: the private tree keeps the
# Rust build, and the public tree keeps the binary-consumer side of the same
# files. A path not listed here must be byte-identical.
KNOWN_DIVERGENCE = {
    ".cursor/agents/rust-python-parity-auditor.md",
    ".github/actions/setup-harbor/action.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/docs.yml",
    ".github/workflows/evals-arms.yml",
    ".github/workflows/evals-oracle.yml",
    ".github/workflows/evals-weekly.yml",
    ".github/workflows/publish-native.yml",
    ".github/workflows/publish-npm.yml",
    ".github/workflows/publish-pypi.yml",
    ".github/workflows/release-prepare.yml",
    ".github/workflows/release-tag.yml",
    ".github/workflows/release.yml",
    ".github/workflows/sidecar-build.yml",
    ".github/workflows/sidecar-codesign.yml",
    "BRAND.py",
    "BRAND.ts",
    "INTEGRATION-TESTING.md",
    "NOTICE",
    "PARITY_TODO.md",
    "README.md",
    "RELEASING.md",
    "docs/comparison.md",
    "docs/evals.md",
    "docs/index.md",
    "docs/spec/architecture.md",
    "docs/spec/core-loop.md",
    "docs/spec/coreloop-rust-test-catalog.json",
    "docs/spec/coreloop-rust-test-catalog.md",
    "docs/spec/safety.md",
    "evals/README.md",
    "evals/tests/test_eval_workflows.py",
    "evals/tests/test_release_native.py",
    "evals/tests/test_suite.py",
    "mkdocs.yml",
    "packages/agent-harness/py/pyproject.toml",
    "packages/agent-harness/ts/package.json",
    "packages/agent-protocol/ts/package.json",
    "packages/agent-runtime/py/pyproject.toml",
    "packages/agent-runtime/py/src/steerable_agent_runtime/loop.py",
    "packages/agent-runtime/py/src/steerable_agent_runtime/native_bridge.py",
    "packages/agent-runtime/py/tests/test_loop.py",
    "packages/agent-runtime/py/tests/test_pyo3_api_surface.py",
    "packages/agent-runtime/ts/package.json",
    "packages/agent-runtime/ts/src/runtime.ts",
    "packages/agent-runtime/ts/test/e2e-real-sidecar.test.ts",
    "packages/agent-shell/ts/package.json",
    "packages/agent-shell/ts/src/local-backend/coreloop-stream.ts",
    "packages/agent-shell/ts/src/sidecar/types.ts",
    "packages/agent-shell/web/package.json",
    "packages/agent-ui/ts/package.json",
    "packages/pack-sdk/ts/package.json",
    "packages/sidecar/build/build_sidecar.py",
    "packages/sidecar/build/tests/test_prune.py",
    "pyproject.toml",
    "scripts/check_lockstep_versions.py",
    "scripts/release/build-local-artifacts.sh",
    "scripts/release/bump_to.sh",
    "uv.lock",
}


def git_files(root: Path) -> set[str]:
    out = subprocess.check_output(
        ["git", "ls-files", "-z"],
        cwd=root,
        text=False,
    )
    return {item.decode() for item in out.split(b"\0") if item}


def allowed_private(path: str) -> bool:
    return path in PRIVATE_ONLY_FILES or path.startswith(PRIVATE_ONLY_PREFIXES)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <other-checkout>")
    here = Path(__file__).resolve().parents[1]
    other = Path(sys.argv[1]).resolve()
    if here == other:
        raise SystemExit(f"{other} is this checkout; pass the other repository")
    # The public tree is the one that carries the source gate.
    if (here / "scripts" / "check_no_public_coreloop_source.py").is_file():
        public, private = here, other
    else:
        public, private = other, here
    public_files = git_files(public)
    private_files = git_files(private)
    problems: list[str] = []
    for path in sorted(public_files & private_files):
        left = (public / path).read_bytes()
        right = (private / path).read_bytes()
        if left != right and path not in KNOWN_DIVERGENCE:
            problems.append(f"differs: {path}")
        elif left == right and path in KNOWN_DIVERGENCE:
            problems.append(f"stale divergence entry (files now match): {path}")
    for path in sorted(KNOWN_DIVERGENCE - (public_files & private_files)):
        problems.append(f"stale divergence entry (not shared): {path}")
    for path in sorted(private_files - public_files):
        if not allowed_private(path):
            problems.append(f"private-only: {path}")
    for path in sorted(public_files - private_files):
        if path not in PUBLIC_ONLY_FILES:
            problems.append(f"public-only: {path}")
    if problems:
        print("\n".join(problems))
        raise SystemExit(f"{len(problems)} public/private sync problems")
    print(
        f"OK: {len(public_files & private_files)} shared files match; "
        f"private-only {len(private_files - public_files)}; "
        f"public-only {len(public_files - private_files)}"
    )


if __name__ == "__main__":
    main()
