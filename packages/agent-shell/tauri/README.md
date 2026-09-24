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
