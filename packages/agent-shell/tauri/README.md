# Steerable Tauri host

Reusable native desktop host shipped inside the `@steerable/agent-shell` npm
package. Consuming products keep a thin `src-tauri` crate that supplies Tauri
configuration and calls `steerable_agent_shell_tauri::run`.

The host supervises the product's compiled Node BS entry on an ephemeral
loopback port. Node continues to own storage, PTY, tools, approvals, packs,
and CoreLoop sidecars. Rust owns the native window, menus, dialogs,
single-instance behavior, screenshot clipboard transfer, process containment,
resource paths, and updates.

The crate is source-distributed with the npm package and is not published to
crates.io.

Packaged products place the verified Rust sidecar and egress proxy at
`engine/steerable-sidecar` and `engine/steerable-egress-proxy`. An optional
`engine/python-runner` is only a child interpreter for `run_code`; it never
hosts the sidecar. Products may set `pythonRunner` to `bundle` or `download`
in `product.json`. Download mode uses the packaged lock and installer,
verifies SHA-256 before an atomic install under the product data directory,
and passes the resulting absolute executable as `STEERABLE_PYTHON`.
