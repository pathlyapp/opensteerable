"""Egress-ask chain: proxy 403 → host approval → control-endpoint relay →
web_fetch retry.

The asker is tested against a real loopback control endpoint (the proxy's
own server) with a stubbed approval channel, and web_fetch's retry goes
through ``httpx.MockTransport`` — no test touches the real network.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import ToolRouter


async def _call(router: ToolRouter, name: str, arguments: dict) -> Any:
    return await router.dispatch(
        ToolCall(id="t", name=name, arguments=arguments), consent_granted=True
    )

from steerable_sidecar.egress_ask import (
    EgressApprovalAsker,
    asker_from_environ,
    parse_egress_denied,
)
from steerable_sidecar.web_tools import register_web_tools


class TestParseEgressDenied:
    def test_parses_proxy_reason(self) -> None:
        exc = httpx.ProxyError(
            "403 Forbidden; egress denied for api.example.com:443"
        )
        assert parse_egress_denied(exc) == ("api.example.com", 443)

    def test_plain_403_without_marker_is_not_egress(self) -> None:
        assert parse_egress_denied(httpx.ProxyError("403 Forbidden")) is None

    def test_unrelated_error_is_none(self) -> None:
        assert parse_egress_denied(ValueError("boom")) is None


class _StubServer:
    """Stands in for JsonRpcServer: records approval payloads, replies with
    a scripted decision kind."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.calls: list[dict[str, Any]] = []

    async def call(self, method: str, params: dict[str, Any], **kwargs: Any) -> Any:
        self.calls.append({"method": method, "params": params})
        return {"kind": self.kind, "reason": "test"}


async def _start_control_plane() -> tuple[Any, asyncio.Task, int, Any]:
    from steerable_egress_proxy import AllowList, EgressProxyServer, ProxyConfig

    server = EgressProxyServer(
        ProxyConfig(
            allow=AllowList(["api.github.com"]),
            bind_host="127.0.0.1",
            bind_port=0,
            control_token="tok-test",
            control_port=0,
        )
    )
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.bound_control_port is not None:
            break
        await asyncio.sleep(0.01)
    return server, task, server.bound_control_port or 0, server.config.allow


class TestAsker:
    @pytest.mark.asyncio
    async def test_allow_relays_to_the_control_endpoint(self) -> None:
        proxy, task, control_port, allow = await _start_control_plane()
        try:
            stub = _StubServer("allow_for_session")
            asker = EgressApprovalAsker(
                stub, control_port=control_port, control_token="tok-test"  # type: ignore[arg-type]
            )
            assert await asker.ask_and_allow("example.com", 443, "https://example.com/") is True
            assert allow.allows("example.com", 443)
            # The prompt names the target and carries the egress category.
            params = stub.calls[0]["params"]
            assert params["category"] == "network_egress"
            assert params["arguments"]["host"] == "example.com"
            assert params["arguments"]["port"] == 443
        finally:
            await proxy.close()
            task.cancel()

    @pytest.mark.asyncio
    async def test_relay_ignores_proxy_environment(self, monkeypatch) -> None:
        """The grant must reach the loopback control port even while the
        environment declares a proxy for plain http.

        Broker mode is exactly this environment: it points ``HTTP_PROXY`` at
        the egress proxy and sets no ``NO_PROXY``, so a client that trusts the
        environment posts the grant through the proxy — which denies its own
        control port for want of an allow-list entry, failing every approval
        closed just after the user allowed it. An ambient system proxy does the
        same to an unconfined sidecar. The stand-in below answers like both.
        """
        captured: list[bytes] = []

        async def refuse_everything(reader: asyncio.StreamReader, writer) -> None:
            captured.append(await reader.readuntil(b"\r\n"))
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
            await writer.drain()
            writer.close()

        interceptor = await asyncio.start_server(refuse_everything, "127.0.0.1", 0)
        interceptor_port = interceptor.sockets[0].getsockname()[1]
        for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, f"http://127.0.0.1:{interceptor_port}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)

        proxy, task, control_port, allow = await _start_control_plane()
        try:
            stub = _StubServer("allow_for_session")
            asker = EgressApprovalAsker(
                stub, control_port=control_port, control_token="tok-test"  # type: ignore[arg-type]
            )
            assert await asker.ask_and_allow("example.com", 443, "https://example.com/") is True
            assert allow.allows("example.com", 443)
            assert captured == []  # the declared proxy was never dialed
        finally:
            await proxy.close()
            task.cancel()
            interceptor.close()
            await interceptor.wait_closed()

    @pytest.mark.asyncio
    async def test_denial_is_cached_for_the_session(self) -> None:
        proxy, task, control_port, allow = await _start_control_plane()
        try:
            stub = _StubServer("deny_for_session")
            asker = EgressApprovalAsker(
                stub, control_port=control_port, control_token="tok-test"  # type: ignore[arg-type]
            )
            assert await asker.ask_and_allow("example.com", 443, "https://example.com/") is False
            assert await asker.ask_and_allow("example.com", 443, "https://example.com/") is False
            assert len(stub.calls) == 1  # second denial never re-prompts
            assert not allow.allows("example.com", 443)
        finally:
            await proxy.close()
            task.cancel()

    @pytest.mark.asyncio
    async def test_unreachable_host_channel_fails_closed(self) -> None:
        class _DeadServer:
            async def call(self, *args: Any, **kwargs: Any) -> Any:
                raise ConnectionError("host gone")

        asker = EgressApprovalAsker(
            _DeadServer(), control_port=1, control_token="t"  # type: ignore[arg-type]
        )
        assert await asker.ask_and_allow("example.com", 443, "https://x/") is False

    @pytest.mark.asyncio
    async def test_unreachable_control_endpoint_fails_closed(self) -> None:
        stub = _StubServer("allow_once")
        asker = EgressApprovalAsker(
            stub, control_port=1, control_token="t"  # type: ignore[arg-type]
        )
        assert await asker.ask_and_allow("example.com", 443, "https://x/") is False


