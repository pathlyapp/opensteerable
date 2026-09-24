# Integration testing

This guide covers public-package and local-checkout integration without
assuming access to any private consumer repository.

## Published-package mode

Use released npm and PyPI packages when validating the installation users
receive:

```bash
pnpm install --frozen-lockfile
uv sync --frozen
pnpm build
pnpm test
uv run pytest
```

The native CoreLoop wheel version is selected by
[`rust-artifacts.lock.json`](rust-artifacts.lock.json). Downloaded sidecar and
egress binaries are verified against the pinned bundle manifest.

## Local-checkout mode

For changes spanning several workspace packages, install from this checkout
and build generated artifacts before starting a consumer:

```bash
pnpm install --frozen-lockfile
pnpm gen
pnpm build
uv sync
```

Use package-manager workspace or editable-source overrides in the consumer.
Do not commit machine-specific absolute paths or private registry credentials.

## Sidecar validation

```bash
uv run --package steerable-example-sidecar-roundtrip \
  python -m steerable_example_sidecar_roundtrip.main

python scripts/fetch_verified_artifacts.py sidecar \
  --artifact-lock --target host --out dist/sidecar-bin
python scripts/fetch_verified_artifacts.py smoke-sidecar \
  --artifact-lock --binary dist/sidecar-bin/steerable-sidecar-bin-*
```

For a complete embedded runtime:

```bash
python packages/sidecar/build/build_sidecar.py --target host
```

## Public compatibility gates

Run these before publishing:

```bash
python scripts/check_lockstep_versions.py
python scripts/check_no_public_coreloop_source.py
pnpm check:drift
uv run python scripts/check_drift.py
```

Public contributors do not need a private checkout; CI runs all public gates
independently.

## Credentials

Tests read credentials only from environment variables or GitHub Secrets.
Never place tokens in commands, fixtures, screenshots, issue comments or
committed `.env` files. Prefer registry Trusted Publishing over long-lived
upload tokens.

## Reference applications

- `examples/web-shell/` exercises the UI with synthetic fixtures.
- `examples/sidecar-roundtrip/` exercises JSON-RPC sidecar startup and ping.
- `tests/conformance/` verifies generated TypeScript and Python contracts.

Synthetic fixtures under `spec/blocks/fixtures/` must not contain customer
names, production data, personal paths or raw model transcripts.
