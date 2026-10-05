# Продуктовые требования Harness CLI v1

## 1. Назначение

Этот документ фиксирует канонические продуктовые требования к Harness CLI v1.

Он описывает **что система обязана обеспечивать**, но не подменяет собой архитектурный документ. Внутреннее устройство, границы модулей и выбранные технологии должны фиксироваться отдельно в `docs/ARCHITECTURE.md` и, при необходимости, ADR.

Канонический порядок работ находится в `docs/ROADMAP.md`.

## 2. Статусы требований

- **MUST** — обязательно для стабильного Harness CLI v1.
- **COMPAT** — обязательно для поддерживаемой миграции существующих repository-embedded проектов.
- **PLANNED** — входит в целевую архитектуру, но не блокирует первый стабильный CLI.
- **NON-GOAL** — явно не является обязательной частью v1.

Идентификаторы `CLI-REQ-XXX` стабильны. Нельзя переиспользовать существующий ID для требования с другим смыслом.

## 3. Цели и границы продукта

- **CLI-REQ-001 · MUST.** Harness CLI должен позволить вынести общую реализацию Harness из пользовательских репозиториев в отдельно устанавливаемый продукт.
- **CLI-REQ-002 · MUST.** Долговременные проектные знания — requirements, ADR, STEP, reviews, audits, evidence и project-specific skills — должны оставаться в Git-репозитории проекта.
- **CLI-REQ-003 · MUST.** Вычислимые операции — parsing, validation, state transitions, Git safety, release resolution, locking и migration mechanics — должны выполняться детерминированным кодом.
- **CLI-REQ-004 · MUST.** Семантика Harness Core не должна зависеть от Codex, Claude Code или другого конкретного runtime.
- **CLI-REQ-005 · MUST.** Интеграция Harness не должна по умолчанию ломать нативные permission prompts, approvals, вопросы пользователю, аутентификацию и TTY-взаимодействие runtime.
- **CLI-REQ-006 · MUST.** Архитектура должна оперировать понятием Harness Distribution, а не считать npm единственным способом поставки.
- **CLI-REQ-007 · NON-GOAL.** GUI не является обязательным компонентом Harness CLI v1.
- **CLI-REQ-008 · NON-GOAL.** CLI v1 не обязан быть process supervisor для Codex или Claude Code.
- **CLI-REQ-009 · NON-GOAL.** Глобальная база Harness не должна заменять Git как source of truth project artifacts.

## 4. Версионирование

- **CLI-REQ-010 · MUST.** Версия CLI-пакета имеет единственный source of truth: `package.json -> version`.
- **CLI-REQ-011 · MUST.** `harness --version` должен использовать версию из package metadata.
- **CLI-REQ-012 · MUST.** CLI package version, Harness release и project schema version являются независимыми областями версионирования.
- **CLI-REQ-013 · MUST.** `harness.yaml` должен содержать явную `schemaVersion`.
- **CLI-REQ-014 · MUST.** `harness.yaml` должен содержать явный pin Harness release.
- **CLI-REQ-015 · MUST.** Ошибки и машиночитаемый вывод должны явно различать CLI version, Harness release и schema version.

## 5. Обнаружение проекта

- **CLI-REQ-020 · MUST.** Команды, которым нужен project context, должны определять корень проекта через Git.
- **CLI-REQ-021 · MUST.** Запуск из вложенного каталога должен корректно разрешаться в корневой Git repository.
- **CLI-REQ-022 · MUST.** Вне Git repository команда, требующая project context, должна завершаться с понятной ошибкой и ненулевым exit code.
- **CLI-REQ-023 · MUST.** CLI должен отличать обычный Git repository, подготовленный Harness project, legacy repository-embedded Harness project и повреждённую/неподдерживаемую конфигурацию.
- **CLI-REQ-024 · MUST.** Project detection должен быть read-only и не должен автоматически изменять repository.

## 6. Контракт harness.yaml

