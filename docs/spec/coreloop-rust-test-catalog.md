# CoreLoop Rust migration test catalog

Machine-readable source: [`coreloop-rust-test-catalog.json`](coreloop-rust-test-catalog.json).
Gates are executable: framework pytest and deeppath-agent vitest fail if a listed **existing** path is missing, if the PyO3 import surface drifts, or if a product `pythonRuntime` does not match the catalog.

**P0** blocks the matching plan stage or product ship. **P1** is required for Harbor catalog evidence on the Rust-only engine. Replay fixtures (`test_replay_crosslang`) are not a loop gate.

## Why this catalog exists

Rust CoreLoop must keep three consumers working without a product rewrite:

1. **deeppath-api** in-process via PyO3 (`async for event in loop.run(...)`).
2. **Desktop sidecar** over the current JSON-RPC stdio methods and sessions db write lease.
3. **Three frontend agents** — aroli, ciflog, etown — each with a different CPython policy.

## P0 by plan stage

| Stage | P0 evidence | Not a substitute |
| --- | --- | --- |
| API surface | `test_pyo3_api_surface.py` | A larger `__all__` dump |
| Loop / RPC / events | same + `test_rpc_method_contract.py` | Spec prose without a test |
| Rust loop MVP | `test_loop.py` / `test_golden.py` / `test_harness.py` / cancel / steer, against the published native wheel | Cross-language replay reducer |
| LLM providers | `test_llm_*_wire.py`, presets, model_resolve | Golden chat text |
| Sidecar binary | published sidecar `system.ping` smoke plus `test_sidecar_coreloop.py`, `test_sidecar_methods.py`, write-lease | Health ping only |
| Egress + sandbox | `egress-proxy/rs` tests + `supervisor-sandbox.test.ts` + agent `sandbox-posture` / `egress-widening` e2e | Packing without a Python runtime |
| Built-in tools | `test_tool_contract.py` + web/run_code/ptc e2e | A contract file that does not match the wheel |
| Per-product CPython | `tests/python-runtime.test.ts` | Skipping sidecar for aroli before Rust egress/sandbox |
| PyO3 wheel | `test_pyo3_api_surface.py` (`run_turn` on `steerable_agent_runtime_native`) | A missing native wheel or a silent fallback |
| Harbor | [evals.md](../evals.md) 79.0% catalog | A single cheap-12 smoke |

## P0 frontend agents

| Product | `pythonRuntime` (target) | Shipping CPython until `STEERABLE_RUST_SIDECAR=1` | P0 command |
| --- | --- | --- | --- |
| **aroli** | `none` | still bundled | `pnpm test` + `tests/ui/product-smoke.spec.ts` |
| **ciflog** | `bundle` | bundled | `pnpm test:cflog-e2e` + product-smoke with `APP_FLAVOR=ciflog` |
| **etown** | `bundle` | bundled | `tests/etown/*` + product-smoke with `APP_FLAVOR=etown` |

Aroli `none` is the **target**. Packing still prepares `python-runtime` until the Rust sidecar flag is on, because today's loop, egress proxy, and sandbox still need CPython.

Three-product regression from deeppath-agent:

```bash
pnpm test:products
```

## Dual-track rule

Rust is the only CoreLoop engine. This public repository checks that engine through the published wheel, the public facade, and the black-box tests below. New loop behavior lands in the P0 scripted-provider tests first. Historical Python Harbor numbers stay in [evals.md](../evals.md) as a superseded baseline only.
