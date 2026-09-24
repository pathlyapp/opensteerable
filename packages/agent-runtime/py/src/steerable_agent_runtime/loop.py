"""CoreLoop — the single-agent step loop (think → act → observe).

This is the A3 "minimal slice": the inner tool-round loop plus a completion
decision, yielding structured `LoopEvent`s (never encoded bytes). A
`TransportAdapter` encodes them for the wire; orchestration stays above.

Execution is the Rust engine via PyO3 (`native_bridge.run_native`). This
module keeps the public `CoreLoop` API, configuration, events, history
seeding, and the Python I/O ports the engine calls back into (provider,
executor, hooks).

Implemented surface (see docs/spec/core-loop.md):
  * inner loop state machine and round control (Rust)
  * LLM stream consumption (via LLMProvider) with display hygiene:
    UTF-16 surrogate-pair carry and streaming pseudo/echo-block stripping
    (see pseudo.py) — raw text is kept for recovery/transcript, cleaned
    text is what ``content_delta`` events emit
  * tool dispatch through the ToolExecutor port, with hygiene guards:
    same-turn ``(name, args)`` dedup (soft ``duplicate_call`` signal),
    unknown-tool suggestions and schema argument coercion (tools.py)
  * token budget counters + completion decision
  * pseudo / markdown tool-call recovery (see pseudo.py)
  * LoopHooks extension points (see hooks.py): pre_step (declared rewrite /
    appends + tool_choice) / post_tool_result / on_request_error /
    before_completion (terminal veto: discipline retry or narration round) —
    capabilities land as hook implementations, not as more branches here
  * single write path: completion events carry their full step summary and
    the compact trajectory is derived from them (no separate record channel)
  * typed append-only history (see history.py): the transcript the provider
    sees is a projection of the record; every mutation is an append, and
    hook rewrites go through the declared ``ContextManager.replace_all``
    path (the only rewrite, itself append-only)
  * soft timeout: a wall-clock limit (LoopConfig.soft_timeout_ms) checked at
    round boundaries *and* between LLM stream chunks. An in-flight reasoning
    stream that overruns the deadline is closed so wrap-up can still write
    files (Harbor ×12 kills the trial ~30 min later). Chat withholds tools
    and asks for a final answer; ``wrap_up_keeps_tools`` keeps offering
    tools for a few act rounds so Harbor can still score files on disk.
    ``wrap_up_tool_timeout_ms`` caps wrap-up streams and tools;
    ``wrap_up_hard_cap_ms`` caps every tool from run start.
  * per-tool timeout (LoopConfig.tool_timeout_ms): a hung tool returns a
    failed ToolResult instead of hanging the turn; the consecutive-error
    breaker treats it like any other tool failure

The anti-hallucination layer (data-need routing, grounding judge,
deferred/claimed retry, narration round) lives in antihallucination.py as a
LoopHooks implementation. Compaction and large-result externalization live
in hooks (compaction.py / spill.py), not here. Observability lives in
tracing.py (a TraceRecorder consuming this event stream), not in the loop
itself.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from steerable_agent_harness import BudgetLimit
from steerable_agent_protocol.generated import ToolCall, ToolResult

from .approval import ToolTimeoutClock, tool_timeout_clock
from .history import (
    KIND_ASSISTANT,
    KIND_SYSTEM,
    KIND_USER,
    CompactionBoundary,
    ContextFragment,
    ContextManager,
    HistoryItem,
    HistorySeed,
    HistoryStore,
    entry_from_dict,
    entry_to_dict,
)
from .hooks import LoopHooks, NoopHooks, RewriteRequest
from .llm import LLMMessage, LLMProvider, LLMUsage
from .replay import HarnessTrajectoryEvent
from .tools import ToolRouter

# ---------------------------------------------------------------------------
# LoopEvent
# ---------------------------------------------------------------------------

#: Event categories per docs/spec/core-loop.md. The *kind* is framework-owned;
#: the *data* payload may carry product fields (consumers ignore unknowns).
LoopEventKind = Literal[
    # lifecycle
    "stage_start",
    "stage_complete",
    "error",
    # content stream
    "content_delta",
    "reasoning_delta",
    # LLM request brackets (W2.7.2): one pair per provider call — retries
    # within a round produce one pair per attempt, so traces show the real
    # request count and latency instead of one collapsed round.
    "llm_request",
    "llm_response",
    # tool side
    "tool_call_start",
    "tool_call_result",
    "tool_error",
    # budget / control
    "budget_exhausted",
    "soft_timeout",
    "completion",
    # mid-turn user steering (see CoreLoop.steer)
    "steer",
    # hook-driven control flow (compaction, retry, narration, tool_choice) —
    # emitted at the decision point so traces show *why* the loop changed
    # course; without it hook triggers are invisible to offline analysis.
    "hook_action",
]


@dataclass(slots=True)
class LoopEvent:
    """A structured event yielded by the loop. Never encoded bytes."""

    kind: LoopEventKind
    data: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Completion decision
# ---------------------------------------------------------------------------

CompletionStatus = Literal[
    "executing",
    "completed",
    "failed",
    "budget_exhausted",
    "cancelled",
    # Emitted when a tool returns a terminal result that asks the loop to
    # suspend for user input (e.g. an interactive UI prompt such as
    # ``ask_user``). Aligns with the replay contract's ``waiting_user`` —
    # the turn ends here; the host resumes it once the user responds.
    "waiting_user",
]


@dataclass(slots=True)
class CompletionDecision:
    status: CompletionStatus
    reason: str
    confidence: float = 1.0


# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------


@runtime_checkable
class ToolExecutor(Protocol):
    """Dispatch port for tool calls.

    An executor only runs the tool; cross-cutting concerns (dedup, policy gate,
    budget) belong in the loop — of those only the token budget is wired up so
    far. The default implementation forwards to a `ToolRouter`; products inject
    handlers for UI tools, proposals, MCP, and (for the desktop) remote tools
    over the sidecar reverse channel.

    Optional duck-typed method: ``concurrency_safe(call) -> bool``. When
    present and ``LoopConfig.parallel_tools`` is on, consecutive safe calls
    in one round run concurrently. Absent → serial (safe default).
    """

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult: ...


class RouterToolExecutor:
    """Default ToolExecutor: dispatch through an in-process ToolRouter."""

    def __init__(self, router: ToolRouter, *, consent_granted: bool = False) -> None:
        self._router = router
        self._consent_granted = consent_granted

    async def execute(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        return await self._router.dispatch(
            call,
            # An upstream ApprovalExecutor bridges its allow verdict through
            # the context so the router's require_consent gate recognizes it
            # instead of double-gating.
            consent_granted=self._consent_granted or ctx.consent_granted,
            context={"chat_id": ctx.chat_id, "round": ctx.round_index},
        )

    def concurrency_safe(self, call: ToolCall) -> bool:
        """Optional hook the loop uses for parallel batching (duck-typed —
        executors without it are treated as serial-only)."""
        tool = self._router.get(call.name)
        return bool(tool and tool.concurrency_safe)


# ---------------------------------------------------------------------------
# Context + config
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class LoopContext:
    """Per-run state threaded through the loop and exposed to executors."""

    chat_id: str | None = None
    round_index: int = 0
    tool_calls_used: int = 0
    consecutive_tool_errors: int = 0
    #: Successful tool results this turn — the anti-hallucination layer keys
    #: off "zero usable tool returns" to detect fabricated data reports.
    tool_successes: int = 0
    #: Reasoning chars streamed since the last tool call the hooks counted as
    #: progress (see ``LoopHooks.tool_made_progress``). Unlike the per-round
    #: stream counters this survives across rounds, so it measures reasoning
    #: that produced nothing rather than reasoning that was merely long.
    reasoning_since_progress: int = 0
    #: Provider-reported prompt tokens of the last completed request, and the
    #: transcript length at that moment. Ground truth for compaction pressure
    #: (the heuristic estimate drifts per model; this does not). Hooks that
    #: rewrite the transcript must reset both — the indices go stale.
    last_prompt_tokens: int | None = None
    last_prompt_transcript_len: int = 0
    #: Prompt-cache accounting of the last completed request (zero when the
    #: provider reports none). Telemetry only — surfaced on stage_complete so
    #: cache stability is measurable; unlike the pressure indices above these
    #: describe one request, not a projection, so rewrites don't stale them.
    last_cached_prompt_tokens: int = 0
    last_cache_creation_tokens: int = 0
    #: Accumulated billable usage across every provider request this run
    #: (W6-9). Unlike the ``last_*`` pressure indices these SUM over requests —
    #: each request bills its own prompt+completion, so per-turn cost
    #: attribution needs the running totals, not the latest single request.
    accumulated_prompt_tokens: int = 0
    accumulated_completion_tokens: int = 0
    #: Set by an upstream ApprovalExecutor on its allow path; read by
    #: RouterToolExecutor to bridge the verdict into the router's
    #: require_consent gate. Plain False when no approval layer is wired.
    consent_granted: bool = False


@dataclass(slots=True)
class LoopConfig:
    """Tunables for one loop run.

    `max_tool_errors` uses consecutive semantics and resets on success.
    """

    max_rounds: int = 32
    max_tool_errors: int = 3
    budget: BudgetLimit | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    #: Wall-clock soft limit. When exceeded, the loop asks the model to wrap
    #: up instead of hard-killing the run. Checked at round boundaries and
    #: between LLM stream chunks so a 2-hour reasoning stream cannot skip
    #: wrap-up. Default wrap-up withholds tools (one text round). ``None``
    #: disables.
    soft_timeout_ms: int | None = None
    #: Coding evals (Harbor / Terminal-Bench) score files on disk, not chat
    #: text. Keep offering tools after the soft timeout so the model can
    #: still write those files. Chat stays False.
    wrap_up_keeps_tools: bool = False
    #: Extra act rounds after wrap-up when ``wrap_up_keeps_tools`` is set.
    #: Then tools are withheld for a final text round unless
    #: ``hooks.wrap_up_may_drop_tools()`` is False (named outputs still
    #: missing). Keep the default small so Harbor can still kill the trial.
    wrap_up_max_tool_rounds: int = 4
    #: Per-tool and per-stream wall-clock while wrap-up is active. A 1-hour
    #: bash or another reasoning stream after the soft timeout otherwise
    #: eats Harbor's remaining wait_for. ``None`` leaves ``tool_timeout_ms``
    #: (and unbounded wrap-up streams) unchanged.
    wrap_up_tool_timeout_ms: int | None = None
    #: Absolute tool wall-clock from run start. Harbor catalog ×12 is 180
    #: min; headless sets 175 min so a tool started near the soft deadline
    #: still returns before the kill. ``None`` disables.
    wrap_up_hard_cap_ms: int | None = None
    #: Cut a reasoning-only stream after this much *active* token wall.
    #: Gaps longer than ``_IDLE_REASONING_GAP_SEC`` are GLM silent-think
    #: (regex-chess ~48 min with no SSE) and do not count. The first cut
    #: does not wrap-up — delivery can still force a named write. A second
    #: cut in the same run starts wrap-up: Z.AI coerces
    #: ``tool_choice=required`` to auto, so retries can Hmm for another
    #: cap each and eat Harbor ``wait_for``. Cuts keep firing during
    #: wrap-up; each one spends a ``wrap_up_max_tool_rounds`` round, so the
    #: spiral ends instead of streaming to Harbor's kill. ``None`` disables.
    idle_stream_timeout_ms: int | None = None
    #: Cut a tool-less stream after this many reasoning + content chars.
    #: Time alone misses the worst spirals: silent-think gaps are excluded
    #: from the active wall, and a dense stream keeps every chunk inside the
    #: wrap-up per-chunk wait, so circuit-fibsqrt emitted 392 KB in one
    #: round over 75 min with zero tool calls. Volume is what the model
    #: actually spends. ``None`` disables.
    idle_stream_max_chars: int | None = None
    #: Cut a tool-less stream once this many reasoning chars have accumulated
    #: since the last tool call the hooks counted as progress. The per-round
    #: caps above measure one stream, which barely separates a spiral from a
    #: long but productive run — a passing catalog trial reasoned 1.79 M chars
    #: across the run and still delivered, because it kept writing. Reasoning
    #: that produced nothing is the discriminator. The cut spends the budget,
    #: so this bounds interruptions to one per cap rather than cutting every
    #: later round at its first chunk. ``LoopHooks.tool_made_progress`` owns
    #: what counts as progress, keeping the loop free of tool semantics.
    #: ``None`` disables.
    reasoning_without_progress_chars: int | None = None
    #: Block re-issuing an identical ``(name, args)`` call within one run.
    #: Deterministic tools return identical output for identical input, so a
    #: repeat only burns tokens and can push the model into a retry loop. It
    #: counts toward the consecutive tool-error breaker. No write/destructive exemption — idempotency of
    #: side effects belongs to the action layer below.
    tool_dedup: bool = True
    #: Include the full tool result in ``tool_call_result`` events (not just
    #: the 300-char preview). Off by default to keep traces small; enable when
    #: the trace is the resume record (see ``resume.project_transcript``).
    persist_tool_results: bool = False
    #: Run consecutive concurrency-safe tool calls from the same round
    #: concurrently (asyncio.gather); unsafe calls form a barrier and run
    #: alone. A call is safe when the executor says so — RouterToolExecutor
    #: looks up ``RegisteredTool.concurrency_safe``; executors without the
    #: check (e.g. HostToolExecutor, which serializes on the host) stay
    #: serial. Event order stays deterministic: start events in call order,
    #: result events in call order after each batch completes.
    parallel_tools: bool = True
    #: Per-tool-execution wall-clock limit. Without this a hung tool (a dead
    #: remote server, a stuck reverse-channel call) hangs the whole turn.
    #: On expiry the call returns a failed ``ToolResult`` (error
    #: ``tool_timeout``) instead of raising through the loop, so the
    #: consecutive-error breaker handles it like any other tool failure.
    #: Applies to every executor, in-process or remote. The default is a
    #: backstop against *hung* tools, not a budget — products with fast
    #: tools should set a tighter value. ``None`` disables. Wrap-up may
    #: shrink this via ``wrap_up_tool_timeout_ms`` / ``wrap_up_hard_cap_ms``.
    tool_timeout_ms: int | None = 300_000
    #: Bound on one mid-turn ``steer()`` injection (W4-7). Oversized
    #: injections are truncated with a visible marker. ``None`` disables
    #: (trusted hosts only).
    max_steer_chars: int | None = 32_000
    #: What a mid-turn ``steer()`` does to in-flight tool calls (W2.8.1).
    #: ``"boundary"`` (default): the message waits in the inbox and drains
    #: at the next round boundary — running tools finish undisturbed.
    #: ``"interrupt"``: the arrival cancels the in-flight tool phase (like
    #: cooperative cancel, but the turn CONTINUES): interrupted calls get a
    #: synthetic notice, unstarted calls are skipped, and the steer reaches
    #: the model at the very next request. pi's ``steeringMode`` equivalent.
    steer_mode: Literal["boundary", "interrupt"] = "boundary"

    def __post_init__(self) -> None:
        if self.tool_timeout_ms is not None and self.tool_timeout_ms <= 0:
            raise ValueError("tool_timeout_ms must be positive (or None to disable)")
        if self.max_steer_chars is not None and self.max_steer_chars <= 0:
            raise ValueError("max_steer_chars must be positive (or None to disable)")
        if self.steer_mode not in ("boundary", "interrupt"):
            raise ValueError(
                f"steer_mode must be 'boundary' or 'interrupt', got {self.steer_mode!r}"
            )
        if self.wrap_up_max_tool_rounds < 0:
            raise ValueError("wrap_up_max_tool_rounds must be >= 0")
        if (
            self.wrap_up_tool_timeout_ms is not None
            and self.wrap_up_tool_timeout_ms <= 0
        ):
            raise ValueError(
                "wrap_up_tool_timeout_ms must be positive (or None to disable)"
            )
        if self.wrap_up_hard_cap_ms is not None and self.wrap_up_hard_cap_ms <= 0:
            raise ValueError(
                "wrap_up_hard_cap_ms must be positive (or None to disable)"
            )
        if (
            self.idle_stream_timeout_ms is not None
            and self.idle_stream_timeout_ms <= 0
        ):
            raise ValueError(
                "idle_stream_timeout_ms must be positive (or None to disable)"
            )
        if (
            self.idle_stream_max_chars is not None
            and self.idle_stream_max_chars <= 0
        ):
            raise ValueError(
                "idle_stream_max_chars must be positive (or None to disable)"
            )
        if (
            self.reasoning_without_progress_chars is not None
            and self.reasoning_without_progress_chars <= 0
        ):
            raise ValueError(
                "reasoning_without_progress_chars must be positive "
                "(or None to disable)"
            )


# ---------------------------------------------------------------------------
# CoreLoop
# ---------------------------------------------------------------------------


class CoreLoop:
    """Minimal single-agent step loop.

    Usage::

        loop = CoreLoop(provider, executor, config)
        async for event in loop.run(messages):
            transport.emit(encode(event))  # encoding is the adapter's job

    The loop owns the model-visible record (a typed, append-only
    ``ContextManager`` log — see history.py): every transcript mutation is
    an append, and hook rewrites go through the declared ``replace_all``
    path, so each round's projection reflects everything recorded so far.

    ``run()`` always drives the Rust engine through PyO3. The matching
    ``steerable-agent-runtime-native`` wheel is required.
    """

    def __init__(
        self,
        provider: LLMProvider,
        executor: ToolExecutor,
        config: LoopConfig | None = None,
        hooks: LoopHooks | None = None,
        history_store: HistoryStore | None = None,
        record_id: str | None = None,
    ) -> None:
        self._provider = provider
        self._executor = executor
        self._config = config or LoopConfig()
        self._hooks: LoopHooks = hooks if hooks is not None else NoopHooks()
        # Durable record channel (Wave 1 step 5). When set, the loop flushes
        # the manager's pending entries before each LLM request, after each
        # tool batch, and at turn end — everything the model saw is durable
        # before the next request depends on it. ``record_id`` defaults to
        # the run's ``chat_id`` (the continuous per-chat log).
        self._history_store = history_store
        self._record_id = record_id
        # Mid-turn user messages land here via steer() and are drained into
        # the transcript at the next round boundary (dsh-style "inject":
        # consumed at the next step, no separate wakeup semantics).
        self._inbox: asyncio.Queue[str] = asyncio.Queue()
        # Set whenever a steer lands; in ``steer_mode="interrupt"`` the tool
        # phase races against it (arrival ends the batch early). Cleared by
        # the round-boundary drain.
        self._steer_event = asyncio.Event()
        # Cooperative cancellation token (see cancel()). Sticky for the loop
        # instance — a CoreLoop is single-run in practice (the sidecar builds
        # one per stream), so a cancel issued before run() still applies.
        self._cancel_event = asyncio.Event()
        # Manual compaction request token (see request_compact()): the host
        # sets it via the sidecar's agent.chat.compact RPC; the loop consumes
        # it at the next pre_step boundary by delegating to the hook chain's
        # compact_now.
        self._compact_event = asyncio.Event()
        # Compact trajectory recorded during run(); replayable via
        # replay.reduce_execution_state. Derived from the completion events
        # (single write path — see _emit_completion). Reset each run.
        self.trajectory: list[HarnessTrajectoryEvent] = []
        # The append-only model-visible record for the current run (the
        # transcript is its projection). Rebuilt per run() from the seed
        # messages; exposed for tests, persistence, and resume.
        self.history = ContextManager()
        # W6-9: the live LoopContext of the current/last run, so the host can
        # read accumulated billable usage after the run via `last_run_usage`.
        self._run_context: LoopContext | None = None
        self._run_started = 0.0
        self._wrap_up_active = False

    def steer(self, content: str) -> None:
        """Inject a user message into a running turn.

        Called from the same event loop (e.g. a sidecar RPC handler) while
        ``run()`` is active; the message is appended to the transcript at the
        next round boundary and surfaced as a ``steer`` event. Messages sent
        after the run ends are ignored by the (already closed) consumer.

        Bounded (W4-7): an oversized injection is truncated to
        ``max_steer_chars`` with a visible marker rather than appended
        whole — a host bug must not be able to stuff an unbounded blob
        mid-turn.
        """
        if content:
            cap = self._config.max_steer_chars
            if cap is not None and len(content) > cap:
                content = (
                    f"{content[:cap]}\n…[steer message truncated at {cap} chars]"
                )
            self._inbox.put_nowait(content)
            self._steer_event.set()

    def cancel(self) -> None:
        """Request cooperative cancellation of the current run.

        Called from the same event loop (e.g. a sidecar RPC handler) while
        ``run()`` is active. The loop winds down at the next safe point —
        round boundary, stream chunk, or tool-call slot — records the partial
        turn (streamed content as the terminal assistant message; real
        results for executed tool calls, a "cancelled" error for the
        in-flight one, synthetic skip notices for the rest, so the record
        never has dangling tool_calls), and emits a terminal completion with
        status ``"cancelled"``. An in-flight tool coroutine is
        asyncio-cancelled so a hung tool does not pin the turn. Sticky for
        the loop instance: a cancel issued before ``run()`` ends the run at
        the first round boundary.
        """
        self._cancel_event.set()

    def reset_cancel(self) -> None:
        """Clear a prior cancel request so the loop can run again.

        Multi-turn child resume (orchestration ``agent_send`` to a finished
        or interrupted child) re-runs the same loop instance; without this
        the sticky cancel would end the fresh run at its first boundary.
        Only meaningful between runs — clearing mid-run is the caller's
        responsibility (the in-flight run simply stops winding down).
        """
        self._cancel_event.clear()

    def request_compact(self) -> None:
        """Request a manual compaction of the running turn's transcript.

        Called from the same event loop (e.g. a sidecar RPC handler for
        ``agent.chat.compact``, the CC ``/compact`` parity path) while
        ``run()`` is active. The loop consumes the request at the next
        pre_step boundary: the hook chain's ``compact_now``
        (CompactionHooks) folds old tool results and summarizes the middle
        regardless of pressure, and the declared rewrite lands through the
        same ``replace_all`` path as a pressure compaction. Without a
        compaction hook in the chain the request is a no-op. Like steer(),
        a request that arrives after the run has ended finds no boundary
        left to consume it and has no effect.
        """
        self._compact_event.set()

    @property
    def record_id(self) -> str | None:
        """Durable-record id this loop appends to, when one was configured.

        Hosts that want to read a run's transcript back (a pooled child's
        process view) need the id the loop writes under, not the one they
        guessed.
        """
        return self._record_id

    @property
    def last_run_usage(self) -> LLMUsage | None:
        """Accumulated billable usage of the current/last run (W6-9).

        Summed over every provider request in the run — each request bills its
        own prompt+completion, so per-turn cost attribution needs these totals,
        not the latest single request. ``None`` before the first run.
        """
        ctx = self._run_context
        if ctx is None:
            return None
        return LLMUsage(
            prompt_tokens=ctx.accumulated_prompt_tokens,
            completion_tokens=ctx.accumulated_completion_tokens,
            total_tokens=ctx.accumulated_prompt_tokens + ctx.accumulated_completion_tokens,
            cached_prompt_tokens=ctx.last_cached_prompt_tokens,
            cache_creation_tokens=ctx.last_cache_creation_tokens,
        )

    async def _flush_history(
        self, manager: ContextManager, chat_id: str | None
    ) -> None:
        """Persist the record's new entries (no-op without a history store).

        ``record_id`` defaults to the run's ``chat_id`` — the continuous
        per-chat log (decision ② of the W1 design). Flush points: before
        each LLM request, after each tool batch, and at turn end, so a
        crash never loses more than the in-flight round.
        """
        if self._history_store is None:
            return
        record_id = self._record_id or chat_id
        if record_id is None:
            return
        pending = manager.drain_pending()
        if pending:
            await self._history_store.append_history(
                record_id, [entry_to_dict(entry) for entry in pending]
            )

    async def _plan_record_seeding(
        self, record_id: str, messages: list[LLMMessage]
    ) -> tuple[list[LLMMessage], int, int, dict[str, Any] | None]:
        """Plan how this run's seed joins the durable per-chat record.

        Returns ``(seed, first_seq, persisted_prefix, pre_boundary)``:

        - empty record → the host seed as-is, all of it flushes as new.
        - seed extends the durable projection exactly (projection-echoing
          hosts, tests) → seed as-is; only the tail past
          ``persisted_prefix`` flushes; seq continues the log.
        - seed reconciles with the record's host-visible view (production
          hosts rebuild a lossy per-turn view: final user/assistant texts
          only, assistant text display-transformed) → the run seeds from
          the RECORD's projection plus the host's new tail, so the model
          keeps the full history (tool rounds, injected fragments) and the
          record stays delta-only.
        - anything else (host edited/truncated history) → a declared
          ``host_revision`` boundary persists first, then the whole host
          seed flushes after it, keeping the durable projection coherent.
        """
        from .resume import load_history_items

        store = self._history_store
        assert store is not None  # caller guards on it
        latest = await store.list_history(record_id, limit=1, reverse=True)
        if not latest:
            return (messages, 0, 0, None)
        next_seq = int(latest[0].get("seq", 0)) + 1
        items = await load_history_items(store, record_id)
        if items:
            prior = [item.message for item in items]
            if list(prior) == messages[: len(prior)]:
                return (messages, next_seq, len(prior), None)
            new_tail = _reconcile_host_seed(items, messages)
            if new_tail is not None:
                return ([*prior, *new_tail], next_seq, len(prior), None)
            # W6-10: the direct reconcile failed. Before declaring a host
            # revision, see through the loop's OWN compactions — the host never
            # revised, it just reseeded the raw conversation while the record
            # holds a compacted projection. If the seed matches the
            # compaction-transparent host view, keep the compaction and append
            # only the genuinely-new tail (no double compression).
            see_through = await self._host_view_seeing_through_compactions(
                store, record_id
            )
            if see_through is not None:
                new_tail = _match_host_view(see_through, messages)
                if new_tail is not None:
                    return ([*prior, *new_tail], next_seq, len(prior), None)
        boundary = CompactionBoundary(
            seq=next_seq,
            reason="host revised history upstream of this run",
            action="host_revision",
        )
        return (messages, next_seq + 1, 0, entry_to_dict(boundary))

    async def _host_view_seeing_through_compactions(
        self, store: HistoryStore, record_id: str
    ) -> list[LLMMessage] | None:
        """The host-visible view with the loop's own compactions made transparent.

        Returns None when the record holds no loop compaction to see through —
        the caller then falls straight through to a ``host_revision`` exactly as
        before. Otherwise returns the reconstructed host view for the
        reconciliation fallback.
        """
        raw = await store.list_history(record_id)
        if not raw:
            return None
        entries = [entry_from_dict(r) for r in raw]
        if not any(
            isinstance(e, CompactionBoundary)
            and e.action in ("compact", "overflow_recovery")
            and e.replacement_count is not None
            for e in entries
        ):
            return None
        return _host_view_through_loop_compactions(entries)

    async def _execute_tool(self, call: ToolCall, ctx: LoopContext) -> ToolResult:
        """Run one tool call under the per-tool timeout.

        A timeout returns a failed ``ToolResult`` rather than raising, so the
        call flows through the normal result path (post_tool_result hooks,
        transcript append, consecutive-error breaker) like any other tool
        failure. The wrapped coroutine is cancelled on expiry; a remote
        executor's late reply is dropped by its own pending-call table (see
        ``JsonRpcServer._resolve_reverse_response``), so the turn is never
        blocked by a hung peer again.
        """

        # ask_user blocks until the user answers. The generic tool cap would
        # cancel that wait (default 5 minutes) and continue without an answer.
        if call.name == "ask_user":
            return await self._executor.execute(call, ctx)
        timeout_ms = self._effective_tool_timeout_ms()
        if timeout_ms is None:
            return await self._executor.execute(call, ctx)
        clock = ToolTimeoutClock()
        token = tool_timeout_clock.set(clock)
        task = asyncio.create_task(self._executor.execute(call, ctx))
        try:
            return await _await_tool_deadline(task, clock, timeout_ms / 1000)
        except TimeoutError:
            task.cancel()
            return ToolResult(
                success=False,
                error="tool_timeout",
                needsFollowup=True,
                data={
                    "timeout": True,
                    "timeoutMs": timeout_ms,
                    "message": _TOOL_TIMEOUT_MESSAGE.format(
                        name=call.name, timeout_ms=timeout_ms
                    ),
                },
            )
        finally:
            tool_timeout_clock.reset(token)

    def _effective_tool_timeout_ms(self) -> int | None:
        """Resolve the wall-clock cap for the tool about to run.

        Wrap-up uses ``wrap_up_tool_timeout_ms`` when set so a 1-hour bash
        cannot eat Harbor's remaining wait_for. ``wrap_up_hard_cap_ms`` is
        an absolute cap from run start (eval jobs only).
        """
        timeout_ms = self._config.tool_timeout_ms
        wrap_cap = self._config.wrap_up_tool_timeout_ms
        if self._wrap_up_active and wrap_cap is not None:
            timeout_ms = wrap_cap if timeout_ms is None else min(timeout_ms, wrap_cap)
        hard_cap = self._config.wrap_up_hard_cap_ms
        if hard_cap is not None:
            remaining = int(hard_cap - (time.monotonic() - self._run_started) * 1000)
            remaining = max(remaining, 1_000)
            timeout_ms = remaining if timeout_ms is None else min(timeout_ms, remaining)
        return timeout_ms

    async def run(
        self,
        messages: Sequence[LLMMessage],
        *,
        tools: list[dict[str, Any]] | None = None,
        chat_id: str | None = None,
    ) -> AsyncIterator[LoopEvent]:
        """Yield LoopEvents for one turn. Always uses the Rust CoreLoop."""
        from .native_bridge import run_native

        async for event in run_native(self, messages, tools=tools, chat_id=chat_id):
            yield event


_SOFT_TIMEOUT_NOTICE = (
    "[system notice] The time budget for this task is exhausted. Do NOT call "
    "any more tools. Summarize what you have done so far and produce the "
    "final answer now."
)

_SOFT_TIMEOUT_NOTICE_KEEP_TOOLS = (
    "[system notice] The time budget for this task is nearly exhausted. "
    "Wait for background jobs (`wait`). Write the required output files "
    "now with bash, write_file, or edit_file. If you already drafted "
    "those contents in this chat, write_file them to the named paths. "
    "If those files already exist and look complete, verify them — do "
    "not overwrite with a truncated copy. Hidden tests score those "
    "files, not this chat. Do not keep exploring."
)

#: Hard cap on before_completion-granted redos (discipline retries +
#: narration rounds) per run. Must cover DeliveryHooks empty-round retries
#: (6) plus missing-named-output retries (32), plus idle-stream cuts that
#: also go through before_completion. Hooks still bound themselves; this is
#: the defense-in-depth backstop so a faulty hook cannot spin forever.
_MAX_COMPLETION_REDOS = 32

#: Gaps longer than this between reasoning/content chunks are GLM silent
#: think (regex-chess ~48 min with no SSE) and do not count toward
#: ``idle_stream_timeout_ms``.
_IDLE_REASONING_GAP_SEC = 300.0

_DISCIPLINE_RETRY_NOTICE = (
    "[system notice] The previous reply described an intended action but did "
    "not actually issue any tool call. Either make the tool call now, or — "
    "if no tool is genuinely needed — give the final answer directly without "
    "open-ended phrasing."
)

_STREAM_CUT_NOTICE = (
    "[system notice] The previous reply was cut off mid-reasoning because it "
    "ran on without issuing a tool call. Do not resume that train of thought "
    "and do not re-derive it. Issue the next concrete tool call now — write "
    "the file, run the command, or check the result."
)

_NARRATION_REQUEST = (
    "[system notice] The task ended without a natural-language summary. Do "
    "NOT call any tools. Summarize what was done and what the tool results "
    "showed, and give the user a clear final answer now."
)


class SoftTimeoutNotice(ContextFragment):
    """The soft-timeout wrap-up ask as a marked, self-recognisable fragment."""

    content_kind = "loop.soft_timeout_notice"

    def __init__(self, body: str | None = None) -> None:
        self._body = body or _SOFT_TIMEOUT_NOTICE

    def body(self) -> str:
        return self._body

    @classmethod
    def type_markers(cls) -> tuple[str, str]:
        return ("[system notice] The time budget", "")


class DisciplineRetryNotice(ContextFragment):
    """The before_completion discipline correction as a marked fragment."""

    content_kind = "loop.discipline_retry_notice"

    def __init__(self, message: str | None = None) -> None:
        self._message = message or _DISCIPLINE_RETRY_NOTICE

    def body(self) -> str:
        return self._message

    @classmethod
    def type_markers(cls) -> tuple[str, str]:
        return ("[system notice] The previous reply", "")


class StreamCutNotice(ContextFragment):
    """Tells the model its stream was cut, so it does not resume the spiral.

    Without it the transcript just ends on the model's own truncated draft
    and the next request reads as "keep going". Codex marks an interrupted
    turn the same way; pi drops the aborted message outright.
    """

    content_kind = "loop.stream_cut_notice"

    def body(self) -> str:
        return _STREAM_CUT_NOTICE

    @classmethod
    def type_markers(cls) -> tuple[str, str]:
        return ("[system notice] The previous reply was cut off", "")


class NarrationRequest(ContextFragment):
    """The narration-round ask as a marked fragment (default or hook text)."""

    content_kind = "loop.narration_request"

    def __init__(self, message: str | None = None) -> None:
        self._message = message or _NARRATION_REQUEST

    def body(self) -> str:
        return self._message

    @classmethod
    def type_markers(cls) -> tuple[str, str]:
        return ("[system notice] The task ended", "")


_TOOL_TIMEOUT_MESSAGE = (
    "`{name}` produced no result within {timeout_ms}ms and was cancelled. Do "
    "not claim it succeeded; retry with different arguments, use a different "
    "tool, or continue without it."
)


async def _await_tool_deadline(
    task: asyncio.Task[ToolResult], clock: ToolTimeoutClock, timeout_s: float
) -> ToolResult:
    """Wait for a tool, freezing the deadline while approval is unanswered."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while True:
        if clock.suspended:
            resume = asyncio.create_task(clock.resumed.wait())
            done, _pending = await asyncio.wait(
                {task, resume}, return_when=asyncio.FIRST_COMPLETED
            )
            resume.cancel()
            if task in done:
                return task.result()
            continue
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError
        pause = asyncio.create_task(clock.paused.wait())
        done, _pending = await asyncio.wait(
            {task, pause}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
        )
        pause.cancel()
        if task in done:
            return task.result()