- **CLI-REQ-030 · MUST.** `harness.yaml` является канонической tracked-конфигурацией Harness для конкретного проекта.
- **CLI-REQ-031 · MUST.** Release pin должен иметь поддерживаемый semver-формат.
- **CLI-REQ-032 · MUST.** Конфигурация должна поддерживать `project.initialized`, `project.name` и `project.initializedAt`.
- **CLI-REQ-033 · MUST.** Конфигурация должна поддерживать execution policy, включая `maxFixReviewCycles` и timeout verification commands.
- **CLI-REQ-034 · MUST.** Конфигурация должна поддерживать policy специализированных reviewers, как минимум security и tests.
- **CLI-REQ-035 · MUST.** Конфигурация должна поддерживать язык по умолчанию и отдельные language overrides для человекочитаемого контента.
- **CLI-REQ-036 · MUST.** Пути к project-owned artifacts должны задаваться конфигурацией или иметь документированные defaults.
- **CLI-REQ-037 · MUST.** Новый project contract не должен требовать repository-embedded путей управляющего слоя вроде `.harness/tools/**` или `.harness/docs/**`.
- **CLI-REQ-038 · MUST.** Неизвестные, некорректные и несовместимые значения конфигурации должны диагностироваться детерминированно.
- **CLI-REQ-039 · MUST.** Настраиваемые пути не должны позволять неявный выход за разрешённые границы repository.

## 7. Глобальное и clone-local состояние

- **CLI-REQ-050 · MUST.** Global data/cache/config paths должны определяться кроссплатформенно и не зависеть от Unix-only home layout.
- **CLI-REQ-051 · MUST.** Глобальное хранилище должно иметь отдельную область для установленных Harness releases.
- **CLI-REQ-052 · MUST.** Requirements, ADR, STEP, reviews и другие project-owned artifacts не должны иметь отдельную каноническую копию в global storage.
- **CLI-REQ-053 · MUST.** Операционное состояние конкретного clone/worktree должно разрешаться через `git rev-parse --git-path ai-harness`.
- **CLI-REQ-054 · MUST.** Реализация не должна предполагать, что `.git` всегда является обычной директорией в корне проекта.
- **CLI-REQ-055 · MUST.** Execution locks, temporary state, runtime session metadata и cache не должны попадать в tracked project files.
- **CLI-REQ-056 · PLANNED.** Clone-local state должен позволять безопасно возобновлять поддерживаемые executions после прерывания.

## 8. Команда setup

- **CLI-REQ-060 · MUST.** `harness setup` должен подготавливать существующий Git repository к работе с Harness.
- **CLI-REQ-061 · MUST.** `setup` не должен копировать полный Harness Core внутрь проекта.
- **CLI-REQ-062 · MUST.** При отсутствии `harness.yaml` команда должна создать валидную начальную конфигурацию.
- **CLI-REQ-063 · MUST.** Существующий `harness.yaml` не должен молча перезаписываться.
- **CLI-REQ-064 · MUST.** Отсутствующие project directories должны создаваться без удаления или перезаписи существующего содержимого.
- **CLI-REQ-065 · MUST.** При отсутствии `AGENTS.md` должен создаваться минимальный runtime-neutral bootstrap; существующий файл не перезаписывается молча.
- **CLI-REQ-066 · MUST.** При отсутствии `CLAUDE.md` может создаваться минимальный Claude Code adapter; существующий файл не перезаписывается молча.
- **CLI-REQ-067 · MUST.** Локальный private brief должен безопасно добавляться в `.gitignore`, если он предусмотрен project contract.
- **CLI-REQ-068 · MUST.** `setup` должен подготовить clone-local state path.
- **CLI-REQ-069 · MUST.** `harness setup` не заменяет semantic-команду `PROJECT INIT`; после setup проект может оставаться `initialized: false`.
- **CLI-REQ-070 · MUST.** После появления Release Store `setup` должен гарантировать доступность pinned Harness release или выдавать явную ошибку установки/разрешения.

## 9. Команды doctor, validate и status

