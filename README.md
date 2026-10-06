# Harness CLI

Экспериментальный CLI и управляющий слой [AI Development Harness](https://github.com/ai-development-harness).

Цель проекта — отделить сам Harness от артефактов конкретного проекта. Долговечные проектные знания — требования, ADR, STEP, результаты проверок, аудиты и другие артефакты — остаются в Git-репозитории проекта. Реализация протокола Harness, валидаторы, базовые skills и системные инструменты должны поставляться отдельно.

## Архитектурная граница

Harness CLI **никогда не запускает и не управляет Claude Code, Codex или другим AI runtime**. AI runtime является внешним caller и при необходимости сам вызывает deterministic Harness interfaces.

Интерактивная сессия должна по возможности оставаться под управлением самой среды выполнения, чтобы штатно работали:

- запросы разрешений;
- подтверждения;
- вопросы пользователю;
- разрешения на WebFetch и другие инструменты;
- аутентификация;
- TTY-взаимодействие.

CLI отвечает за установку, конфигурацию, детерминированную валидацию, миграции, release management и machine-readable Core boundaries.

```text
Claude Code / Codex / другой внешний caller
        │
        │ canonical command / factual proposal
        ▼
Harness CLI / release-owned Core
  ├─ protocol + execution state
  ├─ validators / deterministic gates
  ├─ project read models
  ├─ Git safety
  └─ release / migration / update services
```

## Текущий объём

CLI не запускает AI runtime. Текущий deterministic surface включает:

- `harness setup` — подготовить существующий Git-репозиторий для Harness;
- `harness doctor` — проверить окружение и ожидаемую структуру проекта;
- `harness config` — read-only показать effective `harness.yaml` после применения schema defaults;
- `harness validate` — проверить `harness.yaml`;
- `harness status` — показать закреплённый релиз Harness, его фактический resolution status и путь к локальному состоянию конкретного clone/worktree;
- `harness update check [--target-release X.Y.Z]` — read-only построить deterministic update plan поверх установленных releases;
- `harness update apply [--target-release X.Y.Z]` — применить update release pin через Core UpdateService с его locking/checkpoint/recovery semantics;
- `harness release install <directory>` — установить локальный проверенный release tree;
- `harness release list` — показать установленные releases;
- `harness release verify <version>` — повторно проверить immutable release;
- `harness migrate inspect` — read-only инспекция legacy/thin состояния;
- `harness migrate plan` — read-only dry-run и построение prepared migration plan;
- `harness migrate apply --plan <file>` — применение только ранее сохранённого exact plan;
- `harness migrate status [migration-id]` — checkpoint/recovery и worktree execution-lock diagnostics;
- `harness migrate resume <migration-id>` — безопасное продолжение прерванной migration.

В Core также реализованы:

- immutable Harness Release Store в platform-aware global storage;
- установка проверенного release tree из локального directory source;
- проверка `release.json` и SHA-256 всего payload;
- список установленных releases;
- Release Resolver для project pin с проверкой CLI/Host API/project schema compatibility.

`doctor` и `status` используют общий Release Resolver и не выполняют silent fallback на другую версию.

CLI **не запускает Claude Code или Codex**.

`update check` ничего не записывает в проект. Без `--target-release` Core выбирает самый новый verified installed release новее текущего pin. Явная цель должна быть уже установлена и проверяема; CLI не использует `latest`, `main` или сетевой fallback. `update apply` не реализует собственные update rules: compatibility checks, write lock, checkpoint и crash recovery остаются внутри `UpdateService`.

## Что хранится в проекте

В отслеживаемом Git-репозитории проекта остаются прежде всего данные, принадлежащие самому проекту:

```text
harness.yaml
AGENTS.md
CLAUDE.md
docs/
planning/
src/
tests/
...
```

Операционное состояние конкретного clone/worktree хранится вне отслеживаемого рабочего дерева через внутренний путь Git:

```text
.git/ai-harness/
```

Установленный дистрибутив Harness содержит код протокола, валидаторы, базовые skills и неизменяемые релизы вне пользовательского репозитория. AI runtime остаётся внешним caller и не является частью CLI/Core distribution boundary.

## Разработка

Требуется Node.js 20+.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Локальный запуск:

```bash
npm run dev -- release install ./path/to/release
npm run dev -- release list
npm run dev -- release verify 0.10.4
npm run dev -- setup
npm run dev -- doctor
npm run dev -- config --json
npm run dev -- validate
npm run dev -- status
npm run dev -- update check --json
npm run dev -- update apply --target-release 0.11.0 --json
npm run dev -- migrate inspect
npm run dev -- migrate plan --json
```

Команды `release install/list/verify` поддерживают `--json` для машиночитаемого результата.

## Миграция legacy repository-embedded Harness

Public workflow намеренно разделяет read-only Plan и mutation Apply:

```bash
# 1. Посмотреть фактическое состояние проекта.
harness migrate inspect

# 2. Чистый dry-run: repository и clone-local state не изменяются.
harness migrate plan

# 3. Явно сохранить exact prepared plan.
harness migrate plan --out ../migration-plan.json

# 4. Применить только этот сохранённый plan.
harness migrate apply --plan ../migration-plan.json

# 5. Если процесс был прерван — посмотреть checkpoint и продолжить.
harness migrate status
harness migrate resume migration-0123456789abcdef
```

Для automation каждая migration-команда поддерживает `--json`.

`migrate plan` возвращает exit code `2`, если migration корректно проанализирована, но заблокирована safety/preflight условиями. Execution/parsing/corruption errors используют exit code `1`.

`apply` **не выполняет re-plan**. Он принимает только `status=ready` plan, сохранённый через `migrate plan --out`, повторно проверяет project identity, Git HEAD, per-operation preconditions и immutable target release digest. `apply` и `resume` сериализованы одним worktree-scoped execution lock в Git-private `ai-harness`; конкурентный mutating запуск завершается сразу с machine-readable `MIGRATION_LOCK_ACTIVE`, а `status --json` показывает состояние lock.

Текущая compatibility floor совпадает с current repository-embedded baseline: поддерживается только Harness **v0.10.4**. Более ранние версии fail-closed с `UNSUPPORTED_LEGACY_RELEASE` до появления отдельного immutable compatibility descriptor.


`setup` выполняет read-only preflight закреплённого release до первой записи в проект. Если release отсутствует, повреждён или несовместим с текущим CLI/Host API/project schema, setup завершается ошибкой и не создаёт частично настроенный Harness project.

## Пример проектного контракта

Начальная схема отражает настройки, которые принадлежат проекту, и намеренно не включает встроенные в репозиторий элементы управляющего слоя вроде `.harness/tools/**` и старые политики обновления Harness.

```yaml
schemaVersion: 1

harness:
  release: 0.10.4

project:
  initialized: false
  name: null
  initializedAt: null

execution:
  maxFixReviewCycles: 3
  verificationCommandTimeoutSeconds: 300

review:
  security: auto
  tests: auto

skills:
  search:
    maxResults: 5

language:
  default: ru

sources:
  localBrief: PROJECT_BRIEF.local.md
  projectOverview: docs/PROJECT.md
  requirements: docs/requirements
  adrDirectory: docs/adr
  principles: docs/principles
  architecture: docs/architecture.md
  openQuestions: docs/open-questions
  openQuestionsIndex: docs/OPEN_QUESTIONS.md
  roadmap: planning/PLAN.md
  status: planning/STATUS.md

protocol:
  taskDirectory: planning/tasks
  reviewDirectory: planning/reviews
  planningReviewDirectory: planning/plan-reviews
  initReviewDirectory: planning/init-reviews
  auditDirectory: planning/audits
  releaseDirectory: planning/releases
  skillSearchDirectory: planning/skill-searches
  skillRegistry: docs/skills/REGISTRY.md
```

## План работ

Канонический план реализации хранится в [`docs/ROADMAP.md`](docs/ROADMAP.md).

Продуктовый контракт находится в [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) и использует стабильные идентификаторы `CLI-REQ-XXX`.

Каноническая архитектура находится в [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Контракт миграции legacy repository-embedded проектов находится в [`docs/MIGRATION.md`](docs/MIGRATION.md).

Формат Harness Distribution и immutable release находится в [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

План намеренно **не предполагает обязательного существования GUI**. CLI/Core должен предоставлять переиспользуемые машиночитаемые интерфейсы для редакторских интеграций и других внешних инструментов, не делая какой-либо конкретный клиент обязательной частью архитектуры.
