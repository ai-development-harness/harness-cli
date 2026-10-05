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

Будущий Harness Core module для:

- canonical command parsing;
- target normalization;
- CTS/state machine;
- chain validation;
- read-only protocol projections;
- execution state transitions.

Этот модуль должен быть runtime-neutral и не зависеть от Commander.

Связанные требования: `CLI-REQ-140`–`CLI-REQ-148`.

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

### 7.6 MigrationPlanner / MigrationExecutor

`MigrationPlanner` — read-only и строит детерминированный plan.

`MigrationExecutor` применяет конкретный plan с safety checks и формирует factual report.

Такое разделение обязательно для `dry-run` и повторяемости.

### 7.7 ProtocolEngine

Будущий контракт:

- parse canonical input;
- normalize target;
- validate transition/chain;
- compute available commands;
- update/read execution state.

Semantic agent work находится за пределами deterministic validation.

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

Существующий код пока содержит небольшой bootstrap:

```text
src/cli.ts
src/commands/*
src/core/config.ts
src/core/git.ts
src/core/paths.ts
```

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
