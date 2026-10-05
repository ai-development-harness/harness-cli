# Формат Harness Distribution и immutable release

## 1. Назначение

Этот документ определяет канонический формат устанавливаемого дистрибутива AI Development Harness и формат неизменяемого Harness release.

Он фиксирует:

- layout установленного release;
- формат `release.json`;
- обязательные и опциональные компоненты;
- integrity model;
- compatibility metadata;
- правила cross-platform path handling;
- правила immutability;
- независимость Harness release от installation channel;
- границу между CLI package version и Harness release.

Реализация Release Store / Resolver относится к issue #9.

Связанные документы:

- `docs/PRODUCT_REQUIREMENTS.md`;
- `docs/ARCHITECTURE.md`;
- `docs/MIGRATION.md`;
- `docs/ROADMAP.md`.

Основные требования: `CLI-REQ-006`, `CLI-REQ-012`–`CLI-REQ-015`, `CLI-REQ-050`–`CLI-REQ-052`, `CLI-REQ-100`–`CLI-REQ-109`, `CLI-REQ-220`–`CLI-REQ-227`, `CLI-REQ-242`, `CLI-REQ-260`–`CLI-REQ-263`.

## 2. Термины

### Harness CLI package

Устанавливаемый CLI package, например `@ai-development-harness/cli`.

Его version определяется `package.json -> version` и не является Harness release.

### Harness release

Версионированный immutable набор release-owned Core implementation и assets, который разрешается по `harness.yaml -> harness.release`.

### Harness Distribution

Логическая единица поставки Harness release.

Distribution не равен конкретному ZIP, tarball или npm package. Archive/package является только transport container.

### Release tree

Распакованное каноническое содержимое одного Harness release.

### Release digest

SHA-256 точных bytes файла `release.json`.

Digest идентифицирует конкретное содержимое release metadata и косвенно весь payload через file hashes внутри `release.json`.

## 3. Главный принцип формата

Канонической сущностью является **release tree**, а не transport artifact.

Один и тот же Harness release может быть доставлен:

- через npm;
- через HTTP archive;
- через offline package;
- через будущий standalone installer;
- через другой поддерживаемый installation channel.

После распаковки и проверки все каналы должны приводить к одному и тому же release tree и тому же `release.json` digest.

Связанные требования: `CLI-REQ-006`, `CLI-REQ-106`, `CLI-REQ-260`–`CLI-REQ-263`.

## 4. Канонический layout

Минимальный release tree формата v1:

```text
<release-root>/
├── release.json
├── core/
├── protocol/
├── schemas/
├── skills/
└── docs/
```

Опциональные компоненты:

```text
adapters/
migrations/
fixtures/
```

Точный состав payload перечисляется в `release.json`. Наличие каталога само по себе не является источником истины.

### 4.1 `release.json`

Обязательный metadata manifest release.

Он описывает:

- format version;
- Harness release version;
- compatibility;
- declared components;
- Core entrypoint;
- полный список payload files;
- SHA-256 и size каждого payload file.

### 4.2 `core/`

Release-owned executable Core implementation, необходимая для воспроизведения semantics конкретного Harness release.

CLI host не должен предполагать, что текущий CLI package автоматически эквивалентен project-pinned Harness release.

Цель: обновление CLI package не должно незаметно менять semantics старого pinned project.

### 4.3 `protocol/`

Machine-readable protocol definitions и deterministic protocol data.

Примеры будущего содержимого:

- canonical command definitions;
- transition/state models;
- reasoning boundaries;
- protocol-owned static data.

### 4.4 `schemas/`

Machine-readable schemas, принадлежащие release.

Например:

- project config schema;
- artifact schemas;
- execution state schemas;
- release-owned DTO schemas.

### 4.5 `skills/`

Базовые Harness skills, принадлежащие release.

Project-specific и third-party skills сюда не относятся.

### 4.6 `docs/`

Документация release-owned protocol/Core, которая нужна для runtime integration, diagnostics или разработчикам.

### 4.7 `adapters/`

Опциональные runtime-specific assets или implementation adapters.

Формат v1 не требует наличия adapters до появления принятого Runtime Adapter Contract.

### 4.8 `migrations/`

Опциональные release-owned migration definitions/assets.

Наличие каталога не означает разрешение исполнять произвольные lifecycle scripts.

## 5. Почему Core входит в release

Project pin должен закреплять semantics Harness release, а не только набор текстовых assets.

