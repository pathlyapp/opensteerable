"""Release tooling consumes the private CoreLoop wheel and does not build it."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUMP = (ROOT / "scripts" / "release" / "bump_to.sh").read_text(encoding="utf-8")
RELEASE = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
PUBLISH_NATIVE = (
    ROOT / ".github" / "workflows" / "publish-native.yml"
).read_text(encoding="utf-8")
LOCKSTEP = (ROOT / "scripts" / "check_lockstep_versions.py").read_text(
    encoding="utf-8"
)


def test_framework_lockstep_validates_the_independent_native_pin() -> None:
    assert "steerable-agent-runtime-native" in LOCKSTEP
    assert "packages/agent-runtime/py/pyproject.toml" in LOCKSTEP
    assert "steerable-egress-proxy" not in LOCKSTEP
    assert "NATIVE_PIN_FILES" in LOCKSTEP
    assert "rust-artifacts.lock.json" in LOCKSTEP
    assert 'versions[NATIVE_PACKAGE]' not in LOCKSTEP


def test_framework_bump_leaves_the_private_artifact_pin_unchanged() -> None:
    assert "steerable-agent-runtime-native" not in BUMP
    assert "egress-proxy" not in BUMP


def test_release_verifies_published_native_wheels() -> None:
    assert "uses: ./.github/workflows/publish-native.yml" in RELEASE
    assert "needs: [validate, publish-native]" in RELEASE
    assert "fetch_verified_artifacts.py verify-wheels --artifact-lock" in PUBLISH_NATIVE
    assert "pathlyapp/opensteerable" in PUBLISH_NATIVE
    pypi = (ROOT / ".github" / "workflows" / "publish-pypi.yml").read_text(
        encoding="utf-8"
    )
    assert "steerable_agent_runtime_native" in pypi
    assert "rm -f dist/py/steerable_agent_runtime_native*" in pypi
