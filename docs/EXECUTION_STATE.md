# Execution State, Authority and Intent-safe Resume

## 1. Scope

`src/core/execution/` — authoritative clone/worktree-local execution state layer.

Baseline:

- Harness release: `0.10.4`;
- template commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- parity case: `PARITY-EXECUTION-007`;
- thin architecture change: `THIN-001`.

Legacy `.harness/local/**` не используется.

## 2. Storage

Git-private root разрешается только через:

`git rev-parse --git-path ai-harness`

Execution state:

`<git-private-ai-harness>/execution/execution-status.json`

Это делает state:

- clone/worktree-scoped;
- untracked;
- совместимым с linked worktrees;
- независимым от предположения, что `.git` — обычная директория.

## 3. Schema v2

State содержит:

- `executions[]` — full active/recoverable records;
- `stepRecovery{}` — STEP implementation baselines;
- `recentTerminals[]` — bounded compact tombstones;
- `nextOrdinal` — strictly monotonic invocation ordinal.

Modes:

- `single`;
- `chain`;
- `orchestration`.

Execution status:

- `running`;
- `complete`;
- `blocked`.

Command results:

- `SUCCESS`;
- `PASS`;
- `FAIL`;
- `BLOCKED`.

## 4. Bounded state

Hard bounds:

- terminal tombstones: 100;
- `current.details`: 16 KiB UTF-8 JSON;
- Intent Basis: 16 KiB UTF-8 JSON;
- progress telemetry samples: 8.

Execution state не является audit log. Durable proof должен жить в canonical project artifacts/reports.

## 5. State authority

Semantic runtime предлагает результат, но не commit-ит cursor самостоятельно.

Commit boundary:

`completeCurrent(..., expectedExecutionId)`

Result принимается только если `expectedExecutionId` всё ещё владеет current active invocation.

Иначе Core возвращает:

`STALE_SEMANTIC_RESULT`

Одинаковые command/rootCommand новой invocation не дают старому semantic result права изменить state.

## 6. Explicit invocations

Каждый новый явный user input создаёт root execution.

Исключение: повтор exact root command при `running` execution считается resume этой же invocation и увеличивает attempt.

Новая независимая command не перезаписывает старую interrupted invocation.

## 7. Chains

Explicit chain проходит только через уже extracted CTS.

После completion current segment Core использует exact transition edge и `onPreviousResult`.

Если edge condition не выполнен:

- оставшиеся segments становятся `notExecuted`;
- root execution завершается.

Cross-domain/invalid chains отбрасываются protocol parser до создания state.

## 8. STEP RUN orchestration

`STEP RUN STEP-NNN` — orchestration mode.

Deterministic cycle:

`PLAN → IMPLEMENT → REVIEW → (PASS | FIX → REVIEW)`

`maxFixReviewCycles` берётся из project config и сохраняется в execution record, поэтому restart не сбрасывает budget.

## 9. STEP recovery baseline

При начале `STEP IMPLEMENT` Core сохраняет:

- STEP id;
- exact Git HEAD;
- capture timestamp;
- source executionId.

Baseline находится в `stepRecovery` и также передаётся в current command context.

Дальнейшая review/completion semantics использует этот fact через #37.

## 10. Intent Basis

Intent-aware operations:

- `STEP PLAN`;
- `STEP IMPLEMENT`;
- `STEP REVIEW`;
- `STEP FIX`.

Snapshot v1 хранит:

- STEP id;
- normalized command/operation;
- schema-v4 planning context basis;
- component fingerprints;
- optional plan content hash;
- plan revision;
- capture timestamp.

`IMPLEMENT/REVIEW/FIX` bind-ятся к plan content hash.

`PLAN` намеренно **не** bind-ится к собственному output plan hash.

## 11. Resume comparison

На resume stored basis не пересчитывается и не перезаписывается.

Core повторно вычисляет current canonical fingerprints и сравнивает их со stored snapshot.

Blockers:

- `INTENT_BASIS_STALE`;
- `TASK_CONTRACT_CHANGED`;
- `ARCHITECTURE_BASIS_CHANGED`;
- `PLAN_BASIS_STALE`;
- `INTENT_BASIS_MISSING`;
- `INTENT_BASIS_SCHEMA_UNSUPPORTED`;
- `INTENT_BASIS_INVALID`;
- `INTENT_BASIS_UNAVAILABLE`.

Canonical remediation для stale STEP intent:

`STEP PLAN STEP-NNN`

Unrelated files не входят в planning basis и не создают false stale.

## 12. Shared write concurrency model

Все execution-state read-modify-write transactions используют `CoreWriteLock`.

Migration execution #25/#26 также проходит через этот shared lock, сохраняя свой migration-specific recovery lease поверх него.

Таким образом migration и ordinary Core execution не могут одновременно mutation-ить один worktree scope через несовместимые lock models.

Shared lock также хранится в Git-private `ai-harness`.

## 13. Atomicity

Mutation flow:

1. acquire Core write lock;
2. load + validate state;
3. mutate in memory;
4. validate resulting state;
5. write temporary file + fsync;
6. atomic rename;
7. release lock.

Повреждённый JSON/schema никогда не трактуется как empty state.

## 14. Project State integration

`unresolvedExecutionFacts()` реализует provider boundary #34.

PROJECT STATUS / STEP NEXT могут учитывать:

- `RESUME`;
- `NEXT`;

без чтения chat history и без повторного парсинга execution JSON на UI layer.

## 15. Requirements

- `CLI-REQ-053`–`CLI-REQ-056`;
- `CLI-REQ-145`–`CLI-REQ-148`;
- `CLI-REQ-223`;
- `CLI-REQ-240`–`CLI-REQ-253`.
