@AGENTS.md

# Claude Code adapter

Этот файл является тонким adapter layer для Claude Code. Основной project contract находится в `AGENTS.md` и имеет приоритет.

Дополнительные правила для Claude Code:

- Не интерпретируй этот repository как пользовательский Harness project только потому, что здесь разрабатывается Harness.
- Не создавай repository-embedded `.harness/tools/**` как default architecture: цель этого проекта — вынести Harness-owned control plane в устанавливаемый CLI/Core.
- Не превращай `harness` CLI в обязательную обёртку вокруг `claude` или Codex TUI.
- При проектировании runtime integration сохраняй native Claude Code permissions, approvals, questions и interactive session semantics.
- Claude-specific transport/config не должен менять protocol semantics Harness Core.
- Общую логику, которая нужна также Codex/UI/VSCode integration, размещай в runtime-neutral core layer, а не в Claude-specific коде.
- Перед изменением protocol behavior сверяй текущий Harness template/reference и явно отделяй legacy repository-embedded implementation от целевой CLI architecture.
- Для проверки изменений используй штатные repository scripts из `package.json`; не подменяй их незафиксированными локальными процедурами.
