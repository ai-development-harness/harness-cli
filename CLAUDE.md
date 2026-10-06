@AGENTS.md

# Bootstrap Claude Code

Этот файл содержит только Claude-specific инструкции для работы **над репозиторием harness-cli**. Основной контракт находится в `AGENTS.md` и имеет приоритет.

Дополнительные правила:

- Не интерпретируй этот репозиторий как обычный пользовательский Harness project только потому, что здесь разрабатывается сам Harness.
- Не создавай repository-embedded `.harness/tools/**` как архитектуру по умолчанию: цель проекта — внешний устанавливаемый Harness.
- Не добавляй в Harness CLI запуск, выбор, auth management, model/effort configuration, cancellation или process supervision Claude Code, Codex либо другого AI runtime.
- Claude Code является внешним caller: когда ему нужна механика Harness, он должен использовать deterministic CLI/Core contract, а не становиться частью Core.
- Claude-specific bootstrap не должен менять semantics protocol, execution state, Git safety или release ownership.
- Перед изменением поведения протокола сверяйся с актуальными product/architecture contracts и exact compatibility baseline.
- Для проверки изменений используй штатные scripts из `package.json`.
