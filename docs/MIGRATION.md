# Миграция repository-embedded Harness в thin repository

## 1. Назначение

Этот документ определяет безопасную миграцию существующего проекта AI Development Harness из legacy-архитектуры, где Harness Core и tooling хранятся внутри пользовательского repository, в новую архитектуру с устанавливаемым Harness CLI/Core.

Документ описывает migration contract и алгоритм. Он не реализует миграцию и не фиксирует формат Harness Distribution — это следующие этапы ROADMAP.

Связанные документы:

- `docs/PRODUCT_REQUIREMENTS.md`;
- `docs/ARCHITECTURE.md`;
- `docs/ROADMAP.md`.

Основные требования: `CLI-REQ-120`–`CLI-REQ-128`, `CLI-REQ-182`, `CLI-REQ-183`, а также `CLI-REQ-001`, `CLI-REQ-002`, `CLI-REQ-037`, `CLI-REQ-050`–`CLI-REQ-055`, `CLI-REQ-100`–`CLI-REQ-109`.

## 2. Что считается legacy repository-embedded Harness

Legacy-проект — это Git repository, в котором общая реализация Harness частично или полностью хранится как tracked files самого проекта.

Типичные признаки:

```text
.harness/
  docs/
  tools/
  harness-update.toml
  harness-update-graph.json
  harness.lock.json
  command-transitions.json
  reasoning-boundaries.json
  runtime-adapter-contract.json

.agents/skills/
.codex/
.claude/
AGENTS.md
CLAUDE.md
```

Наличие одного такого пути само по себе не означает, что файл можно удалить: часть путей является shared/project-customized, а часть `.agents/skills/**` может содержать project-specific или third-party skills.

## 3. Целевое состояние

После успешной миграции:

```text
project/
├── harness.yaml
├── AGENTS.md
├── CLAUDE.md
├── docs/
├── planning/
├── src/
├── tests/
└── ... project-owned files

Git private path:
└── ai-harness/
    └── migration/execution state

Global Harness storage:
└── immutable Harness release
```

В repository больше не требуется полный Harness Core (`.harness/tools/**`, `.harness/docs/**` и аналогичные общие implementation files).

Project-owned artifacts остаются tracked и не переносятся в global storage.

## 4. Основные инварианты миграции

### 4.1 Никакого silent data loss

Ни один tracked или untracked пользовательский файл не удаляется и не перезаписывается без того, чтобы migration plan однозначно классифицировал его и разрешал конкретную операцию.

Неизвестный файл по умолчанию сохраняется.

Связанные требования: `CLI-REQ-123`, `CLI-REQ-128`.

### 4.2 Read-only preflight до первой записи

До первой repository mutation migration engine обязан полностью выполнить:

```text
inspect
→ baseline resolution
→ ownership classification
→ conflict detection
→ target compatibility check
→ plan generation
```

Если заранее обнаруживаемый blocker существует, repository не изменяется.

### 4.3 Plan и Apply разделены

`MigrationPlanner` является read-only.

`MigrationExecutor` принимает конкретный immutable migration plan и не пересчитывает опасные решения «на лету».

Это обеспечивает `dry-run`, воспроизводимость и auditability.

Связанные требования: `CLI-REQ-121`, `CLI-REQ-183`.

### 4.4 Baseline нельзя угадывать

Legacy baseline должен быть доказуем.

Допустимые источники baseline в порядке доверия:

1. валидный legacy lock с immutable release ref/commit;
2. explicit release tag, указанный пользователем, если он согласован с legacy manifest;
3. иной будущий cryptographically/verifiably pinned source, определённый release contract.

Недопустимо:

- выбирать «наиболее похожий release»;
- считать `main` baseline;
- автоматически выбирать `latest`;
- выводить baseline только из сходства файлов.

Если baseline доказать нельзя, migration останавливается со статусом `BASELINE_REQUIRED`.

### 4.5 Migration не является update

Операции разделены:

```text
CLI/Harness Distribution update
≠
project migration
≠
project release pin change
```

Миграция не должна молча повышать `harness.release` до latest.

Target release передаётся явно или выводится из доказанного legacy release по документированной compatibility policy.

Связанные требования: `CLI-REQ-107`–`CLI-REQ-109`.

## 5. Жизненный цикл

Канонический lifecycle:

```text
INSPECT
  ↓
RESOLVE BASELINE
  ↓
CLASSIFY
  ↓
PLAN
  ↓
DRY-RUN / USER DECISION
  ↓
PREPARE CHECKPOINT
  ↓
APPLY
  ↓
VERIFY
  ↓
FINALIZE
  ↓
REPORT
```

Если выполнение прервано после `PREPARE CHECKPOINT`, следующий запуск должен определить незавершённую migration и предложить безопасный `resume` или документированный abort/recovery path.

## 6. INSPECT — определение исходного состояния

Inspector работает read-only.

Он собирает:

- Git root;
- Git worktree identity;
- dirty/untracked state;
- наличие `harness.yaml`;
- наличие legacy `.harness/manifest.yaml`;
- legacy Harness release/version;
- legacy lock;
- legacy update policy;
- список tracked files;
- relevant untracked collisions;
- configured project artifact paths;
- known legacy runtime adapter/config paths;
- legacy operational state;
- уже существующий migration checkpoint/report.

Результат Inspector не должен содержать semantic guesses.

Пример классификации исходного проекта:

```text
not-git
git-non-harness
legacy-harness-supported
legacy-harness-baseline-required
legacy-harness-unsupported
migration-in-progress
thin-harness-current
thin-harness-invalid
```

Связанные требования: `CLI-REQ-020`–`CLI-REQ-024`, `CLI-REQ-120`.

## 6.1 Текущая implementation compatibility

Первый versioned legacy compatibility descriptor реализуется для Harness release `0.10.4` / tag `v0.10.4`.

Descriptor содержит:

- immutable source repository/ref/commit;
- ownership policy именно этого release;
- Git blob SHA baseline-owned файлов.

Это позволяет read-only Inspector сравнивать локальные bytes с доказанным historical baseline без обращения к moving `main`.

Другие historical releases не выводятся по сходству файлов и до добавления отдельного versioned descriptor возвращают `UNSUPPORTED_LEGACY_RELEASE`.

## 7. Baseline resolution

### 7.1 Legacy lock

Если существует legacy lock, engine проверяет:

- schema lock;
- declared Harness release;
- immutable tag/ref;
- commit pin, если формат lock его поддерживает;
- согласованность с legacy manifest release;
- соответствие Harness-owned files baseline там, где это требуется для доказательства ownership.

Stale/moved tag или неконсистентный lock является blocker, а не поводом автоматически переписать lock.

### 7.2 Explicit adoption baseline

Если lock отсутствует, допускается explicit baseline:

```text
--from vX.Y.Z
```

Baseline обязан быть совместим с release, указанным legacy manifest.

Для полностью Harness-owned legacy files engine должен уметь проверить, что их состояние соответствует baseline, либо классифицировать divergence как customized/conflict.

### 7.3 Unsupported baseline

Поддерживаемый диапазон legacy releases должен определяться compatibility metadata/implementation, а не этим документом.

Unsupported release возвращает отдельную диагностическую категорию и не запускает частичную миграцию.

## 8. Ownership classification

Каждый path, затрагиваемый migration, получает ровно одну primary classification.

### 8.1 `project-owned`

Файл принадлежит проекту и сохраняется.

Примеры:

- requirements;
- ADR;
- STEP;
- reviews/audits/evidence;
- architecture docs;
- project source/tests;
- project-specific skills;
- project-specific templates;
- локальные пользовательские документы.

Допустимые операции:

- preserve;
- schema migration, если она отдельно описана;
- rename/move только по явному plan;
- additive transformation с сохранением user content.

### 8.2 `harness-owned-clean`

Legacy Harness-owned файл доказуемо совпадает с baseline и в thin repository больше не нужен.

Примеры legacy-классов:

- `.harness/tools/**`;
- `.harness/docs/**`;
- Harness-owned protocol metadata;
- core skills, перечисленные baseline ownership policy;
- legacy updater implementation.

После успешной установки/проверки target Harness Distribution такой файл может быть удалён по migration plan.

### 8.3 `harness-owned-modified`

Path считается Harness-owned по baseline, но local bytes отличаются.

По умолчанию это blocker.

Engine не имеет права решить, что modification «неважна».

Plan должен:

- сохранить исходные bytes;
- показать baseline hash/current hash;
- потребовать явного решения;
- при поддерживаемой политике позволить сохранить файл как project-owned/custom override вместо удаления.

### 8.4 `shared-customized`

Файл исторически содержал одновременно Harness bootstrap и project-specific настройки.