Если Core implementation существовала бы только в текущем CLI package, обновление CLI могло бы изменить behavior проекта, остающегося на старом `harness.release`.

Поэтому release tree должен содержать release-owned implementation или иной immutable executable representation, достаточный для воспроизведения semantics этого release.

Точный bundling strategy Core определяется implementation этапом, но v1 contract требует self-contained release-owned Core component.

Связанные требования: `CLI-REQ-100`, `CLI-REQ-104`, `CLI-REQ-108`, `CLI-REQ-241`.

## 6. Формат release.json

`release.json` использует UTF-8 JSON без BOM.

Schema version v1:

```json
{
  "formatVersion": 1,
  "release": "0.10.4",
  "createdAt": "2026-10-05T00:00:00Z",
  "compatibility": {
    "cli": {
      "minVersion": "0.1.0",
      "maxVersionExclusive": null
    },
    "hostApi": {
      "minVersion": 1,
      "maxVersion": 1
    },
    "projectSchema": {
      "supported": [1],
      "target": 1,
      "migrateFrom": []
    }
  },
  "entrypoints": {
    "core": "core/index.mjs"
  },
  "components": [
    { "id": "core", "path": "core", "required": true },
    { "id": "protocol", "path": "protocol", "required": true },
    { "id": "schemas", "path": "schemas", "required": true },
    { "id": "skills", "path": "skills", "required": true },
    { "id": "docs", "path": "docs", "required": true }
  ],
  "files": [
    {
      "path": "core/index.mjs",
      "size": 12345,
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Это нормативная структура формата v1. Дополнительные keys могут появляться только через новую `formatVersion` либо как явно объявленная backward-compatible extension policy.

## 7. Поля верхнего уровня

### 7.1 `formatVersion`

Integer.

Для первого формата:

```text
1
```

Unknown major format version должна приводить к `UNSUPPORTED_RELEASE_FORMAT`.

### 7.2 `release`

Строка Harness release version.

Для v1 используется формат:

```text
MAJOR.MINOR.PATCH
```

Без префикса `v`.

Folder/tag naming может использовать `v`, но metadata identity использует чистую version string.

### 7.3 `createdAt`

UTC ISO-8601 timestamp создания release metadata.

Поле informational и не используется как release ordering source вместо semver.

### 7.4 `compatibility`

Machine-readable compatibility contract.

### 7.5 `entrypoints`

Явные executable entrypoints release-owned implementation.

V1 требует минимум `entrypoints.core`.

### 7.6 `components`

Declared logical components release.

### 7.7 `files`

Полный перечень payload files и их integrity metadata.

`release.json` в `files` не включается.

## 8. Compatibility metadata

### 8.1 CLI compatibility

```json
{
  "minVersion": "0.1.0",
  "maxVersionExclusive": null
}
```

`minVersion` — минимальная CLI package version, способная безопасно загрузить/использовать release.

`maxVersionExclusive` — опциональная верхняя граница.

Отсутствие upper bound не означает вечную совместимость: будущий CLI обязан учитывать `hostApi`.

### 8.2 Host API compatibility

Release-owned Core загружается через стабильный host API CLI/Core bootstrap layer.

```json
{
  "minVersion": 1,
  "maxVersion": 1
}
```

Это integer protocol version, независимый от npm semver.

CLI может использовать release только если его поддерживаемая Host API version пересекается с указанным диапазоном.

Так CLI package может развиваться без жёсткого semver coupling каждого Harness release.

### 8.3 Project schema compatibility

```json
{
  "supported": [1],
  "target": 1,
  "migrateFrom": [0]
}
```

`supported` — project schema versions, которые release способен читать/использовать без project migration.

`target` — schema version, которую release считает текущей для новых/мигрированных проектов.

`migrateFrom` — schema versions, для которых release содержит поддерживаемый migration path.

Фактическая migration всё равно выполняется через Migration Engine, а не автоматически при resolution.

### 8.4 Runtime compatibility

Формат v1 намеренно не фиксирует обязательные versions Codex/Claude.

Runtime capability/version constraints должны появиться после принятия Runtime Adapter Contract.

Если такие constraints позже войдут в release metadata, они не должны менять identity existing format v1 без совместимого extension mechanism.

## 9. Components

Каждый component descriptor содержит:

```json
{
  "id": "protocol",
  "path": "protocol",
  "required": true
}
```

Правила:

- `id` уникален внутри release;
- `path` является portable relative path;
- `required=true` означает, что отсутствие component payload делает release corrupt;
- component path не создаёт отдельную integrity boundary: каждый файл всё равно перечислен в `files`.

Обязательные component IDs v1:

- `core`;
- `protocol`;
- `schemas`;
- `skills`;
- `docs`.

Опциональные predefined IDs:

- `adapters`;
- `migrations`;
- `fixtures`.

Unknown component id допускается только если CLI format parser разрешает extension components и они не требуются для базового Core loading.

## 10. Core entrypoint

`entrypoints.core` указывает portable relative path внутри release tree.

V1 рекомендует ESM `.mjs` bundle.

Contract:

- entrypoint находится внутри `core` component;
- entrypoint перечислен в `files`;
- entrypoint integrity проверена до загрузки;
- entrypoint не требует `npm install` внутри release root;
- dependency resolution не должна зависеть от project `node_modules`;
- installer не запускает entrypoint во время обычной распаковки/установки;
- CLI host разрешает **точный** project pin из `harness.yaml` и не выбирает `latest`, `main` или соседний release;
- Host API compatibility проверяется по `release.json` **до** import executable entrypoint;
- после import runtime declaration Core также обязана совпасть с Host API v1.

Release-owned Core должен быть self-contained либо использовать только явно версионированный Host API.

### 10.1 Host API v1 module shape

Declared ESM entrypoint экспортирует named object:

```js
export const harnessCore = {
  hostApiVersion: 1,

  async execute(request, ports) {
    // release-owned deterministic semantics
  }
};
```

CLI не ищет альтернативный export и не выполняет package lifecycle scripts для discovery/bootstrap.

`harnessCore.execute` получает только Host API request и runtime-neutral ports. Commander, terminal presentation и UI objects в contract не входят.

### 10.2 Request envelope

Host формирует request schema v1:

```json
{
  "schemaVersion": 1,
  "hostApiVersion": 1,
  "requestId": "<uuid>",
  "projectRoot": "<canonical absolute project root>",
  "operation": "<host operation>",
  "versions": {
    "cli": "0.1.0",
    "harnessRelease": "0.10.4",
    "projectSchema": 1,
    "releaseDigest": "<sha256 release.json>"
  },
  "input": {}
}
```

`projectRoot` задаётся host-ом явно и не выводится release code из `cwd`.

Четыре identity/version domain намеренно различимы:

- CLI package version;
- Harness release;
- project schema version;
- immutable release digest.

### 10.3 Result/error envelope

Core возвращает один из двух schema-v1 envelopes.

Success:

```json
{
  "schemaVersion": 1,
  "hostApiVersion": 1,
  "requestId": "<same uuid>",
  "ok": true,
  "versions": {
    "cli": "0.1.0",
    "harnessRelease": "0.10.4",
    "projectSchema": 1,
    "releaseDigest": "<same digest>"
  },
  "result": {}
}
```

Failure:

```json
{
  "schemaVersion": 1,
  "hostApiVersion": 1,
  "requestId": "<same uuid>",
  "ok": false,
  "versions": {
    "cli": "0.1.0",
    "harnessRelease": "0.10.4",
    "projectSchema": 1,
    "releaseDigest": "<same digest>"
  },
  "error": {
    "code": "DOMAIN_ERROR_CODE",
    "message": "Stable diagnostic",
    "details": {}
  }
}
```

Host валидирует schema/version/request identity перед возвратом результата caller-у. Thrown exception Core не проходит наружу как необработанный stack trace: host переводит его в typed `CORE_EXECUTION_FAILED`. Невалидный envelope становится `CORE_INVALID_RESPONSE`.

### 10.4 Runtime-neutral ports

Host API v1 предоставляет три named ports:

```text
filesystem.call({ operation, input })
git.call({ operation, input })
storage.call({ operation, input })
```

Port contract намеренно не зависит от Commander/UI/runtime SDK. Конкретный набор разрешённых filesystem/Git/storage operations развивается в Core/infrastructure layers; Host API остаётся boundary dependency injection.

Core не должен обходить ports ради project-specific host behavior. Нативные Node APIs, которые нужны внутренней pure computation release bundle, не превращают CLI presentation или runtime SDK в Core dependency.

### 10.5 Load order и safety

Нормальный load path:

```text
harness.yaml
  ↓ exact harness.release + schemaVersion
