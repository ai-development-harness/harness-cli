# Архитектура Harness CLI/Core

## 1. Назначение

Этот документ фиксирует канонические архитектурные границы Harness CLI/Core.

Продуктовые требования находятся в `docs/PRODUCT_REQUIREMENTS.md`. Этот документ не повторяет их содержание, а определяет, **где живёт ответственность**, **как направлены зависимости** и **какие контракты должны связывать подсистемы**.

Канонический порядок реализации находится в `docs/ROADMAP.md`.

## 2. Архитектурные принципы

### 2.1 Harness Core отделён от пользовательского проекта

Harness Core является частью устанавливаемого продукта и не должен копироваться в каждый пользовательский repository.

В проекте остаются project-owned artifacts и небольшой tracked contract (`harness.yaml`, bootstrap instructions, docs/planning/code/tests).

Связанные требования: `CLI-REQ-001`, `CLI-REQ-002`, `CLI-REQ-037`.

### 2.2 Детерминированная механика принадлежит Core

Parsing, validation, state transitions, Git safety, release resolution, migration mechanics, locking и другие вычислимые операции должны находиться в детерминированном Core, а не в prompts или runtime-specific adapters.

Связанные требования: `CLI-REQ-003`, `CLI-REQ-140`–`CLI-REQ-148`.

### 2.3 Runtime-адаптеры не владеют семантикой Harness

Codex, Claude Code и будущие runtimes являются внешними адаптерами. Они могут отличаться способом запуска, identity/auth API, permissions и resume semantics, но не должны иметь собственную независимую реализацию protocol/state-machine rules.

Связанные требования: `CLI-REQ-004`, `CLI-REQ-160`–`CLI-REQ-166`.

### 2.4 CLI — слой представления и управления, а не отдельный Core

Команды `harness ...` преобразуют пользовательский ввод в вызовы Core и отображают результат.

CLI не должен содержать вторую реализацию validation, release resolution, migration planning или protocol transitions.

Связанные требования: `CLI-REQ-087`–`CLI-REQ-089`, `CLI-REQ-142`, `CLI-REQ-210`–`CLI-REQ-215`.

## 3. Целевая схема

```text
                 ┌──────────────────────────────┐
                 │        CLI presentation      │
                 │  commands / text / JSON UX  │
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │      Application services    │
                 │ setup / doctor / status /    │
                 │ validate / update / migrate  │
                 └──────────────┬───────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │          Harness Core        │
                 │ project │ releases │ protocol│
                 │ state   │ safety   │ migrate │
                 └──────┬─────────┬────────┬────┘
                        │         │        │
              ┌─────────▼───┐ ┌──▼──────┐ ┌▼────────────────┐
              │ Git / FS    │ │ Runtime │ │ Integration API │
              │ adapters    │ │ adapters│ │ adapters        │
              └─────────────┘ └─────────┘ └─────────────────┘
                        │
        ┌───────────────┼───────────────────────┐
        ▼               ▼                       ▼
 project repository   .git/ai-harness/   global Harness storage
 tracked state        clone-local state  releases/config/cache
```

Это логическая схема. Она не требует немедленного разделения npm-пакета на несколько packages.

## 4. Логические модули

### 4.1 CLI Presentation

Ответственность:

- разбор top-level CLI arguments;
- регистрация команд Commander;
- выбор human-readable или structured output;
- отображение ошибок без утечки необработанных stack traces;
- преобразование результата application service в exit code.

Не отвечает за:

- schema validation;
- project detection rules;
- release resolution;
- Git safety decisions;
- migration planning;
- protocol transitions.

### 4.2 Application Services

Слой orchestration конкретных use cases:

- `setup`;
- `doctor`;
- `validate`;
- `status`;
- будущие `update` и `migrate`;
- будущие protocol-facing CLI operations.

Application service координирует Core-компоненты, но не должен содержать сложную доменную механику.

### 4.3 Project Module

Отвечает за:

- Git root discovery;
- Harness project classification;
- чтение и валидацию `harness.yaml`;
- project schema version;
- разрешение configured project paths;
- проверку path boundaries;
- project status facts.

