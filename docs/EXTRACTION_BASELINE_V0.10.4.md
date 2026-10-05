# Extraction baseline: Harness v0.10.4

Этот документ фиксирует behavioral baseline для Stage 4 — выделения release-owned Harness Core.

Baseline относится **не к плавающему `main`**, а к точному upstream snapshot:

- repository: `ai-development-harness/ai-development-harness-template`;
- commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- Harness release: `0.10.4`.

Machine-readable fixture: `test/fixtures/extraction-baseline-v0.10.4.json`.

Regression guard: `test/extraction-baseline.test.ts`.

## Зачем нужен baseline

Stage 4 переносит semantics Harness из template repository в устанавливаемый Core. Поэтому единицей сравнения является не Python-файл и не каталог `.harness/tools`, а наблюдаемый protocol contract:

- canonical command surface;
- CTS и result-gated transitions;
- authority/reasoning boundaries;
- artifact/report contracts;
- project state/projections;
- planning/context contracts;
- execution/recovery;
- verification/review/completion/convergence;
- Git safety и side-effect recovery;
- update semantics;
- runtime-adapter contract.

Последующие extraction PR должны ссылаться на `PARITY-...` case IDs из fixture.

## Snapshot summary

- **32** canonical commands;
- **7** command domains: PROJECT, STEP, SKILL, GITHUB, RELEASE, HARNESS, GIT;
- **42** discoverable `*-self-test.py`;
- command validation order: `tokenize → normalize → transition-table → runtime-preconditions → dispatch`;
- semantic result остаётся proposal; authoritative mutations принадлежат deterministic dispatcher/writer/action layers.

## Command domains

| Domain | Commands | Explicit transitions |
|---|---:|---:|
| PROJECT | 4 | 0 |
| STEP | 10 | 4 |
| SKILL | 3 | 0 |
| GITHUB | 1 | 0 |
| RELEASE | 1 | 0 |
| HARNESS | 7 | 1 |
| GIT | 6 | 5 |

Полный каталог canonical spelling, dispatch/reasoning mode, target/input shape и chain eligibility хранится в machine-readable fixture.

## Artifact/state inventory

Canonical project artifacts:

- REQ;
- ADR;
- STEP;
- OQ;
- PRN.

Durable proof/report surfaces включают implementation review, planning review, INIT review, audit/reconcile/migration, RELEASE CHECK и SKILL FIND reports.

Tracked projections остаются **производными**: roadmap, project status, requirements projections и Open Questions index не становятся вторым source of truth.

Operational execution state фиксируется отдельно от canonical artifacts и должен сохранять v0.10.4 state-authority/resume semantics после extraction.


Execution Status baseline отдельно фиксирует:

- schema v2;
- modes `single | chain | orchestration`;
- execution statuses `running | complete | blocked`;
- command results `SUCCESS | PASS | FAIL | BLOCKED`;
- resolver outcomes `RESUME | NEXT | DONE | BLOCKED | NOT_FOUND`;
- monotonic `nextOrdinal`;
- exact `executionId` binding для semantic completion;
- bounded terminal window 100 records;
- 16 KiB limits для `current.details` и intent basis;
- максимум 8 progress telemetry samples.

Storage path `.harness/local/execution/execution-status.json` относится только к reference architecture. В thin architecture semantics сохраняется, а storage намеренно переезжает в Git-private `ai-harness` (`THIN-001`).

Immutable implementation/planning/INIT reports используют verdict `pass | fail | blocked`; structured finding categories — `implementation | evidence | contract`. Existing durable report path не может быть перезаписан.

## Parity map

| Case | Planned issue | Target Core ownership | Semantics |
|---|---:|---|---|
| `PARITY-COMMAND-001` | #32 | `core/protocol/command-model` | preserve |
| `PARITY-CTS-002` | #32 | `core/protocol/cts` | preserve |
| `PARITY-AUTHORITY-003` | #32 | `core/protocol/authority` | preserve |
| `PARITY-DOCUMENT-004` | #33 | `core/artifacts/contracts` | preserve |
| `PARITY-PROJECTION-005` | #34 | `core/project/state` | preserve |
| `PARITY-PLANNING-006` | #35 | `core/planning/context` | preserve |
| `PARITY-EXECUTION-007` | #36 | `core/execution/state` | preserve, storage intentionally changes |
| `PARITY-REVIEW-008` | #37 | `core/review/convergence` | preserve |
| `PARITY-GIT-009` | #38 | `core/git/safety-actions` | preserve |
| `PARITY-UPDATE-010` | #39 | `core/update/thin-update-service` | intentional architecture change |
| `PARITY-RUNTIME-011` | Stage 6 | `core/runtime/contract` | contract only; implementation deferred |
| `PARITY-DISPATCH-012` | #40 | `core/protocol/dispatcher` | preserve |

Каждый case в JSON содержит:

1. exact template source paths;
2. целевой Core module;
3. upstream synthetic tests, от которых унаследован behavioral contract;
4. assertions;
5. source-of-truth cutover condition.

## Critical negative cases

Fixture отдельно фиксирует `NEG-...` cases. Минимально защищаются:

- cross-domain/invalid chain;
- malformed canonical artifacts/reports;
- broken/cyclic traceability;
- stale planning basis;
- missing role context;
- stale execution result;
- changed intent on resume;
- stale review/completion proof;
- no-progress repair loop;
- unsafe Git state;
- uncertain external side effect;
- update collision/ownership ambiguity.

Это не попытка выполнять upstream Python из CLI test suite. Наоборот, baseline test **не запускает** snapshot scripts/hooks. Он проверяет checked-in golden metadata и обеспечивает стабильные IDs для последующих native Core parity tests.

## Intentional thin-architecture changes

Semantic parity нельзя смешивать с осознанными изменениями архитектуры.

### THIN-001 — execution storage

Execution/recovery semantics сохраняются, но storage переносится из repository `.harness/local/**` в Git-private `ai-harness`.

### THIN-002 — Harness Update

Legacy `harness_update.py` остаётся historical compatibility reference. Новый Core не должен копировать repository-embedded updater; `HARNESS UPDATE CHECK/APPLY` работает через verified release pin, compatibility и migration coordination.

### THIN-003 — RuntimeAdapter implementations

Contract Codex/Claude зафиксирован в baseline, но concrete adapters не входят в Stage 4 и остаются следующим roadmap stage.

## Source-of-truth cutover rule

Для каждого extracted area cutover считается завершённым только когда:

1. соответствующий `PARITY-...` case реализован native Core tests;
2. CLI/ProtocolEngine использует pinned release-owned Core implementation;
3. template implementation перестаёт быть active runtime path;
4. historical v0.10.4 fixture остаётся immutable compatibility reference.

Это различает две ситуации:

- **semantic preservation** — новое Core поведение обязано совпадать с baseline;
- **intentional architecture change** — отличие явно перечислено как `THIN-...` и проверяется отдельным target contract.

Связанные требования: `CLI-REQ-003`, `CLI-REQ-240`, `CLI-REQ-241`, `CLI-REQ-250`–`CLI-REQ-254`.
