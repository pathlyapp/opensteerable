from __future__ import annotations

import base64
import socket
import struct
import threading
from pathlib import Path

import pytest

from steerable_agent_protocol.generated import ToolCall
from steerable_sidecar.display import (
    DisplayError,
    capture_rfb,
    parse_display_target,
)
from steerable_sidecar.png_ascii import ascii_png_preview, encode_png_rgb
from steerable_sidecar.workspace_tools import workspace_tools_for_cwd


async def _call(router, name: str, arguments: dict) -> object:
    return await router.dispatch(
        ToolCall(id="t", name=name, arguments=arguments),
        consent_granted=True,
    )


def test_parse_display_target_vnc_conventions() -> None:
    assert parse_display_target(":1").port == 5901
    assert parse_display_target("1").port == 5901
    assert parse_display_target("vnc://localhost:1").canonical == "vnc://localhost:5901"
    assert parse_display_target("127.0.0.1:5901").port == 5901
    assert parse_display_target("vnc://[::1]:5901").host == "::1"
    assert parse_display_target("5901").canonical == "vnc://127.0.0.1:5901"


def test_parse_display_target_rejects_other_schemes() -> None:
    with pytest.raises(ValueError, match="unsupported display protocol"):
        parse_display_target("http://127.0.0.1:5901")
    with pytest.raises(ValueError, match="credentials"):
        parse_display_target("vnc://user:secret@127.0.0.1:5901")
    with pytest.raises(ValueError, match="empty"):
        parse_display_target("  ")


def test_encode_png_rgb_roundtrips_ascii_preview() -> None:
    rgb = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])
    png = encode_png_rgb(2, 2, rgb)
    preview = ascii_png_preview(png)
    assert preview is not None
    assert preview.startswith("PNG 2x2")


class _RfbServer(threading.Thread):
    def __init__(self, *, security_none: bool = True, pixels: bytes | None = None) -> None:
        super().__init__(daemon=True)
        self.security_none = security_none
        self.pixels = pixels or (
            b"\x00\x00\xff\x00"
            b"\x00\xff\x00\x00"
            b"\xff\x00\x00\x00"
            b"\xff\xff\xff\x00"
        )
        self.events: list[int] = []
        self.ready = threading.Event()
        self.error: BaseException | None = None
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self.port = self._sock.getsockname()[1]
        self._sock.listen(1)
        self._sock.settimeout(2)

    def run(self) -> None:
        self.ready.set()
        try:
            conn, _ = self._sock.accept()
            with conn:
                conn.settimeout(2)
                conn.sendall(b"RFB 003.008\n")
                assert _recv_n(conn, 12) == b"RFB 003.008\n"
                if self.security_none:
                    conn.sendall(bytes([1, 1]))
                    assert _recv_n(conn, 1) == b"\x01"
                    conn.sendall(struct.pack(">I", 0))
                else:
                    conn.sendall(bytes([1, 2]))
                    return
                assert _recv_n(conn, 1) == b"\x01"
                pf = struct.pack(
                    ">BBBBHHHBBB3s",
                    32,
                    24,
                    0,
                    1,
                    255,
                    255,
                    255,
                    16,
                    8,
                    0,
                    b"\x00\x00\x00",
                )
                name = b"test"
                conn.sendall(struct.pack(">HH", 2, 2) + pf + struct.pack(">I", len(name)) + name)
                saw_request = False
                while not saw_request:
                    kind = _recv_n(conn, 1)
                    code = kind[0]
                    self.events.append(code)
                    if code == 2:
                        _recv_n(conn, 1)
                        count = struct.unpack(">H", _recv_n(conn, 2))[0]
                        _recv_n(conn, 4 * count)
                    elif code == 3:
                        _recv_n(conn, 9)
                        saw_request = True
                    elif code == 5:
                        _recv_n(conn, 5)
                    elif code == 0:
                        _recv_n(conn, 19)
                    else:
                        raise AssertionError(f"unexpected client message {code}")
                conn.sendall(
                    struct.pack(">BBH", 0, 0, 1)
                    + struct.pack(">HHHHi", 0, 0, 2, 2, 0)
                    + self.pixels
                )
        except BaseException as exc:
            self.error = exc
        finally:
            self._sock.close()


def _recv_n(conn: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("client closed")
        buf.extend(chunk)
    return bytes(buf)


def test_capture_rfb_reads_client_framebuffer() -> None:
    server = _RfbServer()
    server.start()
    assert server.ready.wait(1)
    frame = capture_rfb("127.0.0.1", server.port, timeout_sec=2)
    server.join(2)
    assert server.error is None
    assert frame.width == 2
    assert frame.height == 2
    assert frame.rgb[:3] == bytes([255, 0, 0])
    assert frame.rgb[3:6] == bytes([0, 255, 0])
    assert frame.rgb[6:9] == bytes([0, 0, 255])
    assert frame.rgb[9:] == bytes([255, 255, 255])


def test_capture_rfb_nudge_sends_pointer_events() -> None:
    server = _RfbServer()
    server.start()
    assert server.ready.wait(1)
    capture_rfb("127.0.0.1", server.port, nudge=True, timeout_sec=2)
    server.join(2)
    assert server.error is None
    assert server.events.count(5) == 2


def test_capture_rfb_rejects_authenticated_server() -> None:
    server = _RfbServer(security_none=False)
    server.start()
    assert server.ready.wait(1)
    with pytest.raises(DisplayError, match="authentication"):
        capture_rfb("127.0.0.1", server.port, timeout_sec=2)
    server.join(2)


@pytest.mark.asyncio
async def test_capture_display_tool_writes_png(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("STEERABLE_READ_IMAGES", raising=False)
    server = _RfbServer()
    server.start()
    assert server.ready.wait(1)
    router = workspace_tools_for_cwd(tmp_path)
    names = {
        t.get("name") or t.get("function", {}).get("name")
        for t in router.describe_model()
    }
    assert "capture_display" in names
    result = await _call(
        router,
        "capture_display",
        {
            "target": f"vnc://127.0.0.1:{server.port}",
            "path": "desk.png",
        },
    )
    server.join(2)
    assert result.success is True
    assert result.data["protocol"] == "vnc"
    assert result.data["width"] == 2
    png = (tmp_path / "desk.png").read_bytes()
    assert png.startswith(b"\x89PNG")
    assert result.data["content"].startswith("PNG 2x2")
    blob = result.data["_image"]
    assert blob["media_type"] == "image/png"
    assert base64.b64decode(blob["b64"]) == png


@pytest.mark.asyncio
async def test_capture_display_missing_server_is_followup(tmp_path: Path) -> None:
    router = workspace_tools_for_cwd(tmp_path)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    result = await _call(router, "capture_display", {"target": f":{port}"})
    assert result.success is False
    assert result.needsFollowup is True
    assert "no RFB server" in result.error
