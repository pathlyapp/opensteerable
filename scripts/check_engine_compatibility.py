#!/usr/bin/env python3
"""Check that the public engine contract matches its pinned Rust bundle."""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def _constant(path: Path, name: str) -> Any:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id == name:
            return ast.literal_eval(node.value)
    raise ValueError(f"{path.relative_to(ROOT)} does not define {name}")


def check(root: Path = ROOT) -> list[str]:
    lock = json.loads((root / "rust-artifacts.lock.json").read_text(encoding="utf-8"))
    contract = json.loads(
        (root / "docs/spec/runtime-contract.json").read_text(encoding="utf-8")
    )
    locked = lock.get("compatibility")
    documented = contract.get("compatibility")
    problems: list[str] = []
    if documented != locked:
        problems.append(
            "docs/spec/runtime-contract.json compatibility must exactly match "
            "rust-artifacts.lock.json"
        )
        return problems

    coreloop_api = _constant(
        root
        / "packages/agent-runtime/py/src/steerable_agent_runtime/native_bridge.py",
        "_CORELOOP_API_VERSION",
    )
    if documented.get("coreloopApi") != coreloop_api:
        problems.append(
            "runtime contract coreloopApi does not match "
            "steerable_agent_runtime.native_bridge"
        )

    sidecar_protocol = _constant(
        root / "packages/sidecar/py/src/steerable_sidecar/sidecar.py",
        "PROTOCOL_VERSION",
    )
    if documented.get("sidecarProtocol") != sidecar_protocol:
        problems.append(
            "runtime contract sidecarProtocol does not match "
            "steerable_sidecar.sidecar"
        )
    return problems


def main() -> int:
    problems = check()
    if problems:
        print("\n".join(f"ERROR: {problem}" for problem in problems), file=sys.stderr)
        return 1
    compatibility = json.loads(
        (ROOT / "rust-artifacts.lock.json").read_text(encoding="utf-8")
    )["compatibility"]
    print(
        "OK: engine compatibility "
        f"CoreLoop API {compatibility['coreloopApi']}, "
        f"sidecar protocol {compatibility['sidecarProtocol']}, "
        f"egress CLI {compatibility['egressCli']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