Типичные legacy-кандидаты:

- `AGENTS.md`;
- `CLAUDE.md`;
- `.codex/config.toml`;
- `.codex/agents/**`;
- `.claude/settings.json`;
- `.claude/agents/**`;
- `.github/**`;
- `.gitignore`;
- `.gitmessage`;
- legacy manifest;
- project README blocks.

Для shared path нельзя применять unconditional delete/replace.

Migration должна иметь path-specific strategy:

- preserve;
- extract project configuration;
- replace only known Harness-owned bootstrap block;
- merge additive structure;
- либо block, если безопасное преобразование не доказано.

### 8.5 `unknown`

Файл не классифицирован baseline policy и не является известным project artifact.

Default action: `PRESERVE`.

Unknown path не удаляется только потому, что находится под `.harness/` или `.agents/`.

## 9. Источник ownership rules

Для legacy release ownership rules должны браться из доказанного baseline release, а не из текущего `main`.

Это важно, потому что ownership менялся между Harness releases.

Текущая legacy policy использует категории Harness-owned, shared и marker-merge; новая migration model расширяет их до конечных migration classifications, но сохраняет принцип baseline-relative ownership.

Если baseline policy отсутствует или недостаточна для конкретного historical release, требуется explicit compatibility mapping в Migration Engine.

## 10. Dirty working tree

Migration обязана учитывать незакоммиченные изменения.

### 10.1 Tracked modifications

Если dirty tracked path входит в mutation scope plan, migration блокируется до явного решения.

### 10.2 Unrelated tracked modifications

Если dirty path доказуемо не пересекается с mutation scope, dry-run может быть разрешён.

Apply может быть разрешён только если implementation гарантирует, что unrelated changes не будут затронуты; иначе операция блокируется консервативно.

### 10.3 Untracked collisions

Если migration должна создать/переместить файл в path, где уже есть untracked file, это blocker.

Нельзя silently overwrite untracked data.

Связанные требования: `CLI-REQ-182`.

## 11. Формирование нового harness.yaml

Новый `harness.yaml` строится из project-owned частей legacy manifest и target schema contract.

### 11.1 Сохраняемые значения

При наличии валидных legacy значений сохраняются:

- `project.initialized`;
- `project.name`;
- `project.initializedAt`;
- execution policy;
- review policy;
- skills search policy;
- language policy;
- project-owned source paths;
- protocol artifact directories.

### 11.2 Не переносятся как project contract

Legacy control-plane paths не должны попадать в новый `harness.yaml`:

- `.harness/tools/**`;
- `.harness/docs/**`;
- legacy updater policy paths;
- legacy validator path;
- legacy CI implementation path;
- internal runtime-adapter implementation paths.

### 11.3 Release pin

`harness.release` задаётся явным target Harness release.

Если migration выполняется без upgrade, target может совпадать с legacy release при наличии совместимого Harness Distribution.

Если target отличается, compatibility/migration requirements должны быть проверены до Apply.

### 11.4 Schema version

Новая `schemaVersion` соответствует target project contract, а не legacy manifest generation/version.

## 12. Harness Distribution prerequisite

До удаления `harness-owned-clean` files migration должна доказать, что target Harness Distribution:

- установлен либо готов к атомарной/проверяемой установке;
- соответствует target release;
- прошёл integrity verification;
- совместим с target project schema.

Пока #8/#9 не реализованы, этот шаг остаётся архитектурной зависимостью и не должен эмулироваться копированием файлов обратно в repository.

## 13. Bootstrap AGENTS.md и CLAUDE.md

Цель миграции — оставить тонкий bootstrap, а не новый большой встроенный manual.

### 13.1 AGENTS.md

Migration должна:

- сохранить project-specific instructions;
- удалить/заменить только доказуемо Harness-owned bootstrap sections;
- добавить минимальную ссылку на installed Harness integration/contract;
- сохранить project-specific skill routing, если он остаётся актуален.

Если границы generated/project blocks в historical version не доказуемы, файл классифицируется как `shared-customized` и migration не делает destructive rewrite.

### 13.2 CLAUDE.md

Целевая роль — thin Claude adapter поверх общих project instructions.

Project-specific Claude instructions сохраняются.

Нельзя заменять целиком существующий customized `CLAUDE.md` только потому, что target bootstrap короче.

## 14. Runtime-specific legacy directories