ReleaseStore.verify
  ↓
CLI compatibility
  ↓
Host API compatibility
  ↓
project schema compatibility
  ↓
entrypoint containment
  ↓
import declared core entrypoint
  ↓
runtime hostApiVersion check
  ↓
execute(request, ports)
```

До successful verification/compatibility checks executable Core не импортируется.

Host не запускает:

- `npm install`;
- `preinstall` / `postinstall`;
- bootstrap scripts;
- arbitrary hooks;
- undeclared discovery executables.

Integrity verification не является sandbox для уже доверенного release code: import declared Core — это сама разрешённая executable boundary. Publisher authenticity/provenance остаётся отдельным hardening layer.

## 11. Integrity model

### 11.1 Payload integrity

`files` содержит запись для **каждого обычного payload file** release tree кроме `release.json`.

Запись:

```json
{
  "path": "protocol/commands.json",
  "size": 2048,
  "sha256": "...64 lowercase hex chars..."
}
```

Verification проверяет:

1. path существует;
2. это ordinary file;
3. file size совпадает;
4. SHA-256 exact bytes совпадает;
5. в release tree нет undeclared payload files.

### 11.2 Release metadata integrity

Release digest определяется как:

```text
sha256(exact UTF-8 bytes of release.json)
```

Installer/Release Store должен сохранить expected release digest **вне immutable release tree** как installation record.

Повторная verification сравнивает:

- stored release digest;
- текущий digest `release.json`;
- file hashes из `release.json`.

Изменение metadata или payload после установки становится corruption.

### 11.3 Authenticity vs integrity

SHA-256 manifest обеспечивает integrity, но сам по себе не доказывает publisher authenticity.

Signatures/provenance относятся к release hardening этапу ROADMAP.

V1 format должен позволять в будущем добавить detached signature/catalog verification без изменения payload file semantics.

## 12. Детерминированность release.json

Release digest считается по exact bytes, поэтому publisher должен генерировать `release.json` детерминированно.

Правила generation v1:

- UTF-8;
- LF line endings;
- один trailing LF;
- JSON indentation 2 spaces;
- object keys в schema-defined order;
- `components` в deterministic order;
- `files` отсортирован лексикографически по `path`;
- lowercase hex SHA-256;
- no insignificant rewrite после публикации.

Resolver не должен пересериализовывать metadata для проверки digest: hash считается от исходных bytes.

## 13. Portable path contract

Все paths в metadata используют `/` независимо от host OS.

Path обязан:

- быть relative;
- быть непустым;
- не начинаться с `/`;
- не содержать `\`;
- не содержать `.` или `..` segments;
- не содержать NUL;
- не содержать URI/drive prefix;
- не оканчиваться `/` для file entries;
- после normalization оставаться внутри release root.

V1 distribution запрещает:

- symbolic links;
- hard links;
- device files;
- FIFOs;
- sockets.

Причина: одинаковая семантика unpack/verify на Linux, macOS и Windows и отсутствие traversal через link target.

### 13.1 Windows portability

Publisher должен отклонять paths, несовместимые с Windows:

- reserved device names;
- trailing dot/space segment;
- drive-like segments;
- case-insensitive collisions.

### 13.2 Case collision

Release не может содержать два paths, различающихся только регистром.

Пример недопустимого набора:

```text
docs/README.md
docs/readme.md
```

Это обеспечивает одинаковую установку на case-sensitive и case-insensitive filesystems.

Связанные требования: `CLI-REQ-220`–`CLI-REQ-224`.

## 14. File inventory semantics

`files` является полной inventory payload.

Нельзя:

- оставлять undeclared generated files внутри installed release root;
- писать logs/cache/runtime state внутрь release root;
- создавать `node_modules` во время install;
- модифицировать docs/skills после install;
- писать compilation artifacts в release root.

Весь mutable runtime/cache state должен жить вне release tree.

## 15. Immutability rules

После successful install release root переходит в состояние immutable.

Release Store обязан трактовать любую mutation как corruption.

Запрещено:

- in-place update;
- patch existing release;
- regenerate file;
- update timestamps/content как часть normal operation;
- записывать install status внутрь release root;
- выполнять postinstall modification.

Новый content всегда получает новую Harness release version.

Если installation channel публикует те же version bytes с другим `release.json` digest, Release Store должен считать это immutable identity collision, а не update.

## 16. Installed release identity

Логическая identity:

```text
Harness release version + release digest
```

Project pin в `harness.yaml` содержит version.

Release Store обеспечивает invariant:

```text
one installed version → one accepted release digest
```

Если для уже установленной version предлагается другой digest:

```text
RELEASE_IDENTITY_CONFLICT
```

и существующий release не изменяется.

Точная store index schema относится к #9.

## 17. Global storage layout

Концептуально:

```text
<platform data dir>/ai-development-harness/
├── releases/
│   ├── 0.10.4/
│   │   ├── release.json
│   │   ├── core/
│   │   ├── protocol/
│   │   ├── schemas/
│   │   ├── skills/
│   │   └── docs/
│   └── ...
└── store-state/
    └── ... installer-owned metadata outside release tree