- **CLI-REQ-080 · MUST.** `harness doctor` является read-only диагностикой окружения и project structure.
- **CLI-REQ-081 · MUST.** `doctor` должен проверять Git, `harness.yaml`, обязательные project paths, clone-local state и global storage.
- **CLI-REQ-082 · MUST.** После появления Release Store `doctor` должен различать valid, missing, corrupt и incompatible pinned release.
- **CLI-REQ-083 · MUST.** Блокирующая проблема в `doctor` должна приводить к ненулевому exit code.
- **CLI-REQ-084 · MUST.** `harness validate` должен быть read-only.
- **CLI-REQ-085 · MUST.** `validate` должен проверять project config по поддерживаемой schema version и показывать предметную диагностику.
- **CLI-REQ-086 · MUST.** `validate` должен иметь стабильный машиночитаемый режим.
- **CLI-REQ-087 · MUST.** `harness status` должен выводить только детерминированно установленные факты.
- **CLI-REQ-088 · MUST.** `status` должен включать как минимум project root, schema version, pinned Harness release, initialization state и clone-local state path.
- **CLI-REQ-089 · MUST.** `status` должен иметь стабильный машиночитаемый режим.

## 10. Harness Distribution и immutable releases

- **CLI-REQ-100 · MUST.** Успешно установленный Harness release является immutable и не изменяется на месте.
- **CLI-REQ-101 · MUST.** Каждый release должен иметь однозначную версию и версионированный metadata format.
- **CLI-REQ-102 · MUST.** Формат release должен поддерживать проверку целостности.
- **CLI-REQ-103 · MUST.** Глобальное хранилище должно позволять одновременно иметь несколько releases.
- **CLI-REQ-104 · MUST.** Project pin должен однозначно разрешаться в конкретный установленный release.
- **CLI-REQ-105 · MUST.** При missing/corrupt/incompatible release запрещён silent fallback на `main`, `latest` или другую версию.
- **CLI-REQ-106 · MUST.** Идентичность release не должна зависеть от installation channel.
- **CLI-REQ-107 · MUST.** Обновление установленного CLI/Harness Distribution и migration project schema являются разными операциями.
- **CLI-REQ-108 · MUST.** Обновление CLI не должно молча менять `harness.release` пользовательского проекта.
- **CLI-REQ-109 · MUST.** Перед сменой project pin должна быть доступна проверка compatibility/migration requirements.

## 11. Миграция существующих проектов

- **CLI-REQ-120 · COMPAT.** CLI должен распознавать существующие repository-embedded Harness projects.
- **CLI-REQ-121 · COMPAT.** Migration должна поддерживать `dry-run` с полным планом изменений.
- **CLI-REQ-122 · COMPAT.** Migration должна классифицировать project-owned, Harness-owned, shared/customized и неизвестные файлы.
- **CLI-REQ-123 · COMPAT.** Изменённые пользователем файлы нельзя молча удалять или перезаписывать.
- **CLI-REQ-124 · COMPAT.** Migration должна быть по возможности идемпотентной.
- **CLI-REQ-125 · COMPAT.** Прерывание migration не должно оставлять проект без возможности диагностики и безопасного повторного запуска.
- **CLI-REQ-126 · COMPAT.** Migration должна создавать отчёт с исходным состоянием, выполненными изменениями, конфликтами, ручными действиями и итогом.
- **CLI-REQ-127 · COMPAT.** Legacy operational state должен либо безопасно переноситься в clone-local storage, либо явно инвалидироваться.
- **CLI-REQ-128 · COMPAT.** Удаление legacy Harness-owned files допускается только как часть явного migration plan.

## 12. Protocol Engine и execution state

