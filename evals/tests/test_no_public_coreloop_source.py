"""The public tree must not regain CoreLoop or Rust sidecar source."""

from __future__ import annotations

from pathlib import Path

from scripts.check_no_public_coreloop_source import scan


def test_public_tree_has_no_coreloop_source() -> None:
    assert scan() == []


def test_source_directory_is_rejected(tmp_path: Path) -> None:
    (tmp_path / "packages" / "agent-runtime" / "rs").mkdir(parents=True)
    findings = scan(tmp_path)
    assert any("source directory" in item for item in findings)


def test_coreloop_build_text_is_rejected(tmp_path: Path) -> None:
    workflow = tmp_path / ".github" / "workflows"
    workflow.mkdir(parents=True)
    (workflow / "build.yml").write_text(
        "uses: " + "PyO3/" + "maturin-action@v1\n",
        encoding="utf-8",
    )
    findings = scan(tmp_path)
    assert any("maturin-action" in item for item in findings)
