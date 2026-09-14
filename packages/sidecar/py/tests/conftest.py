"""Fixtures for the sidecar's real-process (e2e) tests.

The shared machinery lives in ``e2e_harness.py`` (a plain module — pytest's
importlib mode makes intra-package relative imports fragile across this
monorepo's several ``tests`` packages, so this conftest puts the directory
on ``sys.path`` and test modules ``import e2e_harness`` directly).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import e2e_harness  # noqa: E402
from e2e_harness import MockOpenAI, SidecarClient  # noqa: E402  (re-exported for fixtures)


@pytest.fixture(autouse=True)
def _drop_gateway_listing() -> Any:
    """Uninstall any gateway listing a test left in the runtime resolver.

    ``models.list`` installs its listing into ``model_info``'s process-global
    resolution path on every successful refresh — that is the point of the
    call, not a test artifact. But the listing is matched ahead of the bundled
    catalog, so one leaked row silently rewrites another test's model: a fake
    ``claude-sonnet-4-6`` with no ``context_length`` shadowed the catalog's
    1M window with the legacy ``claude`` table's 200k, and only a later test
    in another package that read that window ever complained. Per-test
    cleanup belongs here rather than in each test that happens to refresh.
    """
    from steerable_agent_runtime.model_info import clear_gateway_models

    yield
    clear_gateway_models()


@pytest.fixture
def e2e_gate() -> None:
    """The environment gate every real-process e2e test passes through."""
    e2e_harness.check_e2e_gate()


@pytest.fixture
def mock_openai() -> Any:
    """Factory for MockOpenAI servers; every server is closed in teardown."""
    servers: list[MockOpenAI] = []

    def start(responder: e2e_harness.MockResponder) -> MockOpenAI:
        server = MockOpenAI(responder)
        servers.append(server)
        return server

    yield start
    for server in servers:
        server.close()


@pytest.fixture
async def sidecar_factory(tmp_path: Path) -> Any:
    """Factory for spawned sidecar clients; every client is closed in teardown."""
    clients: list[SidecarClient] = []

    async def spawn(
        argv: list[str] | None = None,
        *,
        env_overrides: dict[str, str | None] | None = None,
        wait_ready: bool = True,
    ) -> SidecarClient:
        client = await SidecarClient.spawn(
            argv
            if argv is not None
            else [sys.executable, "-m", "steerable_sidecar", "--log-level", "ERROR"],
            env=e2e_harness.child_env(tmp_path, env_overrides),
            wait_ready=wait_ready,
        )
        clients.append(client)
        return client

    yield spawn
    for client in clients:
        await client.aclose()
