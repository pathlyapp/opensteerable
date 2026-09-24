# Engine compatibility

Steerable publishes the framework source and consumes a separately built,
source-unavailable Rust engine. `rust-artifacts.lock.json` is the reviewed pin
for one immutable engine bundle; its manifest digest authenticates the native
CoreLoop wheel, Rust sidecar and egress proxy downloaded by the framework.
The lock also records the engine license identifier; the corresponding Release
contains the complete terms.

## Compatibility identifiers

The framework-to-engine interface has three independently versioned parts:

- `coreloopApi` identifies the PyO3 API used by
  `steerable_agent_runtime.native_bridge`.
- `sidecarProtocol` identifies the JSON-RPC protocol implemented by both
  sidecars.
- `egressCli` identifies the egress proxy command-line and control endpoint
  interface.

The values appear in both `rust-artifacts.lock.json` and
`docs/spec/runtime-contract.json`. `scripts/check_engine_compatibility.py`
requires those files to match and also checks the CoreLoop and sidecar values
against their public runtime constants. CI and framework release validation run
this check.

An engine release increments only the identifier whose interface changed.
Framework code may adopt a new bundle without changing its own package version,
but the adoption change must update the lock file, native wheel pins and runtime
contract together.

## Artifact adoption

Run:

```bash
python scripts/use_rust_artifacts.py X.Y.Z
python scripts/check_engine_compatibility.py
```

The adoption script verifies the bundle manifest and component hashes before it
updates the lock file. A framework release never builds the engine from source.
