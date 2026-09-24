# @steerable/agent-shell

Product-neutral Node HostRuntime and headless HTTP host for Steerable Framework.

## Desktop composition

Tauri desktop products supervise the same BS executable used by browser mode,
bind it to an ephemeral loopback port, and load its web UI in a WebView. The
renderer uses `HostBridge`: HTTP/SSE carries agent, storage, PTY, approval,
attachment, and pack traffic; narrow Tauri commands provide native dialogs,
menus, screenshots, and updates. `STEERABLE_HOST_READY` on stdout is the
machine-readable startup record. `STEERABLE_HOST_PARENT_PID` makes the Node
host shut down if its desktop supervisor disappears.

The reusable Rust host source is published as
`@steerable/agent-shell-tauri`. Product `src-tauri` crates depend on its
installed npm path and only supply product configuration plus
`tauri::generate_context!()`.

## BS composition

Products can register an `AuthProvider` from `@steerable/agent-shell/auth`
before starting the host. A registered provider authenticates every
`/api/v2/*` and `/host/*` request and supplies the request `Principal`.
Without a provider, the host retains its loopback Host check and
per-process Bearer token.

Use `startBsHost` from `@steerable/agent-shell/server/start` to embed the BS
host. Its options support host and port selection, a fixed Bearer token, and
ordered middleware. Middleware returns `pass` to continue or `handled` to
short-circuit. The returned handle owns shutdown of both HTTP and runtime
services.

## Storage drivers

Storage drivers register during product composition and initialize after all
scenario-pack migrations and seeds are registered. `initializeStorage()` must
complete before `getScopedStore(scope)` or `getPackDbAccess(scope)` is used.
The default `SqliteStorageDriver` preserves the local database path, migration
sequence, seed behavior, and write lease.

Host repositories use the async `ScopedStore` API. Scenario packs receive
`PackDbAccess`, which carries `tenantId` and `userId` and does not expose the
driver connection. Because arbitrary SQL cannot be rewritten safely,
pack repositories must include both ownership columns in every statement;
the SQLite and MySQL access objects reject missing or mismatched ownership,
and pack boundary checks enforce the same requirement before runtime.

License: Apache-2.0.