```

Это conceptual contract.

Точная index/staging layout будет определена реализацией #9.

Важно: installer-owned mutable metadata не хранится внутри `<release-version>/`.

## 18. Installation transport

Release format не определяет transport archive.

Допустимые transports могут включать:

- npm package;
- `.tar.gz`;
- `.zip`;
- local directory;
- offline bundle;
- future signed catalog artifact.

Transport adapter обязан получить release tree и передать его общему verifier/store.

Transport-specific files не должны попадать в canonical release tree, если они не объявлены release payload.

## 19. npm distribution

Если Harness release поставляется через npm:

- npm package является transport container;
- npm package version может совпадать с Harness release для удобства, но это не архитектурное требование;
- npm lifecycle scripts не должны быть обязательны для построения installed release tree;
- package manager metadata не является source of truth Harness release identity;
- после extraction identity определяется `release.json` + release digest.

CLI package `@ai-development-harness/cli` и release transport package могут быть разными packages.

Это решение оставляется implementation этапу.

## 20. Standalone distribution

Будущий standalone CLI/installer может включать bootstrap CLI и один или несколько Harness releases.

Но bundled release обязан сохранять тот же `release.json` и payload hashes.

Standalone packaging не создаёт отдельный release format.

Связанные требования: `CLI-REQ-262`.

## 21. Offline installation

Offline install должен быть возможен при наличии:

- release tree или transport artifact;
- expected release version;
- metadata/digest, достаточных для integrity verification.

Network access не является частью release format contract.

Связанные требования: `CLI-REQ-263`.

## 22. Compatibility decision

До загрузки Core Release Resolver проверяет минимум:

1. `formatVersion` поддерживается;
2. version соответствует requested project pin;
3. release digest соответствует store record/source descriptor;
4. payload integrity PASS;
5. CLI semver compatibility PASS;
6. Host API overlap существует;
7. project schema входит в `supported` либо существует явный migration path;
8. required components существуют.

Результаты должны различать:

- `RESOLVED`;
- `RELEASE_MISSING`;
- `RELEASE_CORRUPT`;
- `RELEASE_INCOMPATIBLE_CLI`;
- `RELEASE_INCOMPATIBLE_HOST_API`;
- `PROJECT_SCHEMA_MIGRATION_REQUIRED`;
- `UNSUPPORTED_RELEASE_FORMAT`;
- `RELEASE_IDENTITY_CONFLICT`.

Точные typed errors реализуются в #9.

## 23. Installation lifecycle contract

Хотя реализация относится к #9, format предполагает следующий безопасный lifecycle:

```text
fetch/import transport
        ↓
