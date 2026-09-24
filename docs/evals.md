# Evaluations

OpenSteerable publishes aggregate evaluation results to make runtime changes
reviewable without publishing credentials, raw model transcripts, private
gateway details or internal run archaeology.

## Method

- **Benchmark:** Terminal-Bench 2.1 through Harbor.
- **Catalog:** the pinned task IDs in
  [`evals/suite.yaml`](https://github.com/pathlyapp/opensteerable/blob/main/evals/suite.yaml).
- **Scoring:** Harbor verifier reward; infrastructure errors count as failures
  unless a report explicitly excludes them.
- **Attempts:** every published score states the number of attempts per task.
- **Timeouts:** every report states the agent timeout and job-level timeout.
- **Runtime:** the exact OpenSteerable and Rust artifact versions are recorded.
- **Model:** provider, model identifier, reasoning effort and sampling controls
  are recorded without exposing endpoints or credentials.

## Public score of record

The current release gate is the complete 89-task catalog on
GLM-5.3-Flash using the Rust CoreLoop. The last accepted aggregate score was
**79.0%**. Treat this as a harness-and-model result, not a model-only
benchmark: provider protocol, timeout policy, tool surface and runtime version
all affect the score.

The low-cost `cheap-12` split runs more frequently as a regression signal. It
is not comparable to the full catalog and must not be presented as the score
of record.

## Reproducibility requirements

A public result is complete only when it records:

1. OpenSteerable commit or release tag.
2. `rust-artifacts.lock.json` artifact version.
3. Harbor and Terminal-Bench versions.
4. Model identifier and request protocol.
5. Task split and exact task count.
6. Attempts per task, concurrency and timeout policy.
7. Pass, fail and infrastructure-error counts.
8. Aggregate token usage when available.

Raw requests, responses and task workspaces may contain user data, credentials
or licensed benchmark material and are not committed to this repository.

## Running evaluations

See [`evals/README.md`](https://github.com/pathlyapp/opensteerable/blob/main/evals/README.md)
for local and CI commands. Run the
full catalog only when collecting release evidence; use the oracle and
`cheap-12` splits for routine validation.
