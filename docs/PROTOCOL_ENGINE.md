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

Stale semantic completion is rejected **before** `commitSemanticProposal` is invoked. Core reloads the active execution, verifies the exact `executionId`, canonical root command and current command, and supplies the trusted execution context to the commit boundary. The caller-returned completion DTO cannot contain context, skill, reasoning metadata or transition state. The execution-state service still performs its exact `expectedExecutionId` check as a second line of defense.

## Runtime boundary

Codex/Claude and other AI runtimes are external callers. Their process lifecycle, auth, model/effort and SDKs are intentionally outside Harness CLI/Core; the engine exposes only deterministic state coordination and semantic handoff/result boundaries.


## External caller machine boundary v1

Stage 5 exposes the pinned release-owned engine through the Core Host API operation:

`protocol/external-call`

The CLI transport is:

`harness protocol machine`

It reads exactly one bounded JSON request from stdin and emits one machine-readable JSON response.

### Start

```json
{
  "schemaVersion": 1,
  "operation": "start",
  "command": "STEP PLAN STEP-024"
}
```

The result is a deterministic terminal/blocker or a `semantic-handoff`.

### Resume

```json
{
  "schemaVersion": 1,
  "operation": "resume",
  "rootCommand": "STEP RUN STEP-024"
}
```

Resume uses the existing Git-private execution state. No runtime process identifier or runtime SDK appears in the contract.

### Semantic completion

```json
{
  "schemaVersion": 1,
  "operation": "semantic-complete",
  "completion": {
    "schemaVersion": 1,
    "executionId": "exec-...",
    "rootCommand": "PROJECT QUICK FIX: example",
    "command": "PROJECT QUICK FIX: example"
  },
  "proposal": {
    "schemaVersion": 1,
    "result": "SUCCESS",
    "details": {}
  }
}
```

The completion identity deliberately contains no handoff context. Core reloads the current execution and treats proposal content as untrusted input before committing the command result and transition.

The immutable release ships JSON Schemas for:

- `schemas/semantic-handoff.schema.json`;
- `schemas/external-caller-request.schema.json`;
- `schemas/semantic-proposal.schema.json`.

## Explicit non-goals

This boundary does not launch, select, authenticate, configure, cancel, supervise or resume an AI runtime process. Claude Code, Codex and other runtimes remain independent external callers.