extract to staging
        ↓
validate portable paths
        ↓
parse release.json
        ↓
verify version/compatibility
        ↓
verify every payload hash
        ↓
compute release digest
        ↓
atomic publish into releases/<version>
        ↓
persist store record outside release root
```

При failure staging удаляется/изолируется, а existing release root не меняется.

## 24. Security boundary

Installer рассматривает payload как недоверенный content до успешной integrity verification.

До verification запрещено:

- импортировать executable Core;
- выполнять JS/Python/shell files;
- запускать hooks;
- разрешать symlinks;
- писать за staging root через crafted path.

После verification release code может загружаться только через declared entrypoint и Host API contract.

Release format v1 не содержит `preinstall`, `postinstall`, `bootstrapScript` или аналогичные arbitrary script hooks.

Связанные требования: `CLI-REQ-225`, `CLI-REQ-227`.

## 25. Release creation contract

Publisher release должен:

1. собрать self-contained release-owned Core;
2. подготовить protocol/schemas/skills/docs и optional components;
3. проверить portable path rules;
4. вычислить size/SHA-256 каждого payload file;
5. сформировать deterministic `release.json`;
6. вычислить release digest;
7. прогнать release format validation;
8. опубликовать immutable artifact.

После публикации release version нельзя переиспользовать для другого content.

## 26. Что не хранится в Harness release

Release tree не содержит:

- project requirements/ADR/STEP;
- project reviews/audits;
- project-specific skills;
- clone-local execution state;
- user authentication tokens;
- global user preferences;
- installer cache;
- mutable lock state конкретного проекта;
- generated per-project projections.

## 27. Связь с migration

`docs/MIGRATION.md` требует установить и проверить target Distribution до удаления legacy Harness-owned Core files.

Для migration это означает:

- target release version известна;
- Release Store возвращает verified descriptor;
- required components присутствуют;
- target project schema compatibility известна;
- only after that legacy clean Harness-owned files may be retired.

Migration не должна самостоятельно интерпретировать transport archive.

## 28. Связь с будущим Core extraction

По мере переноса functionality из template repository соответствующий release-owned implementation/assets входят в Harness Distribution.

После extraction конкретной функции:

- runtime source of truth становится release-owned Core;
- template может оставаться compatibility fixture;
- новый project не получает копию implementation в tracked repository.

## 29. Backward/forward compatibility formatVersion

`formatVersion` версионирует именно metadata/layout contract, не Harness semantics.

Правила:

- изменение Harness behavior → новая `release`, но не обязательно новая `formatVersion`;
- additive optional field может быть совместим в рамках v1 только если parser contract явно разрешает unknown optional extension;
- изменение required field semantics → новая format version;
- изменение integrity semantics → новая format version;
- изменение portable path/security semantics, несовместимое со старым verifier → новая format version.

V1 parser должен fail-closed на неизвестные required semantics.

## 30. Пример полного release.json

```json
{
  "formatVersion": 1,
  "release": "1.2.3",
  "createdAt": "2026-10-05T10:00:00Z",
  "compatibility": {
    "cli": {
      "minVersion": "0.2.0",
      "maxVersionExclusive": "1.0.0"
    },
    "hostApi": {
      "minVersion": 1,
      "maxVersion": 1
    },
    "projectSchema": {
      "supported": [1],
      "target": 1,
      "migrateFrom": [0]
    }
  },
  "entrypoints": {
    "core": "core/index.mjs"
  },
  "components": [
    { "id": "core", "path": "core", "required": true },
    { "id": "protocol", "path": "protocol", "required": true },
    { "id": "schemas", "path": "schemas", "required": true },
    { "id": "skills", "path": "skills", "required": true },
    { "id": "docs", "path": "docs", "required": true },
    { "id": "adapters", "path": "adapters", "required": false }
  ],
  "files": [
    {
      "path": "adapters/README.md",
      "size": 420,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "path": "core/index.mjs",
      "size": 24576,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    {
      "path": "docs/PROTOCOL.md",
      "size": 8192,
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      "path": "protocol/commands.json",
      "size": 4096,
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    {
      "path": "schemas/project.schema.json",
      "size": 3072,
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    },
    {
      "path": "skills/run-step/SKILL.md",
      "size": 6144,
      "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    }
  ]
}
```

## 31. Трассируемость

| Область | Требования |
| --- | --- |
| Distribution abstraction | `CLI-REQ-006`, `CLI-REQ-106` |
| Version separation | `CLI-REQ-012`–`CLI-REQ-015` |
| Global storage | `CLI-REQ-050`–`CLI-REQ-052` |
| Immutability/integrity | `CLI-REQ-100`–`CLI-REQ-105` |
| Update separation | `CLI-REQ-107`–`CLI-REQ-109` |
| Cross-platform | `CLI-REQ-220`–`CLI-REQ-224` |
| Security | `CLI-REQ-225`–`CLI-REQ-227` |
| Compatibility model | `CLI-REQ-242` |
| npm/standalone/offline | `CLI-REQ-260`–`CLI-REQ-263` |

## 32. Критерий готовности format contract

Issue #8 считается выполненным, когда:

- определён канонический release tree;
- принят `release.json` format v1;
- определены mandatory components;
- Core входит в release-owned immutable content;
- определены file inventory и SHA-256 integrity rules;
- release digest однозначно определён;
- installer-owned mutable state вынесен за release root;
- определены compatibility fields для CLI, Host API и project schema;
- определены portable path rules для Linux/macOS/Windows;
- symlinks и special files запрещены;
- format не зависит от npm/ZIP/tar transport;
- npm и standalone остаются installation channels, а не отдельными release formats;
- migration может потребовать verified target release через общий Release Store;
- #9 может реализовать Store/Resolver без изменения этого contract.
