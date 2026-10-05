# Harness CLI

Экспериментальный CLI и управляющий слой [AI Development Harness](https://github.com/ai-development-harness).

Цель проекта — отделить сам Harness от артефактов конкретного проекта. Долговечные проектные знания — требования, ADR, STEP, результаты проверок, аудиты и другие артефакты — остаются в Git-репозитории проекта. Реализация протокола Harness, валидаторы, базовые skills и системные инструменты должны поставляться отдельно.

## Архитектурная граница

Harness CLI **не является обязательной терминальной обёрткой над Claude Code или Codex**.

Интерактивная сессия должна по возможности оставаться под управлением самой среды выполнения, чтобы штатно работали:

- запросы разрешений;
- подтверждения;
- вопросы пользователю;
- разрешения на WebFetch и другие инструменты;
- аутентификация;
- TTY-взаимодействие.

CLI отвечает за установку, конфигурацию, детерминированную валидацию, миграции и локальные сервисы управляющего слоя.

```text
Claude Code / Codex
        │
        │ команды протокола Harness
        ▼
интеграционный слой / локальный API Harness
        │
        ▼
Harness Core
  ├─ протокол
  ├─ валидаторы
  ├─ машина состояний
  └─ проектные сервисы

Harness CLI
  ├─ setup
  ├─ update
  ├─ doctor
  ├─ validate
  └─ migrations
```

## Текущий объём

Репозиторий намеренно начинается с небольшого среза, который пока не запускает AI runtime:

- `harness setup` — подготовить существующий Git-репозиторий для Harness;
- `harness doctor` — проверить окружение и ожидаемую структуру проекта;
- `harness validate` — проверить `harness.yaml`;
- `harness status` — показать закреплённый релиз Harness и путь к локальному состоянию конкретного clone/worktree.

CLI **не запускает Claude Code или Codex**.

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

В дальнейшем установленный дистрибутив Harness должен содержать код протокола, валидаторы, базовые skills, runtime-адаптеры и неизменяемые релизы вне пользовательского репозитория.

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
npm run dev -- setup
npm run dev -- doctor
npm run dev -- validate
npm run dev -- status
```

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

Текущая последовательность этапа формализации:

1. продуктовые требования — `docs/PRODUCT_REQUIREMENTS.md`;
2. архитектурный контракт — `docs/ARCHITECTURE.md`;
3. контракт миграции — `docs/MIGRATION.md`;
4. после этого — хранилище неизменяемых релизов Harness и resolver закреплённой версии.

План намеренно **не предполагает обязательного существования GUI**. CLI/Core должен предоставлять переиспользуемые машиночитаемые интерфейсы для редакторских интеграций и других внешних инструментов, не делая какой-либо конкретный клиент обязательной частью архитектуры.