class TestAskerFromEnviron:
    def test_both_vars_build_an_asker(self) -> None:
        asker = asker_from_environ(
            _StubServer("deny_once"),  # type: ignore[arg-type]
            {"STEERABLE_EGRESS_CONTROL_PORT": "8899", "STEERABLE_EGRESS_CONTROL_TOKEN": "t"},
        )
        assert isinstance(asker, EgressApprovalAsker)

    def test_missing_vars_mean_no_asker(self) -> None:
        assert asker_from_environ(_StubServer("deny_once"), {}) is None  # type: ignore[arg-type]
        assert (
            asker_from_environ(
                _StubServer("deny_once"),  # type: ignore[arg-type]
                {"STEERABLE_EGRESS_CONTROL_PORT": "8899"},
            )
            is None
        )

    def test_invalid_port_means_no_asker(self) -> None:
        assert (
            asker_from_environ(
                _StubServer("deny_once"),  # type: ignore[arg-type]
                {"STEERABLE_EGRESS_CONTROL_PORT": "abc", "STEERABLE_EGRESS_CONTROL_TOKEN": "t"},
            )
            is None
        )


class _ScriptedAsker:
    def __init__(self, grants: bool) -> None:
        self.grants = grants
        self.asked: list[tuple[str, int, str]] = []

    async def ask_and_allow(self, host: str, port: int, url: str) -> bool:
        self.asked.append((host, port, url))
        return self.grants


class TestWebFetchRetry:
    def _router_with_fetch(self, outcomes: list[Any], asker: Any) -> ToolRouter:
        """First request raises the scripted outcome (proxy 403), the retry
        serves the page — mirroring the proxy before/after the grant."""
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            outcome = outcomes[min(calls["n"] - 1, len(outcomes) - 1)]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        transport = httpx.MockTransport(handler)

        def client_factory(timeout: httpx.Timeout) -> httpx.AsyncClient:
            return httpx.AsyncClient(transport=transport, timeout=timeout)

        async def fake_resolve(host: str, port: int) -> list[str]:
            return ["93.184.216.34"]  # a public literal — DNS policy passes

        router = ToolRouter()
        register_web_tools(
            router,
            client_factory=client_factory,
            resolve_host=fake_resolve,
            egress_asker=asker,
            environ={},
        )
        return router

    @pytest.mark.asyncio
    async def test_denied_then_allowed_retries_and_succeeds(self) -> None:
        router = self._router_with_fetch(
            [
                httpx.ProxyError("403 Forbidden; egress denied for example.com:443"),
                httpx.Response(200, text="hello world"),
            ],
            _ScriptedAsker(grants=True),
        )
        result = await _call(router, "web_fetch", {"url": "https://example.com/"})
        assert result.success is True
        assert "hello world" in (result.data or {}).get("content", "")

    @pytest.mark.asyncio
    async def test_denied_and_refused_returns_the_error(self) -> None:
        router = self._router_with_fetch(
            [httpx.ProxyError("403 Forbidden; egress denied for example.com:443")],
            _ScriptedAsker(grants=False),
        )
        result = await _call(router, "web_fetch", {"url": "https://example.com/"})
        assert result.success is False
        assert "403 Forbidden" in (result.error or "")

    @pytest.mark.asyncio
    async def test_no_asker_keeps_the_dead_end(self) -> None:
        router = self._router_with_fetch(
            [httpx.ProxyError("403 Forbidden; egress denied for example.com:443")],
            None,
        )
        result = await _call(router, "web_fetch", {"url": "https://example.com/"})
        assert result.success is False
        assert "403 Forbidden" in (result.error or "")