`.codex/**` и `.claude/**` не удаляются wholesale.

Для каждого файла migration должна установить, содержит ли он:

- Harness-owned runtime adapter implementation;
- project-specific runtime configuration;
- user customization;
- смешанное содержимое.

Только доказуемо obsolete Harness-owned implementation может быть удалено автоматически.

Project-specific configuration сохраняется или преобразуется отдельным path-specific migration rule.

## 15. Skills migration

`.agents/skills/**` требует поэлементной классификации.

Legacy baseline может перечислять core skills, принадлежащие Harness.

Правила:

1. baseline core skill без local modifications → может быть удалён после установки target Distribution;
2. baseline core skill с local modifications → blocker/customized;
3. skill, отсутствующий в baseline core list → по умолчанию project/third-party и сохраняется;
4. installed third-party skill никогда не удаляется из-за совпадения имени с новым core skill без дополнительного доказательства provenance.

## 16. Project document schema migration

Переход control plane и migration project document schemas — связанные, но разные операции внутри одного plan.

Если target project schema требует преобразования REQ/ADR/STEP/OQ/templates, plan должен перечислять это отдельно.

Сохраняются инварианты текущего Harness migration подхода:

- не выдумывать отсутствующий semantic content;
- сохранять legacy prose/metadata;
- historical immutable reports не переписывать;
- project values не заменять protocol defaults без необходимости;
- generated projections пересобирать из canonical artifacts;
- non-additive ambiguity считать blocker;
- повторный запуск без изменений не создаёт новый semantic result.

Подробная schema-specific логика должна версионироваться отдельно от общего migration orchestrator.

## 17. Legacy operational state

Tracked project migration и clone-local operational-state migration — разные boundaries.

Legacy state наподобие `.harness/local/**` нельзя просто копировать в tracked project contract.

Алгоритм:

1. определить известный legacy state schema;
2. валидировать исходное состояние;
3. преобразовать в target clone-local schema in-memory;
4. повторно валидировать;
5. записать в Git private `ai-harness` path через atomic replace;
6. только после успешной записи пометить legacy state как migrated/retired.

Неизвестный persistent state format:

- не удаляется;
- фиксируется в report;
- может блокировать migration, если потеря state делает active execution небезопасным.

Связанные требования: `CLI-REQ-127`, `CLI-REQ-053`–`CLI-REQ-056`.

## 18. Active execution

Если legacy state показывает активное Harness execution, migration по умолчанию блокируется.

Разрешение возможно только если существует отдельный доказанный migration path active execution state в новый Core без потери resume semantics.

Нельзя завершать или сбрасывать active execution молча.

## 19. Migration plan

Plan является immutable input для Apply и содержит минимум:

```text
migrationId
source:
  projectRoot
  legacyRelease
  legacySchema
  baselineIdentity
target:
  harnessRelease
  projectSchema
preconditions:
  gitState
  requiredDistribution
operations:
  - path
    classification
    action
    sourceHash
    expectedBaselineHash
    targetHash/targetDescriptor
conflicts:
warnings:
verification:
```

Точный serialization format будет выбран при реализации, но semantic fields должны сохраняться.

Каждая mutation operation должна быть адресной. Не допускаются абстрактные операции вида `delete .harness` без enumerated affected paths.

## 19.1 Текущая implementation model плана

Issue #16 реализует `MigrationPlan schemaVersion: 1` как полностью structured read-only результат.

План содержит:

- детерминированный `migrationId`;
- source project identity и Git HEAD;
- доказанный historical baseline;
- target Harness release/schema/digest;
- адресные operations с phase и precondition;
- blockers и warnings;
- deterministic verification steps.

Для tracked mutation precondition использует Git blob SHA текущих working-tree bytes; для legacy operational state — SHA-256 bytes. Поэтому будущий Executor может обнаруживать stale plan без повторного принятия ownership-решений.