Связанные требования: `CLI-REQ-020`–`CLI-REQ-039`.

### 4.3.1 Artifact Contract Module

Deterministic parser/validator project-owned artifacts реализован в `src/core/artifacts/`.

Он владеет:

- canonical REQ/ADR/STEP/OQ/PRN structural contracts;
- shared Markdown/frontmatter parsing boundary;
- configured-path artifact discovery;
- cross-reference / reciprocal traceability validation;
- STEP dependency и ADR supersession cycle detection;
- structural durable report contracts;
- typed diagnostics DTO;
- exclusive-create primitive для immutable report history.

Artifact topology берётся из `HarnessConfig`; отдельного parser/default topology в этом module нет. Configured paths проходят общий path-boundary layer.

Planning freshness, project-state projections, execution semantics и review convergence не входят в этот module.

Нормативное описание: `docs/ARTIFACT_CONTRACTS.md`.

Связанные требования: `CLI-REQ-002`, `CLI-REQ-003`, `CLI-REQ-036`–`CLI-REQ-039`, `CLI-REQ-084`–`CLI-REQ-086`, `CLI-REQ-201`, `CLI-REQ-240`–`CLI-REQ-254`.

### 4.4 Storage Module

Отвечает за три независимых класса storage:

1. tracked project state;
2. clone-local operational state;
3. global Harness state.

Модуль предоставляет paths и базовые операции хранения, но не решает product semantics release или migration.

Связанные требования: `CLI-REQ-050`–`CLI-REQ-056`.

### 4.5 Release Module

Канонический формат release tree и metadata определён в `docs/DISTRIBUTION.md`.

Отвечает за:

- формат Harness Distribution metadata;
- immutable release layout;
- install/list/verify releases;
- compatibility metadata;
- resolution project pin → installed release;
- typed states `missing`, `corrupt`, `incompatible`, `resolved`.

Release resolver не имеет права молча выбирать `latest`, `main` или соседнюю версию.

Связанные требования: `CLI-REQ-100`–`CLI-REQ-109`, `CLI-REQ-242`.

### 4.5.1 Core Host Module

Core Host — bootstrap boundary между текущим CLI package и release-owned executable Core.

Он отвечает только за:

1. canonicalization явного `projectRoot`;
2. чтение project pin/schema из `harness.yaml`;
3. resolution exact pinned release через `ReleaseStore/ReleaseResolver`;
4. Host API compatibility gate;
5. containment declared `entrypoints.core`;
6. import verified ESM entrypoint;
7. runtime validation `harnessCore.hostApiVersion`;
8. формирование typed request/result/error envelope;
9. dependency injection runtime-neutral `filesystem`, `git`, `storage` ports.

Core Host не:

- выбирает latest release;
- скачивает release как fallback;
- запускает install/bootstrap/hooks lifecycle scripts;
- передаёт Commander/UI objects в Core;
- разрешает Core самостоятельно определять project root из cwd.

Host API v1 и module/result contract нормативно описаны в `docs/DISTRIBUTION.md`.

Связанные требования: `CLI-REQ-012`–`CLI-REQ-015`, `CLI-REQ-100`–`CLI-REQ-109`, `CLI-REQ-225`, `CLI-REQ-242`.

### 4.6 Migration Module

Отвечает за transition существующего project state между schema/ownership models.

Migration разделяется минимум на две фазы:

```text
inspect → plan → apply → verify → report
```

`plan` должен быть доступен без мутаций (`dry-run`). `apply` выполняет только явно сформированный plan.

Модуль не должен самостоятельно выбирать новую release version без отдельного input/update decision.

Связанные требования: `CLI-REQ-120`–`CLI-REQ-128`, `CLI-REQ-182`, `CLI-REQ-183`.

### 4.7 Protocol Module

Harness Core содержит canonical protocol model в `src/core/protocol/`.

На текущем этапе модуль владеет:

- closed schema canonical commands / CTS / authority contract;
- 32 canonical commands семи domains;
- target normalization `NNN -> STEP-NNN`;
- strict chain parsing и cross-domain rejection;
- explicit result-gated transitions и runtime preconditions как data;
- deterministic/semantic dispatch metadata;
- reasoning modes `none` / `required` / `conditional`;
- help/reasoning/transition projections из одной machine-readable модели.

Модуль runtime-neutral и не зависит от Commander.

Execution-state mutations, semantic runtime invocation, Git side effects и окончательный dispatcher остаются за следующими Stage 4 слоями. В частности, issue #32 переносит parser/CTS authority, но не реализует `ProtocolEngine` execution semantics целиком.

После этого cutover template `.harness/command-transitions.json`, Python parser и generated reasoning projection являются compatibility reference v0.10.4, а не активным source of truth.

Связанные требования: `CLI-REQ-140`–`CLI-REQ-144`, `CLI-REQ-211`, `CLI-REQ-240`, `CLI-REQ-241`.

### 4.8 Runtime Adapter Boundary

Runtime adapter — boundary между Harness Core и конкретным AI runtime.

Концептуальный контракт:

```text
RuntimeAdapter
├── capabilities()
├── identity()
├── execute(context)
├── resume(context)
└── cancel(context)
```

Точные TypeScript signatures фиксируются отдельным design/ADR при реализации.

Core передаёт адаптеру явный project context и semantic task, но adapter не определяет protocol validity.

Связанные требования: `CLI-REQ-160`–`CLI-REQ-166`.

### 4.9 Integration API Boundary

Внешние инструменты должны получать project/artifact/protocol facts через общий Core API, а не повторно интерпретировать repository.

Минимальная целевая поверхность:

- inspect project;
- validate project;
- list/show artifacts;
- command availability;
- execution state;
- release info;
- diagnostics.

Transport (library API, child-process protocol, MCP-like interface и т. п.) здесь намеренно не выбирается.

Связанные требования: `CLI-REQ-200`–`CLI-REQ-203`.

## 5. Модель владения состоянием

| Класс данных | Каноническое место | Tracked | Владелец |
| --- | --- | --- | --- |
| `harness.yaml` | repository root | да | project contract |
| Requirements / ADR / STEP / reviews / audits | repository configured paths | да | проект |
| Project-specific skills | repository | да | проект |
| Bootstrap `AGENTS.md` / `CLAUDE.md` | repository root | да | проект + Harness bootstrap contract |
| Execution locks/state | Git private path `ai-harness` | нет | Harness Core |
| Runtime session metadata | Git private path `ai-harness` | нет | Harness Core / adapter |
| Temporary migration state | Git private path `ai-harness` | нет | migration engine |
| Installed Harness releases | global data path | нет | Harness Distribution |
| Global cache | global cache path | нет | Harness CLI/Core |
| Global user config | global config path | нет | Harness CLI |

Project-owned artifacts запрещено переносить в global storage как вторую каноническую копию.

Связанные требования: `CLI-REQ-002`, `CLI-REQ-009`, `CLI-REQ-050`–`CLI-REQ-055`.

## 6. Dependency direction

Разрешённое направление зависимостей:

```text
CLI Presentation
      ↓
Application Services
      ↓
Harness Core
      ↓
Ports / contracts
      ↑
Infrastructure adapters (Git, filesystem, runtime, transport)
```

Правила:

1. Core не импортирует Commander.
2. Core не зависит от конкретного runtime SDK.
3. Project/release/migration/protocol domain logic не зависит от формата terminal output.
4. Runtime adapters зависят от Core contract, а не наоборот от конкретной реализации adapter.
5. Integration transports зависят от Core public API.
6. Infrastructure details не должны определять product semantics.

## 7. Public Core contracts

На уровне архитектуры фиксируются следующие логические контракты. Их точные TypeScript names могут уточняться без изменения смысла.

### 7.1 ProjectInspector

Input: filesystem/Git location.

Output: детерминированная классификация:

```text
not-git
git-non-harness
harness-current
harness-legacy
harness-invalid
```

Не выполняет мутаций.

### 7.2 ProjectConfigService

Операции:

- read;
- validate;
- normalize/default;
- resolve project-owned paths.

Не устанавливает releases и не выполняет migrations.

### 7.3 HarnessStateLocator

Возвращает:

- global data/config/cache paths;
- clone/worktree-local Harness path через Git.

Не строит `.git/...` вручную там, где Git предоставляет canonical path.

### 7.4 ReleaseStore

Операции:

- install;
- list;
- inspect;
- verify;
- remove/GC в будущем.

Store работает с immutable release units.

### 7.5 ReleaseResolver

Input:

- project release pin;
- project schema version;
- installed release inventory;
- compatibility metadata.

Output:

- resolved release descriptor;
- либо typed resolution error.

Silent fallback запрещён.

### 7.5.1 CoreHost

`CoreHost` загружает только уже resolved/verified release-owned Core.

Public bootstrap operation:

```text
loadPinnedCore({
  projectRoot,
  releaseStore,
  ports,
  cliVersion
})
```

Результат — immutable descriptor + `invoke(operation, input)`.

Descriptor явно различает:

- Host API version;
- canonical project root;
- project schema version;
- Harness release;
- release digest;
- CLI package version.

`invoke` создаёт Host API v1 request с уникальным `requestId`. Core response принимается только если schema, Host API version, requestId и version identity совпадают с host-created request.

Thrown Core exception переводится в typed `CORE_EXECUTION_FAILED`; malformed response — в `CORE_INVALID_RESPONSE`.

Ports v1:

- `filesystem`;
- `git`;
- `storage`.

Каждый port представляет runtime-neutral `call({ operation, input })` boundary. Конкретная инфраструктура может меняться без импорта Commander/UI/runtime SDK в release-owned Core.

### 7.6 MigrationPlanner / MigrationExecutor

`MigrationPlanner` — read-only и строит детерминированный plan.

`MigrationExecutor` применяет конкретный plan с safety checks и формирует factual report.

Такое разделение обязательно для `dry-run` и повторяемости.

### 7.7 ProtocolEngine

Protocol layer разделён на уже реализованный deterministic command contract и будущий execution dispatcher.

Уже реализовано:

- `PROTOCOL_MODEL` — единый source of truth command surface;
- `validateProtocolModel()` — closed schema/integrity gate;
- `parseCanonicalCommand()` — parser одной canonical command;
- `validateCommandText()` — structural validation всей chain до dispatch;
- `canonicalCommands()`, `helpCatalog()`, `reasoningProjection()`, `transitionRows()` — derived read models.

Критический инвариант: отсутствующий CTS edge означает запрещённый переход. Parser не восстанавливает переходы эвристически.

Будущий `ProtocolEngine` поверх этой модели добавляет:

- runtime-precondition evaluation;
- execution state transitions;
- semantic proposal handoff;
- deterministic commits;
- resume/orchestration behavior.

Semantic agent work находится за пределами deterministic parsing/CTS validation.

### 7.8 RuntimeAdapter

Runtime-specific implementation должна быть заменяемой и capability-driven.

Adapter получает уже валидированный context и не принимает архитектурные решения за ProtocolEngine.

### 7.9 IntegrationFacade

Read-oriented public facade для editor/automation integrations.

Facade собирает Core facts в стабильные DTO и не раскрывает внутреннюю файловую структуру как API contract.

## 8. Ошибки и результаты

Core должен возвращать предметные typed results/errors, а CLI presentation решает, как представить их человеку или JSON consumer.

Категории ошибок должны как минимум различать:

- invalid input/config;
- missing project context;
- unsupported schema;
- release missing/corrupt/incompatible;
- migration conflict;
- Git safety violation;
- deterministic operation failure.

Это позволяет иметь единые semantics для CLI и будущих integrations.

Связанные требования: `CLI-REQ-083`, `CLI-REQ-085`, `CLI-REQ-105`, `CLI-REQ-210`–`CLI-REQ-215`.

## 9. Storage boundaries

### 9.1 Tracked repository

Содержит только долговременный project contract и project knowledge.

### 9.2 Clone-local state

Разрешается через:

```bash
git rev-parse --git-path ai-harness
```

