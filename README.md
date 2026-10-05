# Harness CLI

Экспериментальный CLI и управляющий слой [AI Development Harness](https://github.com/ai-development-harness).

Цель проекта — отделить сам Harness от артефактов конкретного проекта. Долговечные проектные знания — требования, ADR, STEP, результаты проверок и другие артефакты — остаются в Git-репозитории проекта, а реализация протокола Harness, валидаторы, базовые skills и инструменты поставляются отдельно.

## Архитектурная граница

Harness CLI **не является обязательной терминальной обёрткой над Claude Code или Codex**.

Интерактивная сессия должна по возможности оставаться под управлением самого runtime, чтобы штатно работали запросы разрешений, подтверждения, вопросы пользователю, WebFetch/tool permissions и TTY-взаимодействие.

CLI отвечает за:

- установку;
- конфигурацию;
- детерминированную валидацию;
- миграции;
- локальные сервисы управляющего слоя.

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

Репозиторий намеренно начинается с небольшого среза, не включающего запуск AI runtime:

- `harness setup` — подготовить существующий Git-репозиторий для Harness;
- `harness doctor` — проверить окружение и ожидаемую структуру проекта;
- `harness validate` — проверить `harness.yaml`;
- `harness status` — показать закреплённый релиз Harness и путь к локальному состоянию clone/worktree.

CLI **не запускает Claude Code или Codex**.

## Проектное состояние и состояние Harness

В отслеживаемом Git-репозитории проекта остаются:

```text
harness.yaml
AGENTS.md
CLAUDE.md
docs/
planning/
src/
```

Операционное состояние конкретного clone/worktree хранится вне tracked working tree через внутренний путь Git:

```text
.git/ai-harness/
```

В будущем установленная distribution Harness должна владеть кодом протокола, валидаторами, базовыми skills, runtime adapters и immutable releases вне пользовательского репозитория.

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

Начальная схема отражает **project-owned** настройки актуального manifest Harness и намеренно не включает repository-embedded элементы управляющего слоя вроде `.harness/tools/**` и политики обновления Harness.

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

Следующий этап — **формализация продуктового контракта** до дальнейшего расширения реализации:

1. `docs/PRODUCT_REQUIREMENTS.md` со стабильными требованиями `CLI-REQ-XXX`;
2. `docs/ARCHITECTURE.md` с границами модулей и ответственности;
3. `docs/MIGRATION.md` с правилами перехода от repository-embedded Harness;
4. после этого — immutable Harness Release Store / Resolver.

План намеренно **не предполагает обязательного существования GUI**. CLI/Core должен предоставлять переиспользуемые machine-readable интерфейсы для editor integrations и других внешних инструментов, не делая какой-либо конкретный клиент обязательной частью архитектуры.