- **CLI-REQ-140 · PLANNED.** Harness Core должен иметь единый детерминированный parser canonical commands.
- **CLI-REQ-141 · PLANNED.** Допустимые transitions и chain semantics должны задаваться одной machine-readable state model.
- **CLI-REQ-142 · PLANNED.** CLI, runtime adapters и внешние integrations не должны иметь независимые реализации state machine.
- **CLI-REQ-143 · PLANNED.** Нормализация targets вроде `17 -> STEP-017` должна быть общей и детерминированной.
- **CLI-REQ-144 · PLANNED.** Структурно недопустимая команда должна отклоняться до semantic agent work.
- **CLI-REQ-145 · PLANNED.** Активное Harness execution должно иметь машиночитаемое clone/worktree-scoped состояние.
- **CLI-REQ-146 · PLANNED.** Core должен предотвращать небезопасные конкурентные write-executions над одним scope.
- **CLI-REQ-147 · PLANNED.** Поддерживаемые executions должны иметь детерминированный механизм resume.
- **CLI-REQ-148 · PLANNED.** Критическое execution state не должно зависеть только от chat history AI runtime.

## 13. Runtime Adapter Contract

- **CLI-REQ-160 · PLANNED.** Harness Core должен определить единый runtime-neutral adapter contract.
- **CLI-REQ-161 · PLANNED.** Adapter должен уметь сообщать capabilities.
- **CLI-REQ-162 · PLANNED.** Adapter должен предоставлять machine-readable identity/auth state, если runtime имеет такой интерфейс.
- **CLI-REQ-163 · PLANNED.** Любой runtime execution должен получать явный `projectRoot`.
- **CLI-REQ-164 · PLANNED.** Ошибка выбранного runtime не должна приводить к silent fallback на другой runtime.
- **CLI-REQ-165 · PLANNED.** Контракт должен определить resume и cancellation там, где runtime это поддерживает.
- **CLI-REQ-166 · PLANNED.** Model/effort относятся к runtime adapter/profile и не меняют семантику Harness protocol.

## 14. Git safety

- **CLI-REQ-180 · MUST.** CLI по умолчанию не выполняет destructive Git operations.
- **CLI-REQ-181 · MUST.** Force push, hard reset и аналогичные действия не должны появляться как неявное поведение.
- **CLI-REQ-182 · COMPAT.** Массовая migration должна учитывать dirty working tree.
- **CLI-REQ-183 · COMPAT.** Сложная mutation operation должна иметь детерминированный план изменений до применения.

## 15. Локальный интеграционный API

- **CLI-REQ-200 · PLANNED.** Core должен предоставлять стабильный машиночитаемый interface внешним инструментам.
- **CLI-REQ-201 · PLANNED.** Editor integrations не должны повторно реализовывать artifact parsing, project detection, protocol state и validation rules, если это уже предоставляет Core.
- **CLI-REQ-202 · PLANNED.** API должен в перспективе покрывать project inspect/validate, artifact list/show, command availability, execution state, release info и diagnostics.
- **CLI-REQ-203 · NON-GOAL.** Product requirements не фиксируют конкретный transport Local Integration API; это отдельное архитектурное решение.

## 16. CLI UX и машиночитаемый вывод

- **CLI-REQ-210 · MUST.** Интерактивные команды должны иметь понятный человекочитаемый вывод.
- **CLI-REQ-211 · MUST.** Команды для automation/integrations должны иметь стабильный структурированный режим вывода.
- **CLI-REQ-212 · MUST.** Диагностические ошибки должны отделяться от обычного успешного вывода.
- **CLI-REQ-213 · MUST.** Exit codes должны быть документированы и детерминированы.
- **CLI-REQ-214 · MUST.** Exit codes должны как минимум различать success, invalid input/config, missing project context, release failure и deterministic operation failure.
- **CLI-REQ-215 · MUST.** Ожидаемая пользовательская ошибка должна показываться как предметная диагностика, а не как необработанный stack trace.

## 17. Кроссплатформенность и безопасность

