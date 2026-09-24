# CoreLoop specification

`CoreLoop` is the single-agent think → act → observe loop exposed by
`steerable-agent-runtime`. The public Python API delegates execution to the
native CoreLoop wheel selected by `rust-artifacts.lock.json`.

## Scope

CoreLoop owns one agent turn and its tool rounds:

- stream one or more model requests;
- assemble content, reasoning and tool-call deltas;
- execute registered tools through `ToolExecutor`;
- apply configured hooks and round controls;
- emit structured `LoopEvent` values;
- finish with completion, budget, timeout or error state.

Multi-agent planning, DAG scheduling, product UI and business workflows remain
above the loop.

## Public layers

```text
host application
  ├─ product hooks and ToolExecutor handlers
  ├─ transport projection (SSE, JSON-RPC, AG-UI, ACP)
  └─ steerable-agent-runtime CoreLoop facade
       └─ steerable-agent-runtime-native
```

The loop emits structured events rather than encoded wire bytes. Transport
adapters render those events for each protocol.

## LoopEvent

The stable public event kinds are recorded in
[`runtime-contract.json`](runtime-contract.json) and verified in CI. They cover:

- lifecycle and completion;
- content and reasoning deltas;
- model request/response observations;
- tool start, result and error;
- budget and timeout control;
- steering and hook actions.

Payloads may carry extension fields. Consumers must ignore unknown fields so
new optional metadata does not break older transports.

## ToolExecutor

Tools execute through one product-supplied port:

```python
class ToolExecutor(Protocol):
    async def execute(
        self, call: ToolCall, ctx: LoopContext
    ) -> ToolResult: ...
```

The loop owns cross-cutting mechanics such as tool-call assembly, deduplication,
timeouts, cancellation and result persistence. Hosts own concrete shell, file,
MCP and application tool handlers.

Executors may expose `concurrency_safe(call) -> bool`; when parallel tools are
enabled, only calls declared safe may overlap.

## Hooks

`LoopHooks` provides bounded extension points:

- `pre_step`
- `post_tool_result`
- `on_request_error`
- `before_completion`
- `on_stream_chunk`
- `tool_made_progress`

The exact public method set is frozen by `runtime-contract.json`. Hooks can
observe or return documented actions; they must not rewrite prior history.

## Configuration

`LoopConfig` controls round limits, error thresholds, tool deduplication, tool
timeouts, soft timeouts and wrap-up behavior. Defaults are conservative and
all time and size limits are bounded.

Tool timeout and loop soft timeout are distinct:

- tool timeout converts a hung invocation into a failed `ToolResult`;
- soft timeout is evaluated at round boundaries and requests wrap-up.

## History and cancellation

The native engine synchronizes its resulting history through the public bridge.
Cancellation stops further model/tool work and emits a terminal state without
silently discarding already observed output.

Context is incremental: new fragments append to history; previous entries are
not rewritten. Large tool results are persisted or truncated according to
configuration before entering model context.

## Native compatibility

The selected native module must:

1. import successfully;
2. expose `run_turn`;
3. report the expected `CORELOOP_API_VERSION`;
4. match the exact artifact version pinned by the Python package and lockfile.

Failure is an installation or compatibility error. There is no Python CoreLoop
fallback.

The repository publishes the facade, contracts and black-box compatibility
tests. The native implementation source is not included in this repository.