`planMigration()` не сохраняет plan автоматически и не изменяет repository. Persist/checkpoint относится к MigrationExecutor (#17).

## 20. Типы операций

Минимальный набор semantic actions:

- `PRESERVE`;
- `CREATE`;
- `REPLACE_GENERATED_BLOCK`;
- `TRANSFORM`;
- `MOVE`;
- `DELETE_HARNESS_OWNED_CLEAN`;
- `MIGRATE_LOCAL_STATE`;
- `REGENERATE_PROJECTION`;
- `BLOCK_CONFLICT`.

Каждая операция имеет precondition hash/state.

Если между Plan и Apply исходный path изменился, Apply останавливается с `PLAN_STALE` и требует нового Plan.

## 20.1 Текущая implementation model Executor

Issue #17 реализует execution framework поверх immutable `MigrationPlan`.

Ключевые свойства:

- checkpoint хранится в Git-private `ai-harness/migrations/<migrationId>`;
- saved `plan.json` не пересчитывается при resume;
- journal использует состояния `pending → applying → applied → verified`;
- `applying` — специальное fail-closed состояние: после crash внутри mutation automatic replay запрещён;
- после `applied` сохраняется postcondition, поэтому resume сначала проверяет уже выполненную mutation и не повторяет её;
- preconditions проверяются до первой mutation и повторно перед конкретной pending operation;
- target Harness release digest повторно проверяется перед execution/resume;
- completed checkpoint удаляется после durable фиксации terminal state; durable project migration report относится к transformations/finalization #18.

Concrete handlers для `TRANSFORM`, `REPLACE_GENERATED_BLOCK`, `DELETE_HARNESS_OWNED_CLEAN` и других domain operations намеренно не входят в #17. Executor принимает их через typed operation-handler contract; это не позволяет execution layer повторно принимать ownership/semantic решения.

## 20.2 Versioned v0.10.4 → thin transformations

Issue #18 реализует первый полный domain layer поверх Inspector / Planner / Executor для доказанного legacy baseline `v0.10.4`.

Перед Apply выполняется отдельная preparation phase. Она:

- строит `harness.yaml` in-memory и валидирует его target schema;
- удаляет legacy control-plane field `protocol.file`, сохраняя project-owned settings;
- проверяет configured target paths до первой mutation и блокирует выход за repository boundary;
- готовит exact content + SHA-256 для thin `AGENTS.md` и `CLAUDE.md`;
- допускает автоматическую замену `AGENTS.md` только если изменения ограничены доказанными project marker blocks;
- допускает автоматическую замену `CLAUDE.md` только при доказанном immutable legacy prefix;
- блокирует существующий clone-local execution state вместо silent overwrite.

Apply использует только подготовленный immutable plan:

- known idle legacy execution state переносится ровно одной `MIGRATE_LOCAL_STATE` operation в Git-private `ai-harness/execution/`;
- project/third-party skills, unknown files и runtime-specific project config сохраняются;
- `planning/PLAN.md` и `planning/STATUS.md` для schema v1 сохраняются byte-for-byte и не регенерируются без schema-specific необходимости;
- удаляются только enumerated `harness-owned-clean` paths с доказанным baseline identity;
- target Harness Distribution повторно проверяется Executor по release digest до mutation/resume;
- каждая mutation имеет собственный postcondition и backup внутри migration checkpoint.

Final verification выполняется до PASS report и проверяет target config/release, path boundaries, required project directories, preserved project-owned/customized artifacts и retirement legacy manifest. Во время этой проверки checkpoint ещё существует, поэтому ожидаемое Inspector state — `migration-in-progress` при уже доказанном thin target. После удаления completed checkpoint orchestrator дополнительно требует `thin-harness-current`.

Durable report создаётся последней project mutation только после PASS deterministic verification. Повторный запуск уже мигрированного проекта возвращает `already-migrated` и zero mutation.

## 20.3 Public migration CLI и compatibility matrix

Issue #19 фиксирует публичный surface:

```text
harness migrate inspect
harness migrate plan [--from <release>] [--target-release <release>] [--out <file>]
harness migrate apply --plan <file>
harness migrate status [migration-id]
harness migrate resume <migration-id>
```

Все команды поддерживают `--json`.

Инварианты CLI:

- `inspect` и `plan` без `--out` read-only;
- `plan --out` сохраняет exact prepared plan только по явному запросу пользователя;
- blocked plan не сохраняется как executable Apply input;
- `apply` не запускает Planner и не пересчитывает ownership/baseline decisions;
- перед Apply prepared descriptors, project identity, HEAD, operation preconditions и target release digest проверяются повторно;
- `status` читает checkpoint fail-closed и способен показать corrupt/recovery-required state без mutation;
- `resume` использует immutable `plan.json` из checkpoint и domain handlers той же versioned migration.

Exit codes migration CLI:

- `0` — команда выполнена / dry-run ready / informational status;
- `1` — execution, parsing, corruption или иной command error;
- `2` — корректно построенный migration plan заблокирован safety/preflight условиями.

### Compatibility matrix

| Legacy release | Baseline descriptor | Automatic thin migration | Статус |
| --- | --- | --- | --- |
| `0.10.4` | immutable `v0.10.4@6832c41...` | да | supported |
| `< 0.10.4` | отсутствует | нет | `UNSUPPORTED_LEGACY_RELEASE` |
| `> 0.10.4` repository-embedded | отдельный descriptor пока отсутствует | нет | unsupported до явной реализации |

На текущем этапе earliest supported и current repository-embedded baseline совпадают: `0.10.4`. Intermediate supported release отсутствует, поэтому regression suite не создаёт фиктивные compatibility claims.

E2E matrix покрывает clean migration, explicit baseline adoption, mismatch, modified Harness-owned/shared paths, project skill preservation, dirty/untracked conflicts, interruption/resume, stale plan, corrupt checkpoint, active execution, idempotency и Git worktree. CI выполняет suite на Linux, macOS и Windows; portable paths дополнительно проверяются независимо от host separator.

## 21. Checkpoint и interruption safety

Перед первой mutation engine создаёт clone-local checkpoint:

```text
<git-private-ai-harness>/migrations/<migrationId>/
├── plan.json
├── journal.json
├── backups/
└── report.partial.json
```

Checkpoint не является заменой Git и не должен содержать новую каноническую копию всего проекта.

Он хранит только данные, необходимые для безопасного resume/recovery текущей migration.

### 21.1 Journal

Для каждой operation журнал фиксирует состояние:

```text
pending
applying
applied
verified
```

После mutation запись должна быть durable до перехода к следующей необратимой операции.

### 21.2 Resume

При повторном запуске engine:

- обнаруживает незавершённый checkpoint;
- валидирует project identity и plan;
- проверяет уже применённые operation postconditions;
- продолжает с первой безопасной pending operation.

### 21.3 Recovery

Если postcondition applied operation нарушен внешним изменением, automatic resume блокируется.

Engine выдаёт diagnostic report и не пытается «угадывать» правильное состояние.

### 21.4 Rollback

Этот contract не обещает универсальную filesystem transaction для всего repository.

Rollback может использовать backups только для операций, для которых он доказуемо безопасен.

Основной safety mechanism — read-only preflight, precondition hashes, journal, idempotent operations и Git recoverability.

Связанные требования: `CLI-REQ-124`, `CLI-REQ-125`.

## 22. Apply ordering

Рекомендуемый порядок mutation:

1. создать/валидировать checkpoint;
2. подготовить target Harness Distribution;
3. мигрировать clone-local operational state;
4. создать новый `harness.yaml` во временный path;
5. выполнить project-owned schema transformations;
6. обновить thin bootstrap/shared files;
7. удалить только enumerated `harness-owned-clean` files;
8. атомарно активировать новый `harness.yaml`, если implementation требует staging;
9. regenerate projections;
10. выполнить verification;
11. finalize report/checkpoint.

Критический принцип: removal legacy control plane происходит только после готовности external target control plane.

## 23. Verification

Migration считается успешной только после deterministic verification.

Минимальные проверки:

- Git repository по-прежнему доступен;
- новый `harness.yaml` проходит target schema validation;
- project paths не выходят за repository boundaries;
- target Harness release разрешается и проходит integrity check;
- clone-local state валиден;
- все planned operations имеют ожидаемые postconditions;
- отсутствуют непредусмотренные deletions;
- project-owned artifact inventory не потерян;
- target `harness doctor` не показывает blocking errors;
- generated projections, если мигрировались, проходят соответствующие validators.

При failure migration не получает статус `complete`.

## 24. Migration report

После успешной или заблокированной migration формируется factual report.

Durable report должен находиться в project-owned audit/migration history path, если такой path определён target contract.

Report содержит:

- migration ID;
- source release/schema;
- baseline identity;
- target release/schema;
- timestamp;
- ownership summary;
- applied operations;
- preserved customized/unknown files;
- conflicts/blockers;
- local state migration result;
- verification commands/results;
- final status;
- manual follow-up actions.

Для успешного run report создаётся только после PASS verification.

При dry-run report/plan явно помечается как не применённый.

Связанные требования: `CLI-REQ-126`.

## 25. Идемпотентность

Повторный запуск после успешной migration должен определить текущее thin-project состояние и не повторять destructive operations.

Если target state уже достигнут:

```text
result = ALREADY_MIGRATED
mutations = 0
```

Повторный dry-run при неизменном repository должен давать эквивалентный semantic plan.

## 26. Основные blocker categories

Migration должна различать как минимум:

- `BASELINE_REQUIRED`;
- `BASELINE_MISMATCH`;
- `UNSUPPORTED_LEGACY_RELEASE`;
- `TARGET_RELEASE_UNAVAILABLE`;
- `TARGET_INCOMPATIBLE`;
- `DIRTY_PATH_CONFLICT`;
- `UNTRACKED_COLLISION`;
- `HARNESS_OWNED_MODIFIED`;
- `SHARED_MERGE_UNSAFE`;
- `UNKNOWN_ACTIVE_STATE`;
- `ACTIVE_EXECUTION`;
- `PROJECT_SCHEMA_CONFLICT`;
- `PLAN_STALE`;
- `POSTCONDITION_FAILED`;
- `MIGRATION_IN_PROGRESS`.

Названия кодов могут быть уточнены implementation contract, но категории должны оставаться различимыми.

## 27. Security boundary

Migration рассматривает remote release metadata/content как данные из доверенного Harness release source, но не должна автоматически исполнять произвольные scripts/hooks из target release.

Target release validator может исполняться только в рамках отдельно принятой trust model release system.

До её определения migration verification должна использовать доверенный CLI/Core и declarative release metadata.

Связанные требования: `CLI-REQ-225`.

## 28. Что происходит со старым self-update механизмом

Legacy `HARNESS UPDATE CHECK/APPLY` и repository-embedded updater нужны только для старой архитектуры.

После миграции:

- общий Harness Core обновляется через Harness Distribution/CLI;
- project pin меняется отдельной явной операцией;
- project schema migration выполняется Migration Engine;
- legacy `.harness/tools/harness-update*` больше не является runtime dependency проекта.

Исторические update reports остаются project-owned durable history и не удаляются.

## 29. Что не входит в этот этап

Issue #7 не определяет:

- точный Harness Distribution metadata format (#8);
- реализацию Release Store/Resolver (#9);
- конкретные CLI command names для migration;
- конкретный serialization format migration plan/checkpoint;
- конкретную backup compression/storage technology;
- полную historical compatibility matrix;
- runtime adapter implementation.

Эти решения должны приниматься на следующих этапах без нарушения invariants этого документа.

## 30. Трассируемость

| Область | Требования | Архитектурная граница |
| --- | --- | --- |
| Legacy detection | `CLI-REQ-023`, `CLI-REQ-120` | ProjectInspector |
| Baseline/ownership | `CLI-REQ-122`, `CLI-REQ-123` | MigrationPlanner |
| Dry-run/plan | `CLI-REQ-121`, `CLI-REQ-183` | MigrationPlanner |
| Idempotency/resume | `CLI-REQ-124`, `CLI-REQ-125` | MigrationExecutor + clone-local state |
| Report | `CLI-REQ-126` | MigrationExecutor |
| Local state | `CLI-REQ-127`, `CLI-REQ-053`–`CLI-REQ-056` | HarnessStateLocator / MigrationExecutor |
| Legacy cleanup | `CLI-REQ-128`, `CLI-REQ-037` | MigrationExecutor |
| Release prerequisite | `CLI-REQ-100`–`CLI-REQ-109` | ReleaseStore / ReleaseResolver |
| Git safety | `CLI-REQ-180`–`CLI-REQ-183` | Git/FS adapters + MigrationPlanner |
| Security | `CLI-REQ-224`–`CLI-REQ-227` | Core + infrastructure adapters |

## 31. Критерий готовности design contract

Этот этап считается завершённым, когда:

- migration lifecycle определён от Inspect до Report;
- baseline нельзя выбирать эвристически;
- ownership classification определена;
- неизвестные и customized файлы сохраняются по умолчанию;
- `dry-run` строит полный mutation plan;
- dirty/untracked conflicts описаны;
- `harness.yaml` migration отделена от legacy control-plane paths;
- operational state переносится в clone-local storage;
- active execution не сбрасывается молча;
- checkpoint/journal/resume semantics определены;
- идемпотентность определена;
- verification и report определены;
- документ связан с product requirements и architecture;
- migration не зависит от обязательного GUI или конкретного AI runtime.
