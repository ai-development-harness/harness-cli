# CLI presentation contract

Stage 5 keeps Commander/presentation code intentionally thin. Domain semantics belong to
release-owned Core services; the CLI only validates command-line input, delegates to Core,
renders results and selects a deterministic process exit code.

## Structured JSON

Commands that expose `--json` use top-level additive fields. New or migrated Stage 5
surfaces include:

```json
{
  "schemaVersion": 1,
  "ok": true
}
```

Failures include a typed category and structured error:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "status": "error",
  "category": "environment",
  "error": {
    "code": "RELEASE_MISSING",
    "message": "...",
    "details": {}
  }
}
```

Existing command-specific fields remain top-level so automation does not lose information
when a command adopts this contract.

## Exit codes

The shared mapping is defined in `src/commands/presentation.ts`:

| Kind | Code | Meaning |
| --- | ---: | --- |
| success | 0 | Command completed successfully |
| failure | 1 | Compatibility code for an existing domain failure |
| blocked | 2 | Valid operation was analysed but cannot proceed safely |
| usage | 64 | Invalid CLI invocation/usage |
| input | 65 | Structurally invalid caller input |
| environment | 69 | Repository/release/filesystem/environment prerequisite failure |
| internal | 70 | Unexpected internal failure |

Migration keeps its established contract: a valid migration plan that is blocked by
preconditions exits with code `2`; ordinary migration execution failures remain code `1`
until that surface is explicitly versioned.

## Runtime boundary

This presentation contract does not create AI runtime ownership. CLI/Core do not launch,
select, authenticate, configure, cancel or supervise Codex, Claude Code or any other AI
runtime. External callers consume deterministic results or semantic handoffs.
