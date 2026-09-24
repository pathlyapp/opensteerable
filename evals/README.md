# Coding-agent evaluations

OpenSteerable uses pinned Terminal-Bench 2.1 task sets through
[Harbor](https://www.harborframework.com/docs/run-jobs/run-evals). The suite
definition is [`suite.yaml`](suite.yaml); aggregate public results and
methodology live in [`docs/evals.md`](../docs/evals.md).

## Agents

| Agent | Harbor adapter | Default model |
| --- | --- | --- |
| `oracle` | Harbor `oracle` | none |
| `steerable` | `evals.harbor_steerable:SteerableHarborAgent` | configurable OpenAI-compatible model |
| `claude-code` | Harbor `claude-code` | configured by Harbor |
| `codex` | Harbor `codex` | configured by Harbor |
| `pi` | Harbor `pi` | configured by Harbor |

Credentials are supplied only through environment variables or GitHub
Secrets. The repository contains no evaluation credentials or private
gateway endpoints.

## Commands

```bash
uv tool install harbor==0.22.0

python -m evals.run --agent oracle --split cheap-12 --dry-run
python -m evals.run --agent oracle --split oracle-canary --require-mean 1.0
python -m evals.run --agent steerable --split oracle-canary
python -m evals.run --agent steerable --split cheap-12
python -m evals.run --agent pi --split cheap-12
python -m evals.run --agent codex --split cheap-12 --tasks fix-git
```

`cheap-12` is the low-cost regression gate. `catalog` is the complete public
task set and is intended for explicit release evidence rather than every pull
request. `flaky` and `loss-34` are diagnostic splits; they are not release
scores.

## Native wheel setup

Harbor tasks may use glibc or musl containers. Download both verified native
wheels selected by [`rust-artifacts.lock.json`](../rust-artifacts.lock.json):

```bash
python scripts/fetch_verified_artifacts.py wheel \
  --artifact-lock --platform manylinux-x64 --out dist/native
python scripts/fetch_verified_artifacts.py wheel \
  --artifact-lock --platform musllinux-x64 --out dist/native

export STEERABLE_NATIVE_WHEEL="$(
  python -c 'from pathlib import Path; print(next(p for p in Path("dist/native").glob("*.whl") if "manylinux" in p.name and "musllinux" not in p.name).resolve())'
)"
export STEERABLE_NATIVE_WHEEL_MUSL="$(
  python -c 'from pathlib import Path; print(next(Path("dist/native").glob("*musllinux*.whl")).resolve())'
)"
```

The adapter fails before a paid model run when the required wheel is missing
or its digest does not match the public artifact manifest.

## Result handling

Local job output is written under `evals/jobs/`, which is gitignored. Do not
commit raw model transcripts, request recordings, credentials, customer data,
or private gateway details. Public reports should contain aggregate scores,
the model and protocol configuration, task-set version, attempt count and
timeout policy.

## CI layers

| Layer | Trigger | Purpose |
| --- | --- | --- |
| Unit | every pull request | evaluation and adapter tests without Docker |
| Oracle smoke | eval-related pull requests | verify Harbor/task installation |
| Weekly | schedule or manual dispatch | low-cost multi-agent comparison |
| Catalog | manual dispatch | release-grade aggregate evidence |