- **CLI-REQ-220 · MUST.** Целевые платформы v1: Linux, macOS и Windows.
- **CLI-REQ-221 · MUST.** CLI не должен предполагать Unix-only path separators или home layout.
- **CLI-REQ-222 · MUST.** Где возможно, внешние команды запускаются без неявной shell-интерпретации пользовательских данных.
- **CLI-REQ-223 · MUST.** Git-private paths должны разрешаться через Git, если ручное построение `.git/...` нарушает worktree compatibility.
- **CLI-REQ-224 · MUST.** Config paths и CLI operations не должны позволять path traversal за разрешённые границы.
- **CLI-REQ-225 · MUST.** CLI не должен автоматически выполнять недоверенные install/bootstrap/hooks scripts из Harness release без отдельной trust model.
- **CLI-REQ-226 · MUST.** Authentication secrets не должны требоваться в tracked `harness.yaml`.
- **CLI-REQ-227 · MUST.** Release format должен позволять integrity verification.

## 18. Совместимость и source of truth

- **CLI-REQ-240 · COMPAT.** До переноса конкретной функции актуальный `ai-development-harness-template/main` остаётся reference её текущего поведения.
- **CLI-REQ-241 · PLANNED.** После extraction функции в CLI/Core template repository не должен оставаться второй независимой runtime-реализацией той же функции.
- **CLI-REQ-242 · MUST.** Должна существовать явная compatibility model между CLI package version, Harness release и project schema version.

## 19. Тестирование и качество

- **CLI-REQ-250 · MUST.** Базовый quality gate: `npm run typecheck`, `npm test`, `npm run build`.
- **CLI-REQ-251 · MUST.** Новая детерминированная логика должна сопровождаться automated tests.
- **CLI-REQ-252 · MUST.** Setup, migration, storage и release operations должны тестироваться на временных файловых структурах, а не только через unit mocks.
- **CLI-REQ-253 · MUST.** Критические Git-aware сценарии должны тестироваться на временных Git repositories; worktree покрывается там, где это влияет на поведение.
- **CLI-REQ-254 · MUST.** Негативные тесты должны покрывать invalid config, missing files, non-Git directory, corrupt release, incompatible version и повторную/interrupted migration после её появления.

## 20. Распространение

- **CLI-REQ-260 · MUST.** Первым публичным каналом распространения может быть npm package `@ai-development-harness/cli`.
- **CLI-REQ-261 · MUST.** При npm-distribution должен поддерживаться bootstrap через `npx` без обязательной глобальной установки.
- **CLI-REQ-262 · MUST.** Архитектура не должна блокировать будущую standalone distribution для Linux/macOS/Windows.
- **CLI-REQ-263 · PLANNED.** Должен быть предусмотрен сценарий offline installation Harness release.

## 21. Явные non-goals

- **CLI-REQ-270 · NON-GOAL.** Не считать GUI обязательной частью продукта.
- **CLI-REQ-271 · NON-GOAL.** Не считать запуск Codex/Claude через CLI обязательным для v1.
- **CLI-REQ-272 · NON-GOAL.** Не считать npm единственной допустимой distribution model.
- **CLI-REQ-273 · NON-GOAL.** Не выполнять потенциально разрушающую migration автоматически без явного действия пользователя.
- **CLI-REQ-274 · NON-GOAL.** Не переносить каноническое project knowledge из Git в скрытое глобальное хранилище.

## 22. Трассируемость

Следующие документы и крупные implementation issues должны ссылаться на соответствующие `CLI-REQ-XXX`:

- `docs/ARCHITECTURE.md`;
- `docs/MIGRATION.md`;
- будущие ADR;
- issues последующих этапов `docs/ROADMAP.md`.

Если реализация намеренно отступает от требования, сначала должен быть обновлён этот продуктовый контракт или принято отдельное решение, явно заменяющее соответствующий `CLI-REQ-XXX`.

## 23. Критерии готовности этого документа

- Документ находится в `docs/PRODUCT_REQUIREMENTS.md`.
- Нормативные требования имеют стабильные `CLI-REQ-XXX`.
- Обязательные, compatibility, planned и non-goal требования различимы.
- GUI не считается обязательной частью продукта.
- CLI package version, Harness release и project schema version разделены.
- Harness Core не требуется хранить внутри пользовательского repository.
- Конкретный transport Local Integration API не зафиксирован преждевременно.
- Документ написан на русском языке.
