# Harness CLI — план работ

Этот документ — канонический roadmap `harness-cli`.

Главная цель проекта: **вынести общую реализацию AI Development Harness из пользовательских репозиториев в отдельно устанавливаемый, версионируемый продукт**, оставив в project repository только минимальный tracked contract и project-owned knowledge.

## 1. Целевая модель

```text
Установленный Harness
├── harness CLI
└── immutable releases/
    └── <version>/
        ├── core/
        ├── protocol/
        ├── schemas/
        ├── skills/
        └── docs/

project repository/
├── harness.yaml
├── AGENTS.md / CLAUDE.md     # только thin bootstrap
├── project-owned REQ/ADR/STEP/OQ/reviews/evidence
├── project-specific skills
└── product code/tests

git rev-parse --git-path ai-harness
└── clone/worktree-local operational state
```

Project repository **не должен содержать собственную копию Harness implementation**.

## 2. Граница ответственности CLI

`harness-cli` — deterministic control plane и менеджер установленного Harness.

Он отвечает за:

- setup/bootstrap project contract;
- doctor/status/config/validate;
- Release Store, install/list/verify/resolution;
- update и migration;
- canonical protocol parsing/validation/CTS;
- execution state и deterministic continuation;
- artifact/project validation и read models;
- verification/review/completion gates;
- Git safety/preflight и deterministic side-effect policy;
- machine-readable handoff/result boundaries для внешних callers.

### 2.1 CLI никогда не запускает AI runtime

`harness-cli` **не запускает, не выбирает и не supervises** Codex, Claude Code или другой AI runtime.

AI runtime запускается пользователем или внешним продуктом независимо и при необходимости **сам вызывает Harness**.

Правильное направление зависимости:

```text
Claude / Codex / другой внешний caller
        │
        │ canonical command / factual proposal
        ▼
Harness CLI / release-owned Core
        │
        ├── deterministic validation/state/gates
        └── semantic handoff / deterministic result
        │
        ▼
внешний caller продолжает работу
```

В Core допустим semantic handoff, но не model execution и не process lifecycle AI runtime.

## 3. Архитектурные инварианты

### 3.1 Thin project repository

Новый Harness project не требует tracked implementation paths вроде:

```text
.harness/tools/**
.harness/docs/**
```

Общая реализация принадлежит immutable Harness release.

### 3.2 Project pin закрепляет executable semantics

`harness.yaml -> harness.release` однозначно разрешается в конкретный verified immutable release.

Никакого silent fallback на `main`, `latest` или соседний installed release.

### 3.3 Детерминированность прежде всего

Вычислимые операции выполняются кодом, а не reasoning модели:

- parsing;
- validation;
- state transitions;
- release resolution;
- migration;
- Git safety;
- locking;
- verification gates;
- project/read-model calculations.

### 3.4 Project knowledge остаётся в Git

REQ, ADR, STEP, OQ, reviews, audits, evidence и project-specific skills остаются project-owned tracked artifacts.

### 3.5 Operational state не tracked

Clone/worktree-local execution state хранится через:

```bash
git rev-parse --git-path ai-harness
```

и не становится canonical project knowledge.

### 3.6 Core runtime-neutral

Core не импортирует SDK конкретного AI runtime и не зависит от способа его запуска.

## 4. Текущее состояние

### Stage 1 — Product / Architecture / Migration contracts

**Статус: завершён.**

Подготовлены:

- `PRODUCT_REQUIREMENTS.md`;
- `ARCHITECTURE.md`;
- `MIGRATION.md`;
- `ROADMAP.md`.

### Stage 2 — Harness Distribution и immutable Release Store

**Статус: foundation завершён.**

Реализованы:

- format `release.json`;
- immutable Release Store;
- integrity verification;
- exact project pin resolver;
- compatibility checks;
- install/list/verify;
- кроссплатформенное global storage.

Download/catalog transport, signatures/provenance, GC и offline hardening относятся к позднему distribution stage.

### Stage 3 — Legacy repository-embedded → thin migration

**Статус: завершён.**

Реализованы:

- legacy inspector;
- deterministic migration planner;
- checkpointed/resumable executor;
- v0.10.4 → thin transformation;
- ownership/conflict checks;
- filesystem containment;
- Git-private operational state;
- concurrent mutation serialization;
- cross-platform E2E regression suite.

### Stage 4 — Release-owned Harness Core

**Статус: завершён в issues #30–#41.**

Реализованы:

- immutable v0.10.4 extraction baseline;
- release-owned Core Host API;
- canonical protocol/CTS model;
- artifact/document contracts;
- project state/read models;
- planning/context contracts;
- execution state + intent-safe resume;
- review/completion/convergence gates;
- Git safety/actions + side-effect recovery;
- thin Harness UpdateService;
- deterministic ProtocolEngine;
- real self-contained Harness release payload;
- protocol/schemas/skills/docs packaging;
- runtime dependencies внутри immutable release;
- installed pinned-Core smoke на Linux/macOS/Windows.

