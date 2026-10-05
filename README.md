# Harness CLI

Experimental CLI control plane for [AI Development Harness](https://github.com/ai-development-harness).

The goal is to separate the Harness product from project-owned artifacts. Projects keep durable knowledge such as requirements, ADRs, STEP files and reviews in Git, while the Harness protocol implementation, validators, core skills and tooling are distributed separately.

## Architectural boundary

Harness CLI is **not** a mandatory terminal wrapper around Claude Code or Codex.

Interactive runtime sessions remain owned by the runtime itself, so permission prompts, WebFetch approvals, questions and other TTY interactions continue to work normally. The CLI is responsible for installation, configuration, deterministic validation, migrations and local control-plane services.

```text
Claude Code / Codex
        │
        │ Harness protocol commands
        ▼
Harness integration / local API
        │
        ▼
Harness Core
  ├─ protocol
  ├─ validators
  ├─ state machine
  └─ project services

Harness CLI
  ├─ setup
  ├─ update
  ├─ doctor
  ├─ validate
  └─ migrations
```

## Current scope

This repository intentionally starts with a narrow, non-runtime slice:

- `harness setup` — bootstrap an existing Git repository;
- `harness doctor` — check prerequisites and expected project paths;
- `harness validate` — validate `harness.yaml`;
- `harness status` — show the pinned Harness release and clone-local state path.

It does **not** launch Claude Code or Codex.

## Project vs. Harness-owned state

Tracked project repository:

```text
harness.yaml
AGENTS.md
CLAUDE.md
docs/
planning/
src/
```

Clone-local operational state is stored through Git's private path resolution:

```text
.git/ai-harness/
```

The future installed Harness distribution will own protocol code, validators, core skills, runtime adapters and immutable releases outside the project repository.

## Development

Requires Node.js 20+.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run locally:

```bash
npm run dev -- setup
npm run dev -- doctor
npm run dev -- validate
npm run dev -- status
```

## Example project contract

The initial schema mirrors the **project-owned** settings of the current Harness manifest and deliberately excludes embedded control-plane paths such as `.harness/tools/**` and Harness update policies.

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

## Roadmap

The canonical implementation plan is maintained in [`docs/ROADMAP.md`](docs/ROADMAP.md).

The next planned slice is **formalizing the product contract** before further expansion of the implementation:

1. `docs/PRODUCT_REQUIREMENTS.md` with stable `CLI-REQ-XXX` requirements;
2. `docs/ARCHITECTURE.md` with module and ownership boundaries;
3. `docs/MIGRATION.md` for transition from repository-embedded Harness projects;
4. then immutable Harness Release Store / Resolver.

The roadmap deliberately does **not** assume that a GUI will exist. CLI/Core should expose reusable machine-readable integration surfaces for editor integrations and other external tools without making any particular client mandatory.