def _honors_forced_tool_choice(provider: LLMProvider, tool_choice: str) -> bool:
    """Whether ``tool_choice`` survives to the wire on this provider.

    Only ``required`` is ever downgraded, so any other value is honored by
    definition. The capability is duck-typed like ``on_stream_chunk``: a
    provider that does not publish ``honors_forced_tool_choice`` is taken at
    its word, since the downgrade is a vendor quirk the adapter owns.
    """
    if tool_choice != "required":
        return True
    honors = getattr(provider, "honors_forced_tool_choice", None)
    return bool(honors()) if callable(honors) else True


def _apply_rewrite(manager: ContextManager, rewrite: RewriteRequest) -> None:
    """Apply one declared rewrite to the record.

    When the rewrite carries a region-transaction bracket (a paid summary
    backed it), the bracket's start/summary entries land BEFORE the
    boundary so the durable record holds the complete, ordered triplet —
    a crash between the summarizer call and the rewrite still leaves the
    paid summary attributable by ``compaction_id`` (P1).
    """
    if rewrite.bracket is not None:
        manager.record_compaction_start(
            compaction_id=rewrite.bracket.compaction_id,
            reason=rewrite.reason,
            action=rewrite.action,
            span_start_index=rewrite.bracket.span_start_index,
            span_end_index=rewrite.bracket.span_end_index,
            pre_tokens=rewrite.pre_tokens,
        )
        manager.record_compaction_summary(
            compaction_id=rewrite.bracket.compaction_id,
            summary_text=rewrite.bracket.summary_text,
        )
    manager.replace_all(
        rewrite.messages,
        reason=rewrite.reason,
        action=rewrite.action,
        pre_tokens=rewrite.pre_tokens,
        post_tokens=rewrite.post_tokens,
        compaction_id=(
            rewrite.bracket.compaction_id if rewrite.bracket is not None else None
        ),
    )


