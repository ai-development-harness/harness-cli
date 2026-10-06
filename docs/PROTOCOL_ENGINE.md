# ProtocolEngine / Dispatcher

Issue #40 introduces an application-neutral coordinator over the extracted Harness Core domains.

## Authority boundary

The ProtocolEngine owns command coordination, never model execution:

1. validate command text and CTS structure;
2. create/resume the exact execution through the execution-state service;
3. evaluate transition runtime preconditions;
4. dispatch `reasoning.mode=none` commands to deterministic Core handlers;
5. use a proven conditional fast path when one is available;
6. otherwise return a typed semantic handoff;
7. accept semantic output only as an untrusted proposal;
8. commit that proposal through the supplied Core commit boundary;
9. commit the resulting command result to execution state with the exact `executionId`;
10. continue explicit chains / STEP RUN until the next handoff, blocker, or terminal result.

A semantic runtime therefore cannot advance execution state directly.

## Semantic handoff v1

The handoff contains the exact:

- `executionId`;
- root command and current canonical command;
- domain / operation / target / input;
- required skill;
- optional context phase;
- reasoning mode;
- execution context captured by Core.

The runtime returns only a proposal. `commitSemanticProposal` is responsible for deterministic validation/writes and returns the trusted command result used by `completeCurrent`.

## Deterministic paths

Commands classified as `reasoning.mode=none` never require a semantic runtime.

Conditional commands can expose a Core fast path. This preserves the v0.10.4 behavior where, for example, a proven Git transition can continue without an additional model invocation.

`STEP RUN` is treated as an orchestration root: its first action is resolved by the execution-state service, so the engine proceeds to `STEP PLAN` rather than handing `STEP RUN` itself to a model for ordinary coding-step orchestration.

## Fail-closed behavior

The engine blocks on:

- structural parser / CTS failures;
- missing runtime-precondition provider;
- failed runtime preconditions;
- blocked or missing execution state;
- engine step-limit exhaustion.

Stale semantic completion remains protected by the execution-state service's exact `expectedExecutionId` ownership check.

## Runtime boundary

Codex/Claude adapters, Commander presentation, GUI and transport are intentionally outside this module.
