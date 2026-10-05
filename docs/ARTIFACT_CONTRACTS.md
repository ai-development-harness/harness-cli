# Artifact Contracts

## 1. Назначение

Этот документ фиксирует deterministic contract project-owned artifacts, перенесённый в Harness Core на Stage 4.

Source baseline:

- repository: `ai-development-harness/ai-development-harness-template`;
- commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- Harness release: `0.10.4`;
- parity case: `PARITY-DOCUMENT-004`.

После source-of-truth cutover активная реализация parser/validation находится в `src/core/artifacts/`. Python validators template repository остаются compatibility reference для v0.10.4 и не должны развиваться как вторая независимая runtime implementation.

## 2. Canonical project artifacts

Core валидирует:

- `REQ-NNN`;
- `ADR-NNN`;
- `STEP-NNN`;
- `OQ-NNN`;
- `PRN-NNN`.

Проверяются:

- `schema: 1`;
- canonical ID;
- filename ↔ ID;
- H1 ↔ ID;
- statuses/types/priorities;
- обязательные frontmatter fields;
- обязательные `##` sections;
- duplicate sections;
- canonical references;
- reciprocal REQ ↔ ADR / REQ ↔ STEP / ADR ↔ STEP traceability;
- STEP dependency cycles;
- ADR supersession cycles;
- OQ `affects` targets;
- PRN supersession semantics.

Planning freshness, execution groups, completion proof и semantic planning/review gates остаются отдельными Core contracts последующих Stage 4 issues.

## 3. Durable reports

Structural validation охватывает:

- `step_review`;
- `planning_review`;
- `init_review`;
- `audit`;
- `release_check`;
- `skill_search`.

Для durable reports Core проверяет:

- schema/kind;
- canonical timestamped filename;
- `created_at` identity с тем же UTC second;
- symlink rejection;
- mandatory sections;
- report-specific metadata;
- referenced STEP identity;
- semantic-review `finding_count`;
- skill-search candidate numbering/provenance fields.

Historical durable artifact нельзя перезаписывать. `createDurableArtifact()` использует exclusive create (`wx`); существующий path возвращает typed `DURABLE_ARTIFACT_EXISTS`.

Git-history immutability checks и review/completion trust semantics развиваются в review/convergence layer (#37), а не дублируются здесь.

## 4. Document boundary

Все canonical Markdown artifacts проходят единый parser:

```text
UTF-8 file
  ↓
YAML frontmatter
  ↓
H1
  ↓
level-2 sections
  ↓
duplicate-section detection
  ↓
artifact/report contract
```

Artifact-specific validators не реализуют собственный YAML/Markdown parser.

Malformed frontmatter/Markdown boundary не деградирует в пустой artifact: возвращается typed `ARTIFACT_PARSE_ERROR`.

## 5. Configured paths

Artifact topology берётся только из уже существующего `HarnessConfig` / `harness.yaml` service.

Core не имеет второго config parser и не восстанавливает default topology независимо от config.

Все configured paths проходят существующий `resolvePortablePathWithinBoundary()`, поэтому lexical traversal и filesystem escape через symlink/junction блокируются общим Core boundary layer.

## 6. Diagnostics DTO

`validateProjectArtifacts()` возвращает schema-v1 DTO:

```json
{
  "schemaVersion": 1,
  "status": "PASS",
  "projectRoot": "/repo",
  "harnessRelease": "0.10.4",
  "projectSchemaVersion": 1,
  "checked": {
    "requirement": 1,
    "adr": 1,
    "step": 1
  },
  "diagnostics": []
}
```

Каждая ошибка имеет stable `code`, repository-relative `path`, `message` и при необходимости `kind`, `artifactId`, `field`, `reference`.

Критические категории включают:

- `ARTIFACT_PARSE_ERROR`;
- `ARTIFACT_SCHEMA`;
- `ARTIFACT_ID`;
- `ARTIFACT_STATUS`;
- `ARTIFACT_SECTION`;
- `ARTIFACT_REFERENCE`;
- `ARTIFACT_REVERSE_REFERENCE`;
- `ARTIFACT_CYCLE`;
- `ARTIFACT_REPORT_IDENTITY`;
- `ARTIFACT_TEMPLATE`.

## 7. harness validate

`harness validate` теперь:

1. определяет Git root;
2. читает canonical `harness.yaml` через существующий Core config service;
3. разрешает и проверяет exact pinned Harness release;
4. выполняет Core artifact validation;
5. возвращает human-readable diagnostics либо stable `--json` DTO;
6. выставляет non-zero exit code при blocking diagnostics.

До Stage 4 source cutover команда проверяла только YAML parse.

Полный distribution cutover, где этот Core код физически поставляется как immutable release payload и вызывается через release-owned Core entrypoint, завершается в #41. До этого template implementation уже не считается активным source of truth для artifact contracts.

## 8. Out of scope

Этот слой намеренно не включает:

- project projections/status;
- semantic model calls;
- legacy embedded schema migration;
- plan freshness/context fingerprints;
- completion proof;
- Git-history review immutability inspection;
- execution state.

## 9. Requirements

- `CLI-REQ-002`;
- `CLI-REQ-003`;
- `CLI-REQ-036`–`CLI-REQ-039`;
- `CLI-REQ-084`–`CLI-REQ-086`;
- `CLI-REQ-201`;
- `CLI-REQ-240`–`CLI-REQ-254`.