def _is_host_visible(item: HistoryItem) -> bool:
    """The host-visible kinds: bare system/user plus terminal assistant
    messages (tool-call rounds are loop-internal)."""
    return (
        item.kind in (KIND_SYSTEM, KIND_USER)
        or (item.kind == KIND_ASSISTANT and not item.message.tool_calls)
    )


def _host_view_through_loop_compactions(
    entries: list[HistoryItem | CompactionBoundary | HistorySeed],
) -> list[LLMMessage]:
    """The host-visible conversation, seeing through the loop's OWN compactions.

    A ``compact`` / ``overflow_recovery`` boundary is the loop compressing its
    own record — the host never revised anything and still holds the raw
    pre-compaction conversation. The rewrite that follows such a boundary
    (head + summary marker + tail, ``replacement_count`` messages) re-states
    content the host already has, so it is skipped: the view stays the host's
    full conversation and the next raw seed reconciles instead of declaring a
    spurious ``host_revision`` that would discard the compaction (W6-10).

    A ``host_revision`` boundary is a genuine host edit — the pre-boundary
    span is dropped (the view resets), matching the post-boundary projection.
    Boundaries without a ``replacement_count`` (older records) are opaque and
    reset the view the same way, preserving the pre-W6-10 behavior.
    """
    view: list[LLMMessage] = []
    i = 0
    n = len(entries)
    while i < n:
        entry = entries[i]
        if isinstance(entry, CompactionBoundary):
            if (
                entry.action in ("compact", "overflow_recovery")
                and entry.replacement_count is not None
            ):
                # See through the loop's own compaction: skip the rewrite.
                i += 1 + entry.replacement_count
                continue
            # host_revision or an opaque (legacy) boundary: the visible span
            # restarts here.
            view = []
            i += 1
            continue
        if isinstance(entry, HistorySeed):
            for message in entry.messages:
                if message.role in ("system", "user") or (
                    message.role == "assistant" and not message.tool_calls
                ):
                    view.append(message)
        elif _is_host_visible(entry):
            view.append(entry.message)
        i += 1
    return view