Stage 4 **не** включает AI runtime adapters или запуск Codex/Claude.

## 5. Stage 5 — завершить deterministic CLI/Core surface

**Статус: завершён в issues #67–#74.**

Цель: предоставить стабильные human-readable и machine-readable команды для всей deterministic функциональности, уже принадлежащей Core.

Приоритетные поверхности:

```text
harness setup
harness doctor
harness status
harness config
harness validate

harness release install/list/verify
harness migrate inspect/plan/apply/resume/status
harness update check/apply

harness project status
harness step list
harness step show STEP-NNN
harness step next
harness git check
```

Также нужен стабильный machine boundary, через который **внешний уже запущенный agent/runtime** может:

1. передать canonical command;
2. получить deterministic result либо semantic handoff;
3. вернуть factual semantic proposal/result;
4. продолжить существующее execution после interruption.

Presentation CLI не дублирует protocol/state semantics Core. Stage 5 завершён после введения общего presentation contract, read-only config/project/STEP/Git surfaces, UpdateService wrappers и pinned release-owned external caller boundary. Полная parity-матрица публичного CLI зафиксирована в `docs/STAGE5_PARITY.md` и regression-тесте `test/stage5-cli-matrix.test.ts`.

### Не входит в Stage 5

- запуск Claude/Codex;
- выбор AI runtime;
- model/effort configuration AI runtime;
- auth/account management AI runtime;
- cancellation/process supervision AI runtime;
- команды, которые создают иллюзию, что CLI сам выполняет semantic coding work.

## 6. Stage 6 — Thin-project bootstrap/integration contract

Цель: формализовать минимальный tracked contract нового project repository после externalization Harness.

Нужно определить:

- минимальный `harness.yaml`;
- минимальный runtime-neutral `AGENTS.md`;
- минимальный optional runtime-specific bootstrap вроде `CLAUDE.md`, если он нужен внешнему runtime;
- как bootstrap обнаруживает установленный `harness`;
- как внешний caller получает machine-readable semantic handoff;
- какие project-owned directories/templates создаёт `setup`;
- отсутствие dependency на repository-embedded Harness implementation.

Это **не RuntimeAdapter API** и не process-control слой.

Работа по изменению другого repository, например `ai-development-harness-template`, должна планироваться и согласовываться отдельно в том repository.

## 7. Stage 7 — Local Integration API

После стабилизации deterministic Core можно предоставить внешний integration interface для:

- Harness Navigator;
- UI Harness;
- IDE/editor integrations;
- других локальных клиентов.

Минимальные направления:

- project inspect/validate;
- artifact list/show;
- command availability;
- execution state;
- release information;
- diagnostics.

Конкретный transport заранее не фиксируется. API не должен становиться AI runtime launcher.

## 8. Stage 8 — Distribution / release hardening

После стабилизации Core/CLI:

- автоматизация release build/publish;
- download/catalog transport;
- signatures/checksums/provenance;
- compatibility matrix;
- rollback;
- release GC;
- offline installation;
- исследование standalone binaries Linux/macOS/Windows.

npm может быть первым каналом, но не является архитектурно единственным.

## 9. Сквозные требования

### Кроссплатформенность

Linux, macOS и Windows.

### Machine-readable output

Интеграционные/deterministic команды должны иметь стабильный structured output.

### Exit codes

Ошибки input, environment, compatibility, blocked state и internal failure должны различаться детерминированно.

### Безопасность

По умолчанию:

- никаких destructive Git operations;
- никаких silent overwrite project-owned files;
- никаких недоверенных release hooks/bootstrap scripts;
- никаких path escapes;
- никаких silent release/runtime fallbacks.

### Тестирование

Минимальный gate:

```bash
npm run typecheck
npm test
npm run build
```

Cross-platform filesystem/Git-heavy behavior проверяется CI matrix.

## 10. Порядок дальнейшей реализации

```text
Stage 1  Product/architecture contracts        ✅
Stage 2  Immutable Release Store              ✅ foundation
Stage 3  Legacy → thin migration              ✅
Stage 4  Release-owned Core                   ✅
         ↓
Stage 5  Deterministic CLI/Core surface       ✅
         ↓
Stage 6  Thin-project bootstrap contract       ← NEXT
         ↓
Stage 7  Local Integration API
         ↓
Stage 8  Distribution/release hardening
```

Не добавлять обратно AI runtime process management в `harness-cli` без нового явного архитектурного решения, изменяющего продуктовую границу.
