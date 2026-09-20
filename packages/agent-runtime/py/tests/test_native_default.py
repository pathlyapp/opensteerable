"""Rust CoreLoop is the only execution path."""

from __future__ import annotations

import contextvars
from collections.abc import AsyncIterator
from typing import Any

import pytest
from steerable_agent_protocol.generated import ToolCall
from steerable_agent_runtime import CoreLoop, RouterToolExecutor, ToolRouter, tool
from steerable_agent_runtime.llm import LLMMessage, LLMStreamChunk
from steerable_agent_runtime.native_bridge import native_available, require_native


def test_native_module_is_required() -> None:
    require_native()
    assert native_available() is True


def test_require_native_raises_a_clear_install_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import builtins

    real_import = builtins.__import__

    def blocked(name: str, *args: Any, **kwargs: Any):
        if name == "steerable_agent_runtime_native":
            raise ImportError("simulated missing wheel")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    with pytest.raises(RuntimeError, match="steerable-agent-runtime-native"):
        require_native()


#: Stand-in for the process-lifetime ContextVars callers bind around a turn —
#: ``run_code`` keeps its nested-tool router in one.
_ambient: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "test_ambient", default=None
)


def _provider_calling(name: str) -> Any:
    class _FakeProvider:
        name = "fake"
        model = "fake-model"

        def __init__(self) -> None:
            self._idx = 0

        async def complete(self, messages, *, tools=None, **kw):  # pragma: no cover
            raise NotImplementedError

        def stream(self, messages, *, tools=None, **kw) -> AsyncIterator[LLMStreamChunk]:
            first = self._idx == 0
            self._idx += 1

            async def _gen() -> AsyncIterator[LLMStreamChunk]:
                if first:
                    yield LLMStreamChunk(
                        tool_call_delta=ToolCall(id="c1", name=name, arguments={})
                    )
                    yield LLMStreamChunk(finish_reason="tool_calls")
                else:
                    yield LLMStreamChunk(content_delta="done")
                    yield LLMStreamChunk(finish_reason="stop")

            return _gen()

    return _FakeProvider()


@pytest.mark.asyncio
async def test_native_tool_execution_sees_the_callers_context_vars() -> None:
    """Rust drives the Python callbacks from its own thread, so a task created
    for them copies that thread's context, not the turn's. A tool that reads an
    ambient ContextVar would then see the default unless the bridge snapshots
    the caller's context — which is how ``run_code`` lost its nested-tool
    router.
    """
    router = ToolRouter()
    seen: list[str | None] = []

    @tool(router=router, name="peek", description="read the ambient var", mode="read")
    async def peek() -> dict[str, Any]:
        seen.append(_ambient.get())
        return {"value": seen[-1]}

    _ambient.set("bound-by-caller")
    loop = CoreLoop(_provider_calling("peek"), RouterToolExecutor(router))
    tools = [
        {
            "type": "function",
            "function": {
                "name": "peek",
                "description": "read",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]
    async for _event in loop.run([LLMMessage.text_of("user", "go")], tools=tools):
        pass

    assert seen == ["bound-by-caller"]
