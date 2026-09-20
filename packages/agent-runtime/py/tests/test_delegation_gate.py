"""RequiredDelegationGate: a turn must delegate to every named profile.

Forced dispatch used to be prompt text only — a turn that ran unrelated
tools and then narrated "I launched the three agents" finished ``completed``
with zero delegations, and the claimed-execution guard did not fire because
the round did run tools.
"""

import pytest
from steerable_agent_protocol.generated import ToolCall, ToolResult

from steerable_agent_runtime import RequiredDelegationGate
from steerable_agent_runtime.hooks import CompletionDraft


def _draft(status: str = "completed") -> CompletionDraft:
    return CompletionDraft(
        status=status,
        reason="model finished",
        content="三位智能体已启动。",
        round_index=3,
        had_tool_calls=False,
        tool_calls_used=10,
        tool_successes=10,
    )


def _delegate(profile: str) -> ToolCall:
    return ToolCall(
        id=f"call-{profile}",
        name="delegate_subagent",
        arguments={"task": "做点事", "subagent_type": profile},
    )


async def _observe(gate: RequiredDelegationGate, call: ToolCall, *, success: bool = True):
    return await gate.post_tool_result(
        ToolResult(success=success, data={"answer": "done"} if success else None),
        call,
        None,
    )


@pytest.mark.asyncio
async def test_missing_profile_retries_naming_it() -> None:
    gate = RequiredDelegationGate(["helper", "scheduler"])
    await _observe(gate, _delegate("helper"))

    action = await gate.before_completion(_draft(), None)

    assert action.kind == "retry"
    assert action.reason == "required_delegation_missing"
    assert "scheduler" in (action.message or "")
    assert "helper" not in (action.message or "")


@pytest.mark.asyncio
async def test_all_profiles_delegated_accepts() -> None:
    gate = RequiredDelegationGate(["helper", "scheduler"])
    await _observe(gate, _delegate("helper"))
    await _observe(gate, _delegate("scheduler"))

    assert (await gate.before_completion(_draft(), None)).kind == "accept"


@pytest.mark.asyncio
async def test_failed_child_still_counts_as_delegated() -> None:
    """Re-delegating to a child that failed would spin; the parent reports it."""
    gate = RequiredDelegationGate(["helper"])
    await _observe(gate, _delegate("helper"), success=False)

    assert (await gate.before_completion(_draft(), None)).kind == "accept"


@pytest.mark.asyncio
async def test_non_completed_status_is_not_gated() -> None:
    """budget_exhausted / failed have their own continuation paths."""
    gate = RequiredDelegationGate(["helper"])

    assert (await gate.before_completion(_draft("budget_exhausted"), None)).kind == "accept"
    assert (await gate.before_completion(_draft("failed"), None)).kind == "accept"


@pytest.mark.asyncio
async def test_retries_are_bounded() -> None:
    gate = RequiredDelegationGate(["helper"], max_retries=2)

    assert (await gate.before_completion(_draft(), None)).kind == "retry"
    assert (await gate.before_completion(_draft(), None)).kind == "retry"
    assert (await gate.before_completion(_draft(), None)).kind == "accept"


@pytest.mark.asyncio
async def test_no_required_profiles_accepts_anything() -> None:
    gate = RequiredDelegationGate([])

    assert (await gate.before_completion(_draft(), None)).kind == "accept"


@pytest.mark.asyncio
async def test_other_tools_do_not_satisfy_a_profile() -> None:
    gate = RequiredDelegationGate(["helper"])
    await _observe(
        gate,
        ToolCall(id="c1", name="local_exec_shell", arguments={"command": "date"}),
    )

    assert (await gate.before_completion(_draft(), None)).kind == "retry"
