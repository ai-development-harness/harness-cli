# Harness CLI — план работ

Этот документ — канонический план развития `harness-cli`.

Он фиксирует целевую архитектуру и последовательность миграции AI Development Harness от repository-embedded control plane к отдельному устанавливаемому CLI/Core.

## 1. Цель

Целевая модель:

```text
Global installation
    → Harness executable + immutable releases

.git/ai-harness/
    → clone-local operational state

repository/harness.yaml
    → маленький tracked project contract

repository/docs + planning
    → durable project knowledge

AGENTS.md / CLAUDE.md
    → thin bootstrap adapters
```

Harness-owned implementation не должна копироваться в каждый пользовательский repository.

К Harness-owned относятся:

- protocol implementation;
- command parser / CTS;
- execution state machine;
- validators;
- deterministic tools;
- migrations;
- core skills;
- release resolver;
- runtime-neutral services;
- runtime adapters;
- protocol documentation.

Project-owned остаются:

- source code;
- tests;
- requirements;
- ADR;
- architecture;
- STEP;
- reviews / audits / evidence;
- project-specific skills;
- `harness.yaml`;
- минимальные runtime bootstrap instructions.

## 2. Архитектурные инварианты

Эти правила действуют для всех следующих этапов.

### 2.1 Deterministic-first

Модель решает смысловые задачи. Всё вычислимое, проверяемое и механическое выполняется детерминированным кодом.

В частности:

- parsing;
- schema validation;
- state transitions;
- Git safety;
- release resolution;
- migrations;
- projection rebuild;
- execution locking;
- machine-readable status.

### 2.2 Runtime-neutral Core

Codex и Claude Code — runtime adapters, а не source of truth Harness semantics.

Нельзя реализовывать protocol/state-machine semantics независимо в каждом runtime adapter.

### 2.3 CLI не является обязательной TUI-обёрткой

Нативные runtime interactions должны сохраняться, включая:

- permissions;
- approvals;
- user questions;
- tool authorization;
- authentication;
- interactive TTY behavior.

Runtime integration не должна ломать этот UX.

### 2.4 Project state остаётся в Git

Durable project knowledge остаётся tracked.

Operational clone-local state хранится через:

```bash
git rev-parse --git-path ai-harness
```

Концептуально:

```text
.git/ai-harness/
```

### 2.5 Harness releases immutable

Project pin в `harness.yaml` должен разрешаться в конкретную immutable Harness distribution.

Нельзя использовать mutable `main` как runtime dependency проекта.

## 3. Текущее состояние

### Завершено

Первый bootstrap slice уже реализован:

- `harness setup`;
- `harness doctor`;
- `harness validate`;
- `harness status`;
- schema v1 для `harness.yaml`;
- platform-aware global storage;
- clone-local state path через Git;
- базовый bootstrap `AGENTS.md` / `CLAUDE.md`;
- CI: typecheck / tests / build;
- CLI version берётся из `package.json`.

### Пока не реализовано

- immutable release store;
- release resolver;
- migrations из repository-embedded Harness;
- extracted Harness Core;
- protocol engine;
- command state machine в CLI;
- runtime adapter contract;
- local integration API;
- standalone distribution.

## 4. Этап 1 — формализовать product contract

**Статус: NEXT**

До расширения функционала нужно закрепить каноническое ТЗ.

Создать:

```text
docs/
├── PRODUCT_REQUIREMENTS.md
├── ARCHITECTURE.md
├── MIGRATION.md
└── ROADMAP.md
```

### PRODUCT_REQUIREMENTS.md

Зафиксировать требования с устойчивыми ID, например:

```text
CLI-REQ-001
CLI-REQ-002
...
```

Обязательные разделы:

1. product goals / non-goals;
2. project detection;
3. `harness.yaml` contract;
4. Harness distribution;
5. immutable releases;
6. global storage;
7. clone-local state;
8. setup;
9. doctor;
10. validate;
11. update;
12. migrations;
13. protocol engine;
14. execution state;
15. runtime adapter contract;
16. Git safety;
17. local integration API;
18. cross-platform behavior;
19. security;
20. compatibility;
21. CLI UX;
22. exit codes;
23. machine-readable output;
24. testing;
25. package / distribution strategy.

### ARCHITECTURE.md

Зафиксировать:

- module boundaries;
- ownership model;
- Core vs CLI presentation layer;
- storage model;
- release resolver;
- migration engine;
- runtime adapter boundary;
- dependency direction;
- public API contracts.

### MIGRATION.md

Описать переход существующего Harness project от repository-embedded архитектуры к thin repository model.

На этом этапе migration algorithm может быть design-only, без реализации.

### Критерий завершения

Новые крупные implementation slices должны иметь ссылку на соответствующие CLI-REQ и architecture contract.

## 5. Этап 2 — Harness Distribution и immutable Release Store

Реализовать отдельное понятие **Harness Distribution**, не привязывая архитектуру к одному installation channel.

Первый distribution channel может быть npm/npx.

Концептуальное global storage:

```text
<platform data dir>/ai-development-harness/
├── releases/
│   ├── 0.10.4/
│   │   ├── protocol/
│   │   ├── tools/
│   │   ├── skills/
│   │   ├── adapters/
│   │   └── docs/
│   └── ...
├── config/
└── cache/
```

Нужно реализовать:

- release metadata format;
- immutable release layout;
- install release;
- list installed releases;
- verify release integrity;
- resolve project pin;
- error states для missing/corrupt/incompatible release;
- cache policy;
- cross-platform paths.

Пример:

