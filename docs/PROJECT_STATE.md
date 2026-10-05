# Project State and Read Models

## 1. Назначение

Этот слой предоставляет единый deterministic read model поверх project-owned artifacts.

Baseline:

- Harness release: `0.10.4`;
- template commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- parity case: `PARITY-PROJECTION-005`.

Canonical artifacts остаются единственным source of truth. Graph, status, coverage, projections и STEP DTO всегда пересобираются из них.

## 2. Core API

Модуль `src/core/project/` предоставляет:

- `buildArtifactInventory()`;
- `buildProjectGraph()`;
- `buildTraceabilityCoverage()`;
- `buildProjectState()`;
- `stepList()`;
- `stepShow()`;
- `affectedSteps()`;
- `resolveStepAction()`;
- `resolveStepNext()`;
- `projectionTargets()`;
- `writeProjections()`;
- `validateProjections()`;
- `projectStatus()`.

Клиенты и будущий IntegrationFacade не должны повторно парсить Markdown или знать внутреннюю файловую топологию.

## 3. Inventory and graph

Inventory читает configured REQ/ADR/STEP/OQ/PRN paths через `HarnessConfig` и общий path-boundary layer.

Graph строит canonical relations:

- REQ → STEP: `implemented_by`;
- ADR → REQ: `addresses`;
- ADR → STEP: `governs`;
- STEP → STEP: `depends_on`;
- OQ → artifact/PROJECT: `affects`.

Отсутствующая ссылка не исчезает. Она представляется node `MISSING:<artifact-id>` и typed diagnostic `MISSING_REFERENCE`.

Dependency cycles вычисляются детерминированно и блокируют derived projections/STEP NEXT.

## 4. Traceability coverage

Coverage выводится только из explicit IDs.

Статусы REQ coverage:

- `uncovered`;
- `covered`;
- `blocked`;
- `stale_evidence`;
- `verified`.

Coverage отдельно сообщает:

- orphan STEP;
- invalid references;
- blocking OQ;
- stale evidence;
- verified requirement count.

Completion truth не определяется этим module. Он принимает `completion` provider; до #37 fallback отражает только lifecycle status и не считается durable proof.

## 5. Planning facts boundary

#34 не реализует второй `planning_context_basis`.

`ProjectReadModelProviders.planFreshness` поставляет:

- `fresh`;
- `stale`;
- `not_ready`;
- `invalid`;
- `blocked`;
- causes;
- remediation action.

Authoritative fingerprint implementation добавляется в #35. Если Ready STEP не имеет planning provider, Core fail-closes implementation recommendation вместо предположения о freshness.

## 6. STEP NEXT

Stable ranking policy:

1. resumable execution before fresh work;
2. in-progress before planned;
3. priority: critical → high → medium → low;
4. larger transitive downstream impact;
5. larger explicit non-`none` risk flag count;
6. canonical STEP order.

Ranking breakdown возвращается в DTO вместе с selected candidate и alternatives.

Existing execution facts приходят через `unresolvedExecutions` provider; actual clone-local execution state реализуется в #36.

## 7. Projections

Tracked projections:

- `<requirements>/SPEC.md`;
- `<requirements>/STATUS.md`;
- configured roadmap;
- configured project status;
- configured open-questions index.

`writeProjections()` сначала полностью выводит expected content из canonical state, затем обновляет только отличающиеся targets. Повторный вызов без изменений возвращает пустой changed set.

Missing references, malformed canonical artifacts и dependency cycles не рендерятся частично: derivation завершается `ProjectionDerivationError`.

## 8. harness status

`harness status`:

1. проверяет exact pinned release;
2. перестраивает deterministic projections;
3. собирает factual STEP/project status;
4. вычисляет STEP NEXT;
5. поддерживает human-readable output и `--json`.

## 9. Ownership

| Surface | Owner |
|---|---|
| Artifact parsing/contracts | `core/artifacts` |
| Inventory/graph/projections/read models | `core/project` |
| Planning fingerprints/context | #35 / `core/planning` |
| Execution continuity | #36 / execution state |
| Completion/review trust | #37 / review layer |

## 10. Requirements

- `CLI-REQ-003`;
- `CLI-REQ-087`–`CLI-REQ-089`;
- `CLI-REQ-200`–`CLI-REQ-202`;
- `CLI-REQ-240`;
- `CLI-REQ-241`.