Подходит для execution state, locks, migration checkpoints, temporary reports/cache, привязанных к конкретному clone/worktree.

### 9.3 Global Harness storage

Определяется platform-aware механизмом (`env-paths` в текущей реализации).

Концептуально содержит:

```text
data/
  releases/
config/
cache/
```

Конкретный release layout и формат `release.json` определены в `docs/DISTRIBUTION.md`.

### 9.4 Filesystem containment

Project paths и clone/worktree-local Harness state проходят через единый filesystem-aware boundary contract.

Проверка состоит из двух независимых уровней:

1. **Lexical containment** — absolute paths, `..`, platform separators и другие формы traversal не могут вывести portable path за declared boundary.
2. **Filesystem containment** — ближайший существующий ancestor разрешается через canonical filesystem identity (`realpath`). Если symlink, junction или reparse point переводит target за canonical boundary, операция блокируется.

Symlink/junction не запрещены сами по себе. Ссылка допустима, если её canonical target остаётся внутри той же разрешённой boundary.

Clone-local `ai-harness` может ещё не существовать. В этом случае Core строит projected canonical boundary от ближайшего существующего ancestor, не создавая каталог во время read-only preflight. Dangling/unresolvable filesystem entry трактуется как fail-closed condition.

Structured diagnostics различают:

- `PATH_LEXICAL_ESCAPE`;
- `PATH_FILESYSTEM_ESCAPE`;
- `PATH_BOUNDARY_UNAVAILABLE`.

Mutation flows должны:

- проверять все известные targets до первой mutation, когда операция допускает полный preflight;
- повторять boundary resolution непосредственно перед конкретной filesystem mutation;
- использовать no-overwrite / atomic primitives там, где Node.js/filesystem API это позволяет.

Это уменьшает TOCTOU window, но не объявляет filesystem transaction или sandbox guarantee. Для полной защиты от hostile concurrent filesystem mutation потребовались бы platform-specific descriptor-relative primitives уровня `openat`/handle-based APIs.

Связанное требование: `CLI-REQ-224`.

## 10. Release resolver boundary

Release Resolver является чистой границей между project pin и installed Harness Distribution.

Он:

- читает конкретный pin;
- проверяет наличие release;
- проверяет integrity/compatibility metadata;
- возвращает immutable descriptor.

Он не:

- изменяет `harness.yaml`;
- автоматически обновляет pin;
- выполняет project migration;
- скачивает `latest` как fallback.

Installation orchestration может вызвать ReleaseStore отдельно после явного решения.

## 11. Migration boundary

Migration Engine работает только с явной source/target model.

Минимальный lifecycle:

```text
Inspect
  ↓
Plan (read-only)
  ↓
User/Application decision
  ↓
Apply
  ↓
Verify
  ↓
Report
```

Migration должна сохранять unknown/customized files до явного разрешения конфликта.

### 11.1 Worktree-scoped migration execution lock

Mutating migration execution сериализуется отдельно от durable checkpoint.

Lock хранится в Git-private Harness state конкретного worktree:

```text
<git-private-ai-harness>/migration-execution.lock.json
```

Его назначение — только coordination текущего процесса:

- не более одного mutating `apply/resume` на worktree;
- атомарный acquisition без ожидания;
- machine-readable owner identity (`migrationId`, mode, PID, host, acquisition time);
- local stale detection по process liveness;
- автоматический stale takeover;
- linked Git worktrees используют независимые lock paths через Git.

Lock не является source of truth recovery. После crash durable `migrations/<migrationId>/` checkpoint определяет, что можно resume/recover. Новый saved plan не может обойти существующий unfinished checkpoint другой migration.

Если lock принадлежит другому hostname, Core не пытается угадывать remote PID liveness и fail-closed считает owner активным. Это намеренно безопаснее произвольного TTL takeover.

Для stale takeover используется token-specific hard-link claim. Он не позволяет двум reclaimers одновременно удалить одну и ту же lock generation. Crashed reclaim claim имеет ограниченный recovery timeout и не должен блокировать worktree навсегда.