```text
project/harness.yaml
        ↓
harness.release = 0.10.4
        ↓
release resolver
        ↓
installed immutable release
```

## 6. Этап 3 — Migration из repository-embedded Harness

Нужно поддержать существующие проекты, где Harness Core хранится внутри repository.

Migration должна:

1. определить текущую Harness/version/schema;
2. классифицировать tracked files по ownership;
3. сохранить project-owned artifacts;
4. определить modified shared/Harness-owned files;
5. не удалять пользовательские изменения молча;
6. создать новый `harness.yaml`;
7. установить требуемую Harness distribution;
8. создать/обновить thin bootstrap instructions;
9. перенести operational state в clone-local storage;
10. валидировать результат;
11. сформировать migration report.

Migration должна быть:

- versioned;
- идемпотентной где возможно;
- dry-run capable;
- безопасной при прерывании;
- explicit по destructive actions.

## 7. Этап 4 — Extraction Harness Core

Перенести общую детерминированную логику из template repository в устанавливаемый Core.

Кандидаты:

- canonical command parser;
- command transition state machine;
- execution state;
- dispatcher semantics;
- validators;
- project detection;
- project status;
- projection builders;
- review gates;
- Git preflight/safety;
- migration engine;
- release/update resolution;
- core skills metadata.

Перенос не должен быть механическим copy-paste.

Для каждого модуля определить:

- public contract;
- input/output;
- filesystem boundary;
- project-owned dependencies;
- release-owned dependencies;
- deterministic tests.

После extraction template repository перестаёт быть runtime implementation source для уже перенесённого functionality.

## 8. Этап 5 — CLI как настоящий control plane

После появления Core CLI может стать стабильным command surface над protocol engine.

Возможное направление:

```bash
harness project status
harness project reconcile
harness step list
harness step show STEP-017
harness step plan STEP-017
harness step implement STEP-017
harness step review STEP-017
harness step run STEP-017
harness git check
```

Точные команды должны быть определены PRODUCT_REQUIREMENTS/ADR до реализации.

Важно разделять:

### CLI maintenance commands

```text
harness setup
harness doctor
harness validate
harness update
harness info/status
```

### Harness development protocol

```text
PROJECT ...
STEP ...
GIT ...
SKILL ...
RELEASE ...
```

CLI presentation layer не должен дублировать state-machine logic Core.

## 9. Этап 6 — Runtime Adapter Contract

Определить runtime-neutral контракт.

Концептуально:

```text
RuntimeAdapter
├── capabilities()
├── identity()
├── execute(...)
├── resume(...)
└── ...
```

Нужно определить:

- capability discovery;
- authentication/status;
- explicit project root;
- run identity;
- resume semantics;
- cancellation;
- model/effort mapping;
- permission boundary;
- structured events;
- failure taxonomy.

Первыми adapters могут быть Codex и Claude Code.

Adapter не должен становиться вторым source of truth protocol semantics.

## 10. Этап 7 — Local Integration API

Core должен иметь machine-readable integration surface для внешних инструментов.

Цель — чтобы integrations не реализовывали самостоятельно:

- artifact parsing;
- project detection;
- command transitions;
- status calculation;
- release resolution;
- validation rules.

Минимальные направления API:

- project inspect;
- project validate;
- artifact list/show;
- command availability;
- current execution state;
- release info;
- diagnostics.

Transport определить отдельно: library API, local process protocol, MCP-like interface или другой механизм.

Не фиксировать transport раньше, чем определён Core API contract.

## 11. Этап 8 — Distribution и release hardening

После стабилизации Core:

- npm package остаётся первым удобным distribution channel;
- исследовать standalone binaries для Linux/macOS/Windows;
- release automation;
- checksums/signatures;
- provenance;
- compatibility matrix;
- rollback installed release;
- garbage collection старых releases;
- offline installation story.

Архитектура должна оперировать понятием Harness Distribution, а не предполагать npm как единственный вариант.

## 12. Отдельные cross-cutting требования

На каждом этапе учитывать:

### Cross-platform

Поддерживать Linux, macOS и Windows.

### Machine-readable output

Команды, предназначенные для integrations, должны иметь стабильный structured output mode.

### Exit codes

Exit codes должны быть документированы и детерминированы.

### Safety

По умолчанию:

- без destructive Git operations;
- без silent overwrite project files;
- без выполнения недоверенных hooks/scripts из release;
- без path traversal за разрешённые boundaries.

### Tests

Для deterministic logic обязательны tests.

Минимальный quality gate:

```bash
npm run typecheck
npm test
npm run build
```

## 13. Порядок реализации

Текущая рекомендуемая последовательность:

```text
1. PRODUCT_REQUIREMENTS + ARCHITECTURE + MIGRATION contracts
          ↓
2. Immutable Release Store / Resolver
          ↓
3. Migration from repository-embedded Harness
          ↓
4. Harness Core extraction
          ↓
5. CLI protocol control plane
          ↓
6. Runtime Adapter Contract
          ↓
7. Local Integration API
          ↓
8. Distribution/release hardening
```

Не начинать большой следующий slice без актуализации этого документа и соответствующих product requirements.

## 14. Что не считается принятым решением

Пока явно не утверждено отдельным contract/ADR:

- конкретный transport Local Integration API;
- финальный CLI syntax для полного protocol command surface;
- standalone packaging technology;
- обязательность какого-либо GUI;
- конкретная схема запуска Codex/Claude из CLI;
- отказ от repository bootstrap `AGENTS.md` / `CLAUDE.md`.

Не превращать эти варианты в архитектурные предпосылки без отдельного решения.