def _reconcile_host_seed(
    items: list[HistoryItem], seed: list[LLMMessage]
) -> list[LLMMessage] | None:
    """Reconcile a production host's per-turn seed against the record.

    Hosts rebuild history from their own store each turn: final
    user/assistant texts only (no tool rounds, no loop-injected
    fragments), with assistant text display-transformed (trimmed, host
    sections appended). The seed reconciles when its history part matches
    the record's host-visible view — bare ``system``/``user`` kinds plus
    terminal assistant messages (tool-call rounds are loop-internal) —
    comparing user/system text exactly and assistant text up to a
    host-appended suffix. Returns the seed's new tail on match; None means
    the history genuinely changed (edit/truncate/regenerate) and the
    caller declares a ``host_revision`` boundary.
    """
    host_view = [item.message for item in items if _is_host_visible(item)]
    return _match_host_view(host_view, seed)


def _match_host_view(
    host_view: list[LLMMessage], seed: list[LLMMessage]
) -> list[LLMMessage] | None:
    """Match a host seed's history part against a host-visible view.

    The seed reconciles when its leading ``len(host_view)`` messages match the
    view — user/system text exactly, assistant text up to a host-appended
    suffix. Returns the seed's new tail on match; None on a genuine divergence.
    """
    if len(seed) <= len(host_view):
        return None
    history_part, new_tail = seed[: len(host_view)], seed[len(host_view) :]
    for expected, actual in zip(host_view, history_part):
        if expected.role != actual.role:
            return None
        want = expected.content_text.strip()
        got = actual.content_text.strip()
        if expected.role == "assistant":
            if got != want and not (want and got.startswith(want)):
                return None
        elif got != want:
            return None
    return list(new_tail)
