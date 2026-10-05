# Harness CLI

Experimental CLI control plane for [AI Development Harness](https://github.com/ai-development-harness).

The goal is to separate the Harness product from project-owned artifacts. Projects should keep durable knowledge such as requirements, ADRs, STEP files and reviews in Git, while the Harness protocol implementation, validators and core tooling are distributed separately.

## Current scope

This repository intentionally starts with a narrow, non-runtime slice:

- `harness setup` — bootstrap an existing Git repository;
- `harness doctor` — check prerequisites and expected project paths;
- `harness validate` — validate `harness.yaml`;
- `harness status` — show the pinned Harness release and clone-local state path.

It does **not** launch Claude Code or Codex. Runtime interaction remains owned by the runtime so interactive permissions, approvals and questions continue to work normally.

## Development

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

```yaml
schemaVersion: 1

harness:
  release: 0.10.1

project:
  initialized: false

sources:
  requirements: docs/requirements
  adr: docs/adr
  openQuestions: docs/open-questions

planning:
  tasks: planning/tasks
  reviews: planning/reviews
  audits: planning/audits
```

## Architecture direction

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

The CLI is a control-plane and distribution surface, not a mandatory terminal wrapper around AI runtimes.
