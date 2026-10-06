# Stage 5 parity matrix

Stage 5 closes the deterministic CLI/Core surface defined by issue #67.

This matrix is normative for the public Stage 5 command tree. It records the
presentation mode, Core authority and regression coverage used to decide that the
stage is complete.

## Public surface

| CLI surface | Human output | Structured output | Core authority | Primary regression coverage |
| --- | --- | --- | --- | --- |
| `harness setup` | yes | `--json` | setup/release resolution | `cli-presentation.test.ts`, setup tests |
| `harness doctor` | yes | `--json` | doctor/release/config diagnostics | `cli-presentation.test.ts` |
| `harness status` | yes | `--json` | compatibility/project aggregate | status tests |
| `harness config` | yes | `--json` | config schema/defaults | `config-cli.test.ts` |
| `harness validate` | yes | `--json` | project/release/artifact validation | validate tests |
| `harness release install` | yes | `--json` | Release Store | release tests |
| `harness release list` | yes | `--json` | Release Store | release tests |
| `harness release verify` | yes | `--json` | release verifier | release tests |
| `harness migrate inspect` | yes | `--json` | migration inspector | migration E2E |
| `harness migrate plan` | yes | `--json` | migration planner | migration E2E |
| `harness migrate apply` | yes | `--json` | migration executor | migration E2E |
| `harness migrate resume` | yes | `--json` | migration checkpoint/recovery | migration E2E |
| `harness migrate status` | yes | `--json` | migration checkpoint/lock diagnostics | migration E2E |
| `harness update check` | yes | `--json` | `UpdateService` | `update-cli.test.ts` |
| `harness update apply` | yes | `--json` | `UpdateService` | `update-cli.test.ts` |
| `harness project status` | yes | `--json` | project read model | `project-read-cli.test.ts` |
| `harness step list` | yes | `--json` | STEP read model | `project-read-cli.test.ts` |
| `harness step show` | yes | `--json` | STEP read model + canonical parser | `project-read-cli.test.ts` |
| `harness step next` | yes | `--json` | STEP next resolver | `project-read-cli.test.ts` |
| `harness git check` | yes | `--json` | Git safety/preflight | `git-check-cli.test.ts` |
| `harness protocol machine` | no, machine-only | stdin/stdout JSON | pinned release-owned `ProtocolEngine` | `external-caller.test.ts`, `protocol-engine.test.ts`, release smoke |

`test/stage5-cli-matrix.test.ts` additionally locks the complete command tree and
requires a structured automation mode for every Stage 5 surface.

## Structured-output contract

All ordinary interactive Stage 5 commands expose human-readable output and a
`--json` mode. The only intentional exception is `harness protocol machine`,
which is itself a machine-only JSON transport and therefore has no redundant
`--json` switch.

The shared presentation envelope and exit taxonomy are defined in
`docs/CLI_PRESENTATION.md` and `src/commands/presentation.ts`.

The protocol machine transport returns the Host API v1 envelope from the exact
project-pinned immutable release. Its request/result contract is therefore
versioned by Host API plus release-owned schemas rather than by the ordinary
human/JSON presentation switch.

## Exit-code regression matrix

| Category | Code | Representative Stage 5 behavior |
| --- | ---: | --- |
| success | 0 | deterministic command completed |
| failure | 1 | existing/domain compatibility failure |
| blocked | 2 | valid operation cannot safely proceed; includes update/migration blockers and blocked protocol result |
| usage | 64 | invalid CLI usage reserved by presentation contract |
| input | 65 | invalid config/target/request JSON |
| environment | 69 | missing Git/project/release/filesystem prerequisite |
| internal | 70 | unexpected internal presentation failure |

The exact numeric mapping is regression-tested in `cli-presentation.test.ts`.
Command-specific suites cover representative blocked/input/environment outcomes.

## Read-only guarantees

The following Stage 5 surfaces are explicitly read-only:

- `harness config`;
- `harness update check`;
- `harness project status`;
- `harness step list`;
- `harness step show`;
- `harness step next`;
- `harness git check`;
- migration inspect/plan before an explicit saved-plan apply.

Their dedicated tests verify the relevant file/Git state invariants. In particular,
`harness git check` uses a read-only Git adapter whose mutation methods fail
closed.

## Runtime-neutral external caller boundary

`harness protocol machine`:

1. resolves the exact project-pinned immutable release;
2. passes a canonical command to release-owned `ProtocolEngine`;
3. returns a deterministic result/blocker or semantic handoff;
4. accepts only a minimal semantic completion identity plus an untrusted proposal;
5. reloads Git-private execution state before semantic commit;
6. rejects stale/tampered completion before the commit boundary;
7. resumes from existing execution state after interruption.

It does not import or invoke Claude/Codex SDKs and owns no runtime process,
authentication, model/effort, TTY, cancellation or supervision lifecycle.

## CI gate

Stage 5 completion requires the repository CI matrix on:

- Ubuntu;
- macOS;
- Windows.

Every matrix leg runs:

```text
npm run typecheck
npm test
npm run build
npm run release:smoke
```

The release smoke builds and installs the actual immutable Harness release and
exercises the pinned Host API, including the external caller round-trip.

## Requirement status

Stage 5 confirms the already implemented execution/protocol requirements
`CLI-REQ-056` and `CLI-REQ-140`–`CLI-REQ-148` as MUST requirements.

`CLI-REQ-200`–`CLI-REQ-202` remain PLANNED because Stage 7 Local Integration
API is intentionally broader than the Stage 5 protocol caller transport: it must
serve editor/UI integrations with project/artifact/release/diagnostic surfaces
without forcing those clients to shell out to individual CLI commands.

`CLI-REQ-241` also remains PLANNED because removal of duplicate implementation
from the separate template repository is cross-repository Stage 6 work, not a
claim that can be closed inside `harness-cli`.

## Stage 5 closure

Completed implementation issues:

- #68 presentation contract;
- #69 config surface;
- #70 update surface;
- #71 project/STEP read surfaces;
- #72 Git check;
- #73 external caller / ProtocolEngine machine boundary;
- #74 parity, documentation and quality-gate closure.

The next roadmap stage is Stage 6: thin-project bootstrap/integration contract.
