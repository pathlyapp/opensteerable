"""Capture a remote-display client framebuffer.

``capture_display`` talks the protocol a user or grader sees (RFB/VNC),
not a hypervisor-private screenshot. A QEMU ``screendump`` and a VNC
frame can diverge when the client framebuffer goes stale.
"""

from __future__ import annotations

import socket
import struct
from dataclasses import dataclass
from urllib.parse import urlparse

_RFB_VERSION = b"RFB 003.008\n"
_SECURITY_NONE = 1
_MAX_EDGE = 4096
_DEFAULT_TIMEOUT_SEC = 10.0
_DISPLAY_PORT_BASE = 5900


class DisplayError(Exception):
    """RFB handshake or framebuffer capture failed."""


@dataclass(frozen=True)
class DisplayTarget:
    protocol: str
    host: str
    port: int

    @property
    def canonical(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.protocol}://{host}:{self.port}"


@dataclass(frozen=True)
class DisplayFrame:
    width: int
    height: int
    rgb: bytes


def parse_display_target(raw: str) -> DisplayTarget:
    """Parse ``vnc://host:display-or-port``, ``host:N``, ``:N``, or a port.

    Display numbers 0–99 map to TCP ``5900+N`` (the VNC ``localhost:1``
    convention). Values 5900–65535 are raw TCP ports.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("display target is empty")
    if "://" in text:
        parsed = urlparse(text)
        scheme = (parsed.scheme or "").lower()
        if scheme != "vnc":
            raise ValueError(
                f"unsupported display protocol {scheme!r}; capture_display "
                "speaks RFB/VNC (vnc://host:display)"
            )
        if parsed.username or parsed.password:
            raise ValueError(
                "capture_display does not take credentials in the URL; "
                "it captures unauthenticated VNC only"
            )
        host = parsed.hostname or "127.0.0.1"
        if parsed.port is not None:
            return DisplayTarget("vnc", host, _as_port(parsed.port))
        path_port = _port_from_path(parsed.path)
        return DisplayTarget("vnc", host, path_port if path_port is not None else 5900)

    if text.startswith(":"):
        return DisplayTarget("vnc", "127.0.0.1", _as_port(_parse_int(text[1:], "display")))
    if text.isdigit():
        return DisplayTarget("vnc", "127.0.0.1", _as_port(int(text)))
    if ":" in text:
        host, _, tail = text.rpartition(":")
        if host.startswith("[") and host.endswith("]"):
            host = host[1:-1]
        if not host:
            raise ValueError(f"invalid display target: {raw!r}")
        return DisplayTarget("vnc", host, _as_port(_parse_int(tail, "port")))
    raise ValueError(
        f"invalid display target: {raw!r}. Use vnc://host:1, :1, or host:5901"
    )


def capture_rfb(
    host: str,
    port: int,
    *,
    nudge: bool = False,
    timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
) -> DisplayFrame:
    """Read one full-frame RFB update and return 8-bit RGB."""
    try:
        sock = socket.create_connection((host, port), timeout=timeout_sec)
    except OSError as exc:
        raise DisplayError(f"no RFB server at {host}:{port}: {exc}") from exc
    try:
        sock.settimeout(timeout_sec)
        return _capture_connected(sock, nudge=nudge)
    except TimeoutError as exc:
        raise DisplayError(f"RFB capture timed out at {host}:{port}") from exc
    finally:
        sock.close()


def _capture_connected(sock: socket.socket, *, nudge: bool) -> DisplayFrame:
    server_version = _recv_exact(sock, 12)
    if not server_version.startswith(b"RFB "):
        raise DisplayError(f"not an RFB server (greeting {server_version!r})")
    if server_version.startswith(b"RFB 003.003"):
        sock.sendall(b"RFB 003.003\n")
        security = struct.unpack(">I", _recv_exact(sock, 4))[0]
        if security != _SECURITY_NONE:
            raise DisplayError(
                "RFB server requires authentication; capture_display supports "
                "unauthenticated VNC only"
            )
    else:
        sock.sendall(_RFB_VERSION)
        ntypes = _recv_exact(sock, 1)[0]
        types = _recv_exact(sock, ntypes)
        if _SECURITY_NONE not in types:
            raise DisplayError(
                "RFB server requires authentication; capture_display supports "
                "unauthenticated VNC only"
            )
        sock.sendall(bytes([_SECURITY_NONE]))
        result = struct.unpack(">I", _recv_exact(sock, 4))[0]
        if result != 0:
            raise DisplayError(f"RFB security handshake failed ({result})")
    sock.sendall(b"\x01")
    width, height = struct.unpack(">HH", _recv_exact(sock, 4))
    pixel = _recv_exact(sock, 16)
    name_len = struct.unpack(">I", _recv_exact(sock, 4))[0]
    if name_len:
        _recv_exact(sock, name_len)
    if width <= 0 or height <= 0 or width > _MAX_EDGE or height > _MAX_EDGE:
        raise DisplayError(f"RFB framebuffer {width}x{height} is out of range")
    bpp = pixel[0]
    if bpp not in (16, 32):
        raise DisplayError(f"unsupported RFB bits-per-pixel {bpp}")
    sock.sendall(_set_encodings())
    if nudge:
        sock.sendall(_pointer_event(1, 1) + _pointer_event(0, 0))
    sock.sendall(_framebuffer_request(width, height))
    pixels = bytearray(width * height * 4)
    filled = _read_framebuffer(sock, width, height, pixel, pixels)
    if not filled:
        raise DisplayError("RFB server sent no framebuffer update")
    return DisplayFrame(width, height, _pixels_to_rgb(pixels, width, height, pixel))


def _as_port(value: int) -> int:
    if 0 <= value < 100:
        return _DISPLAY_PORT_BASE + value
    if 1 <= value <= 65535:
        return value
    raise ValueError(f"display port {value} is out of range")


def _parse_int(raw: str, label: str) -> int:
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"invalid {label}: {raw!r}") from exc


def _port_from_path(path: str) -> int | None:
    text = path.strip("/")
    if not text:
        return None
    return _as_port(_parse_int(text, "display"))


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    buf = bytearray()
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise DisplayError("RFB peer closed the connection")
        buf.extend(chunk)
    return bytes(buf)


def _set_encodings() -> bytes:
    # raw + copyrect
    return struct.pack(">BBHii", 2, 0, 2, 0, 1)


def _pointer_event(x: int, y: int) -> bytes:
    return struct.pack(">BBHH", 5, 0, x, y)


def _framebuffer_request(width: int, height: int) -> bytes:
    return struct.pack(">BBHHHH", 3, 0, 0, 0, width, height)


def _read_framebuffer(
    sock: socket.socket,
    width: int,
    height: int,
    pixel: bytes,
    dest: bytearray,
) -> bool:
    bpp = pixel[0]
    bytes_pp = bpp // 8
    got_update = False
    while not got_update:
        kind = _recv_exact(sock, 1)[0]
        if kind == 0:
            _recv_exact(sock, 1)
            nrects = struct.unpack(">H", _recv_exact(sock, 2))[0]
            for _ in range(nrects):
                x, y, w, h, encoding = struct.unpack(">HHHHi", _recv_exact(sock, 12))
                if encoding == 0:
                    raw = _recv_exact(sock, w * h * bytes_pp)
                    _blit_raw(dest, width, x, y, w, h, raw, bytes_pp)
                elif encoding == 1:
                    src_x, src_y = struct.unpack(">HH", _recv_exact(sock, 4))
                    _blit_copy(dest, width, x, y, w, h, src_x, src_y)
                else:
                    raise DisplayError(f"unsupported RFB encoding {encoding}")
            got_update = True
        elif kind == 1:
            _recv_exact(sock, 3)
            ncolors = struct.unpack(">H", _recv_exact(sock, 2))[0]
            _recv_exact(sock, ncolors * 6)
        elif kind == 2:
            continue
        elif kind == 3:
            _recv_exact(sock, 3)
            length = struct.unpack(">I", _recv_exact(sock, 4))[0]
            if length:
                _recv_exact(sock, length)
        else:
            raise DisplayError(f"unsupported RFB server message {kind}")
    return got_update


def _blit_raw(
    dest: bytearray,
    stride_px: int,
    x: int,
    y: int,
    w: int,
    h: int,
    raw: bytes,
    bytes_pp: int,
) -> None:
    for row in range(h):
        src = row * w * bytes_pp
        dst = ((y + row) * stride_px + x) * 4
        if bytes_pp == 4:
            dest[dst : dst + w * 4] = raw[src : src + w * 4]
            continue
        for col in range(w):
            pix = raw[src + col * 2 : src + col * 2 + 2]
            dest[dst + col * 4 : dst + col * 4 + 2] = pix
            dest[dst + col * 4 + 2 : dst + col * 4 + 4] = b"\x00\x00"


def _blit_copy(
    dest: bytearray,
    stride_px: int,
    x: int,
    y: int,
    w: int,
    h: int,
    src_x: int,
    src_y: int,
) -> None:
    snapshot = bytes(dest)
    for row in range(h):
        src = ((src_y + row) * stride_px + src_x) * 4
        dst = ((y + row) * stride_px + x) * 4
        dest[dst : dst + w * 4] = snapshot[src : src + w * 4]


def _pixels_to_rgb(pixels: bytearray, width: int, height: int, pixel: bytes) -> bytes:
    bpp = pixel[0]
    big_endian = pixel[2] != 0
    rmax, gmax, bmax = struct.unpack(">HHH", pixel[4:10])
    rshift, gshift, bshift = pixel[10], pixel[11], pixel[12]
    rgb = bytearray(width * height * 3)
    for i in range(width * height):
        if bpp == 32:
            raw = pixels[i * 4 : i * 4 + 4]
            value = struct.unpack(">I" if big_endian else "<I", raw)[0]
        else:
            raw = pixels[i * 4 : i * 4 + 2]
            value = struct.unpack(">H" if big_endian else "<H", raw)[0]
        rgb[i * 3] = _channel(value, rmax, rshift)
        rgb[i * 3 + 1] = _channel(value, gmax, gshift)
        rgb[i * 3 + 2] = _channel(value, bmax, bshift)
    return bytes(rgb)


def _channel(value: int, max_value: int, shift: int) -> int:
    if max_value <= 0:
        return 0
    scaled = (value >> shift) & max_value
    if max_value == 255:
        return scaled
    return (scaled * 255) // max_value