Связанные требования: `CLI-REQ-125`, `CLI-REQ-146`, `CLI-REQ-147`, `CLI-REQ-211`, `CLI-REQ-220`.

Подробная ownership/migration policy относится к issue #7 и `docs/MIGRATION.md`.

## 12. Runtime boundary

CLI/Core не предполагает, что runtime обязан запускаться дочерним процессом CLI.

Допустимы разные интеграционные механизмы, если сохраняются:

- явный project context;
- capability discovery;
- native permissions/approvals;
- отсутствие silent runtime fallback;
- единая protocol semantics в Core.

Конкретная схема запуска Codex/Claude остаётся открытым design decision.

## 13. Взаимодействие с template repository

`ai-development-harness/ai-development-harness-template` используется как временный reference для ещё не перенесённого поведения Harness.

Правило migration of ownership:

1. До extraction функции template остаётся reference текущего поведения.
2. При extraction определяется Core contract и тесты.
3. После переноса CLI/Core становится source of truth этой функции.
4. Template больше не должен развивать вторую независимую runtime-реализацию.
5. Template может оставаться fixture/reference для migration compatibility.

Связанные требования: `CLI-REQ-240`, `CLI-REQ-241`.

## 14. Текущая реализация и целевая архитектура

Существующий код содержит bootstrap и первый release-owned execution boundary:

```text
src/cli.ts
src/commands/*
src/core/config.ts
src/core/git.ts
src/core/paths.ts
src/core/releases/*
src/core/host/
  contract.ts
  errors.ts
  loader.ts
  index.ts
```

`src/core/host` является Host API v1 implementation: он разрешает exact project pin, проверяет compatibility/integrity и загружает declared Core entrypoint. Сам canonical command/protocol behavior будет переноситься в release-owned Core следующими Stage 4 issues.

Это допустимо для текущего этапа.

При росте функциональности границы из этого документа должны появляться в коде постепенно. Не требуется преждевременно создавать десятки пустых modules/packages.

Основное правило: новая логика размещается по ответственности, а не по удобству конкретной CLI command.

## 15. Что архитектура намеренно не фиксирует

Этот документ не принимает решения о:

- наличии обязательного GUI;
- конкретном transport Local Integration API;
- конкретной технологии standalone packaging;
- конкретном способе process integration с Codex/Claude;
- финальном полном CLI syntax Protocol Engine;
- точном physical package split внутри repository.

Эти решения должны приниматься отдельными requirements/ADR/design tasks при появлении достаточного контекста.

## 16. Трассируемость

| Область | Основные требования |
| --- | --- |
| Product/Core separation | `CLI-REQ-001`–`CLI-REQ-009` |
| Versioning | `CLI-REQ-010`–`CLI-REQ-015` |
| Project/config | `CLI-REQ-020`–`CLI-REQ-039` |
| Storage | `CLI-REQ-050`–`CLI-REQ-056` |
| Setup/diagnostics | `CLI-REQ-060`–`CLI-REQ-089` |
| Releases/update | `CLI-REQ-100`–`CLI-REQ-109` |
| Migration | `CLI-REQ-120`–`CLI-REQ-128` |
| Protocol/execution | `CLI-REQ-140`–`CLI-REQ-148` |
| Runtime adapters | `CLI-REQ-160`–`CLI-REQ-166` |
| Git safety | `CLI-REQ-180`–`CLI-REQ-183` |
| Integration API | `CLI-REQ-200`–`CLI-REQ-203` |
| CLI UX | `CLI-REQ-210`–`CLI-REQ-215` |
| Platform/security | `CLI-REQ-220`–`CLI-REQ-227` |
| Compatibility | `CLI-REQ-240`–`CLI-REQ-242` |
| Testing/distribution | `CLI-REQ-250`–`CLI-REQ-263` |

## 17. Правило изменения архитектуры

Если implementation требует нарушить dependency direction, ownership boundary или public contract из этого документа, изменение сначала должно:

1. показать затронутые `CLI-REQ-XXX`;
2. обновить этот документ или создать ADR;
3. только после этого менять production code.
