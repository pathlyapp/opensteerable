"""Engine compatibility metadata stays aligned across public surfaces."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/check_engine_compatibility.py"
SPEC = importlib.util.spec_from_file_location("check_engine_compatibility", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FILES = (
    "rust-artifacts.lock.json",
    "docs/spec/runtime-contract.json",
    "packages/agent-runtime/py/src/steerable_agent_runtime/native_bridge.py",
    "packages/sidecar/py/src/steerable_sidecar/sidecar.py",
)


def _fixture(tmp_path: Path) -> Path:
    for relative in FILES:
        source = ROOT / relative
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    return tmp_path


def test_current_engine_contract_matches_pinned_artifacts(tmp_path: Path) -> None:
    root = _fixture(tmp_path)
    assert MODULE.check(root) == []


def test_contract_drift_is_rejected(tmp_path: Path) -> None:
    root = _fixture(tmp_path)
    contract_path = root / "docs/spec/runtime-contract.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    contract["compatibility"]["coreloopApi"] += 1
    contract_path.write_text(json.dumps(contract), encoding="utf-8")

    assert MODULE.check(root) == [
        "docs/spec/runtime-contract.json compatibility must exactly match "
        "rust-artifacts.lock.json"
    ]
