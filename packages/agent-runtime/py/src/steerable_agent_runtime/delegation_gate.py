"""Required-delegation completion gate.

A host that names sub-agents for a turn (the desktop's ``@`` mentions) can
only *ask* the model to delegate: the dispatch instruction is prompt text,
and every existing discipline guard lets a narrated hand-off through. The
claimed-execution check in ``antihallucination`` fires only on a round with
no tool calls at all, so a turn that ran unrelated tools and then wrote "I
launched the three agents" ends ``completed`` with zero delegations.

This gate closes that hole: the host declares which profiles must receive a
delegation, the gate watches ``delegate_subagent`` calls, and a ``completed``
draft that skipped one is converted into a retry naming the missing
profiles.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from steerable_agent_protocol.generated import ToolCall, ToolResult

from .hooks import CompletionAction, CompletionDraft, NoopHooks

#: Retries this gate grants before accepting a turn that skipped a profile.
#: The loop's own completion-redo budget bounds the total; this keeps one
#: uncooperative model from spending all of it on delegation alone.
DEFAULT_MAX_RETRIES = 2


class RequiredDelegationGate(NoopHooks):
    """``before_completion`` veto: every required profile must be delegated.

    A profile counts as satisfied once a delegation was *attempted*, whether
    the child succeeded or not — a child that failed (its own tool error, a
    budget wall) is the parent's to report, and re-delegating to it would
    spin. Only a profile the model never called at all blocks finishing.

    One instance per run: it accumulates the turn's delegations.
    """

    def __init__(
        self,
        required_profiles: Iterable[str],
        *,
        tool_name: str = "delegate_subagent",
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        """
        @param required_profiles: profile names that must each receive a
            delegation; duplicates and blanks are dropped.
        @param tool_name: the delegation tool to watch.
        @param max_retries: retries granted before accepting a skip.
        """
        self._required = tuple(
            dict.fromkeys(name.strip() for name in required_profiles if name.strip())
        )
        self._tool_name = tool_name
        self._max_retries = max_retries
        self._delegated: set[str] = set()
        self._retries = 0

    async def post_tool_result(
        self, result: ToolResult, call: ToolCall, ctx: Any
    ) -> ToolResult:
        """Record the delegated profile, passing the result through."""
        if call.name == self._tool_name:
            profile = str(call.arguments.get("subagent_type") or "").strip()
            if profile:
                self._delegated.add(profile)
        return result

    async def before_completion(
        self, draft: CompletionDraft, ctx: Any
    ) -> CompletionAction:
        """Retry while a required profile has no delegation, else accept.

        Only ``completed`` is gated: ``budget_exhausted`` and error stops have
        their own continuation paths (the host's auto-continue resumes with a
        fresh budget), and vetoing them here would fight those.
        """
        if draft.status != "completed":
            return CompletionAction(kind="accept")
        missing = [name for name in self._required if name not in self._delegated]
        if not missing or self._retries >= self._max_retries:
            return CompletionAction(kind="accept")
        self._retries += 1
        listing = "、".join(missing)
        return CompletionAction(
            kind="retry",
            message=(
                f"用户点名的子代理还没拿到任务：{listing}。"
                "现在就用 delegate_subagent 给每一个补上一份自包含的子任务"
                "（subagent_type 填画像名），不要用文字描述代替调用。"
            ),
            reason="required_delegation_missing",
        )


__all__ = ["DEFAULT_MAX_RETRIES", "RequiredDelegationGate"]
