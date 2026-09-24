"""Gateway catalog with and without the confining egress proxy.

A settings screen's "test this endpoint" button reports whatever
``fetch_gateway_models`` raises, so an egress denial has to stay
distinguishable from a network failure in that one string: the two have
different remedies (put the host on the proxy's list vs. fix connectivity),
and whoever reads the message is usually a support engineer with no access
to the machine. The unconfined case is here too, because the host can turn
the proxy off (``STEERABLE_EGRESS_PROXY=0``) or fall back to port-level on
its own, and the fetch must then behave as if no proxy existed.

No test reaches the network. The denied host is refused before the proxy
dials, so its name never meets a resolver; every other target is a literal
loopback address.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from steerable_agent_runtime.gateway_catalog import (
    GatewayCatalogError,
    clear_gateway_cache,
    fetch_gateway_models,
)
from egress_bin import start_egress_proxy

#: Never resolved: the proxy refuses this target before dialing it.
DENIED_HOST = "denied.example"

#: Proxy variables a developer's shell or CI runner may carry. Cleared in the
#: unconfined test so its verdict comes from the code under test rather than
#: from the machine it ran on.
PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


@pytest.fixture
async def confining_proxy(monkeypatch):
    """A running proxy that the fetch is confined to, desktop-style.

    ``STEERABLE_EGRESS_CONFINED`` is what makes the proxy own every host:
    without it ``client_env_kwargs`` pins the platform's own direct hosts —
    loopback among them — past the proxy, which is the opposite of the
    posture under test.
    """
    proxy = start_egress_proxy(["allowed.example"])
    monkeypatch.setenv("HTTPS_PROXY", f"http://127.0.0.1:{proxy.port}")
    monkeypatch.setenv("STEERABLE_EGRESS_CONFINED", "1")
    clear_gateway_cache()
    try:
        yield proxy
    finally:
        proxy.stop()
        clear_gateway_cache()


async def test_denied_host_names_the_denial_and_the_target(confining_proxy) -> None:
    with pytest.raises(GatewayCatalogError) as excinfo:
        await fetch_gateway_models(f"https://{DENIED_HOST}/v1", "sk-test")
    # The reason phrase is the only channel a CONNECT client gets, and it
    # must survive into the product-visible error whole: the exception type,
    # the refusal, and the exact host:port to put on the list.
    assert excinfo.value.reason == (
        f"ProxyError: 403 Forbidden; egress denied for {DENIED_HOST}:443"
    )
    assert excinfo.value.base_url == f"https://{DENIED_HOST}/v1"


async def test_allowed_host_is_never_reported_as_an_egress_denial(
    confining_proxy,
) -> None:
    # A loopback listener that accepts and hangs up: the CONNECT succeeds, so
    # the failure comes from the tunnel (no TLS behind it), not the list. This
    # is the case an operator must not read as "add the host to the list".
    async def hang_up(_reader, writer) -> None:
        writer.close()

    upstream = await asyncio.start_server(hang_up, "127.0.0.1", 0)
    port = upstream.sockets[0].getsockname()[1]
    async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
        granted = await client.post(
            f"http://127.0.0.1:{confining_proxy.control_port}/allow",
            headers={"Authorization": "Bearer tok-test"},
            json={"host": f"127.0.0.1:{port}"},
        )
    assert granted.status_code == 200
    try:
        with pytest.raises(GatewayCatalogError) as excinfo:
            await fetch_gateway_models(f"https://127.0.0.1:{port}/v1", "sk-test")
        reason = excinfo.value.reason
        assert "egress denied" not in reason
        # Not a ProxyError either: the proxy consented, so nothing about this
        # failure should point an operator at the allow-list. Which transport
        # error httpx raises for a tunnel that dies mid-handshake varies by
        # platform (``ConnectError`` here), so only the non-empty part is
        # pinned — empty is the bug this guards, since httpx reports every
        # response-less failure by type alone.
        assert not reason.startswith("ProxyError")
        assert reason
    finally:
        upstream.close()
        await upstream.wait_closed()


async def test_unconfined_fetch_reaches_the_gateway_directly(monkeypatch) -> None:
    """Proxy off — ``STEERABLE_EGRESS_PROXY=0``, the ambient-proxy fallback, or
    a failed start: no proxy variables and no confinement marker reach the
    sidecar, and the listing must be fetched directly.

    The complement of the two cases above, and the one a local runtime
    (Ollama, vLLM) always takes.
    """
    for name in PROXY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("STEERABLE_EGRESS_CONFINED", raising=False)
    clear_gateway_cache()

    listing_body = json.dumps({"data": [{"id": "gw-model-a"}, {"id": "gw-model-b"}]})

    async def serve_listing(reader: asyncio.StreamReader, writer) -> None:
        await reader.readuntil(b"\r\n\r\n")
        writer.write(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
            + f"content-length: {len(listing_body)}\r\n\r\n{listing_body}".encode()
        )
        await writer.drain()
        writer.close()

    gateway = await asyncio.start_server(serve_listing, "127.0.0.1", 0)
    gateway_port = gateway.sockets[0].getsockname()[1]
    try:
        listing = await fetch_gateway_models(f"http://127.0.0.1:{gateway_port}/v1")
        assert [entry.id for entry in listing.entries] == ["gw-model-a", "gw-model-b"]
        assert listing.stale is False
    finally:
        gateway.close()
        await gateway.wait_closed()
        clear_gateway_cache()
