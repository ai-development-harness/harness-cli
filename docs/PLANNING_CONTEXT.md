# Planning and Context Contracts

## 1. Scope

Этот module переносит deterministic planning/context semantics Harness v0.10.4 в Core.

Baseline:

- release: `0.10.4`;
- template commit: `9f4aa325154253ab72a8c5940e988046ae872c99`;
- parity case: `PARITY-PLANNING-006`.

Source-of-truth implementation: `src/core/planning/`.

## 2. Planning context schema v4

Authoritative planning snapshot содержит только semantic contract:

- current STEP contract;
- linked REQ contracts;
- linked ADR contracts;
- dependency STEP contracts;
- explicit architecture refs;
- relevant OQ;
- active blocking Project Principles.

Lifecycle/scheduling metadata вроде STEP priority, phase, status и plan revision не входит в semantic snapshot само по себе.

Это позволяет отличать изменение implementation intent от обычной организации работы.

## 3. Fingerprints

Core публикует:

- `planningContextBasis()`;
- `planningContextFingerprints()`;
- `planContentHash()`;
- `planStaleness()`.

Hashes совместимы с v0.10.4:

- text hash нормализует CRLF, trailing whitespace и внешние пустые строки;
- stable hash использует UTF-8 canonical JSON с recursively sorted object keys;
- prefix: `sha256:`.

`plan.context_components` позволяет объяснить staleness конкретными component keys:

- `STEP@`;
- `REQ@`;
- `ADR@`;
- `ARCH@`;
- `OQ@`;
- `PRN@`.

## 4. Context Contracts

Поддерживаются три runtime-neutral роли:

- planner;
- implementer;
- reviewer.

Каждая роль получает собственный минимальный набор sections. Resolver не делает semantic summarization и не сканирует весь repository.

Planner/reviewer дополнительно получают compact projections active Project Principles, потому что applicability остаётся model judgement.

Любое дополнительное чтение должно проходить через explicit context expansion с repository-relative path и reason.

`.harness/tools/**` запрещён для normal semantic expansion.

## 5. Project Principles

PRN остаётся first-class project artifact.

Planning basis включает только `active + blocking` PRN целиком по semantic contract.

Context resolver для planner/reviewer предоставляет все active PRN как applicability candidates с sections:

- Rule;
- Applies to;
- Exceptions / approved deviation.

Advisory principle поэтому доступен model judgement, но не меняет deterministic blocking planning basis.

## 6. Execution Groups

`plan.execution_groups` — optional DAG поверх numbered `### N.` Implementation plan.

Validation гарантирует:

- stable group IDs;
- полное покрытие implementation steps ровно один раз;
- known dependencies;
- absence of self-dependencies/cycles;
- repository-relative POSIX mutation prefixes;
- non-empty verification responsibilities;
- no overlap между независимыми `parallel=true` groups.

Core выводит:

- normalized groups;
- topological order;
- dependency layers;
- parallel candidates.

Parallel=true — capability fact, а не команда автоматически запускать subagents.

## 7. Planning reviews

PASS planning review доказывает exact pair:

`context_basis + plan_content_hash`.

Более новый BLOCKED report для той же пары отменяет более старый PASS.

Ready plan должен содержать:

- valid context basis;
- valid content hash;
- matching PASS review;
- exact `reviewed_report`;
- ISO-8601 `planned_at`.

INIT review basis детерминированно fingerprint-ит candidate requirements/roadmap state.

## 8. Implementation prerequisite facts

Непосредственно перед IMPLEMENT Core проверяет:

- Ready plan;
- fresh context basis;
- fresh plan content hash;
- matching PASS planning review;
- phase != TBD;
- accepted ADR, кроме proposed ADR собственного STEP type=adr;
- relevant OQ closed;
- dependency completion proof.

Completion proof является authority review/completion layer #37. До подключения этого provider dependency execution fail-closes с `completion-proof-provider-unavailable`.

## 9. Integration with Project State

`createPlanningProjectProviders()` реализует provider boundary, введённый в #34:

- `planFreshness`;
- `implementationPrerequisites`;
- optional completion provider.

Поэтому PROJECT STATUS и STEP NEXT используют одну planning implementation, а не повторяют fingerprint logic.

## 10. Requirements

- `CLI-REQ-003`;
- `CLI-REQ-004`;
- `CLI-REQ-140`–`CLI-REQ-148`;
- `CLI-REQ-200`–`CLI-REQ-202`;
- `CLI-REQ-251`.
