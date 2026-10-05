import { protocolModelSchema, type ProtocolModel } from './schema.js';

/**
 * Canonical Harness command/CTS model extracted from:
 * ai-development-harness/ai-development-harness-template
 * commit 9f4aa325154253ab72a8c5940e988046ae872c99 (Harness v0.10.4).
 *
 * PARITY-COMMAND-001 / PARITY-CTS-002 / PARITY-AUTHORITY-003.
 *
 * This is the active Core source of truth after issue #32 cutover.
 * Do not maintain a second reasoning/help/transition model beside this data.
 */
const RAW_PROTOCOL_MODEL = {
  "schemaVersion": 1,
  "authorityContract": {
    "schemaVersion": 1,
    "semanticResult": "proposal",
    "executionStateCommit": "dispatcher",
    "transitionCommit": "dispatcher",
    "canonicalArtifactCommit": "deterministic-writer",
    "sideEffectCommit": "deterministic-action"
  },
  "validationOrder": [
    "tokenize",
    "normalize",
    "transition-table",
    "runtime-preconditions",
    "dispatch"
  ],
  "chainSeparator": " > ",
  "domains": {
    "PROJECT": {
      "chainEnabled": false,
      "inheritTarget": false,
      "continuationAliases": {},
      "commands": {
        "INIT": {
          "canonical": "PROJECT INIT",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Инициализировать проект под управлением Harness из локального описания проекта.",
          "documentation": ".harness/docs/COMMANDS.md#command-project-init",
          "dispatch": {
            "kind": "semantic",
            "skill": "init-project"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Преобразование исходного описания проекта в согласованные требования и план работ",
              "Смысловая проверка согласованности начальных артефактов"
            ],
            "deterministicWork": [
              "Проверка схемы и целостности",
              "Запись канонических артефактов и проекций"
            ],
            "fastPaths": []
          }
        },
        "STATUS": {
          "canonical": "PROJECT STATUS",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать текущее состояние проекта, блокирующие проблемы и доступную работу.",
          "documentation": ".harness/docs/COMMANDS.md#command-project-status",
          "dispatch": {
            "kind": "deterministic",
            "handler": "project-status"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Пересборка проекций",
              "Проверка целостности",
              "Формирование сводки состояния",
              "Расчёт следующей доступной работы"
            ],
            "fastPaths": []
          }
        },
        "RECONCILE": {
          "canonical": "PROJECT RECONCILE",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Сверить артефакты проекта с фактическим состоянием репозитория и подготовить необходимые исправления.",
          "documentation": ".harness/docs/COMMANDS.md#command-project-reconcile",
          "dispatch": {
            "kind": "semantic",
            "skill": "reconcile-project"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Сопоставление фактической реализации с требованиями, архитектурой и планом",
              "Классификация расхождений и подготовка корректирующих действий"
            ],
            "deterministicWork": [
              "Миграция поддерживаемых схем",
              "Пересборка проекций",
              "Проверка ссылок и целостности"
            ],
            "fastPaths": []
          }
        },
        "QUICK FIX": {
          "canonical": "PROJECT QUICK FIX:",
          "chainAllowed": false,
          "target": "none",
          "input": "required",
          "summary": "Выполнить небольшое безопасное изменение без отдельного STEP.",
          "documentation": ".harness/docs/COMMANDS.md#command-project-quick-fix",
          "dispatch": {
            "kind": "semantic",
            "skill": "quick-fix"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Определение, что изменение действительно мало и не меняет контракт",
              "Внесение самой правки"
            ],
            "deterministicWork": [
              "Проверка ограничений",
              "Проверка результата"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": []
    },
    "STEP": {
      "chainEnabled": true,
      "inheritTarget": true,
      "continuationAliases": {},
      "commands": {
        "ADD": {
          "canonical": "STEP ADD:",
          "chainAllowed": false,
          "target": "none",
          "input": "required",
          "summary": "Создать новый STEP из краткого описания задачи.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-add",
          "dispatch": {
            "kind": "semantic",
            "skill": "add-plan-step"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Определение границ задачи, зависимостей и связей с требованиями и архитектурными решениями"
            ],
            "deterministicWork": [
              "Выдача идентификатора",
              "Запись и проверка структуры STEP"
            ],
            "fastPaths": []
          }
        },
        "LIST": {
          "canonical": "STEP LIST",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать компактный список STEP и их текущих состояний.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-list",
          "dispatch": {
            "kind": "deterministic",
            "handler": "step-list"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Чтение и упорядочивание канонических STEP"
            ],
            "fastPaths": []
          }
        },
        "SHOW": {
          "canonical": "STEP SHOW STEP-NNN",
          "chainAllowed": false,
          "target": "step",
          "input": "none",
          "summary": "Показать подробное состояние выбранного STEP и связанный контекст выполнения.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-show",
          "dispatch": {
            "kind": "deterministic",
            "handler": "step-show"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Чтение STEP и связанных проверяемых данных"
            ],
            "fastPaths": []
          }
        },
        "NEXT": {
          "canonical": "STEP NEXT",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Рекомендовать следующий STEP, который можно выполнять.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-next",
          "dispatch": {
            "kind": "deterministic",
            "handler": "step-next"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Анализ состояния, приоритетов, зависимостей и влияния на последующие задачи",
              "Выбор следующей канонической команды"
            ],
            "fastPaths": []
          }
        },
        "PLAN": {
          "canonical": "STEP PLAN STEP-NNN",
          "chainAllowed": true,
          "target": "step",
          "input": "none",
          "summary": "Подготовить и независимо проверить план реализации STEP.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-plan",
          "dispatch": {
            "kind": "semantic",
            "skill": "plan-step",
            "contextPhase": "plan"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Подготовка плана реализации",
              "Независимая смысловая проверка плана"
            ],
            "deterministicWork": [
              "Сбор точного контекста",
              "Расчёт отпечатков",
              "Запись и проверка плана"
            ],
            "fastPaths": []
          }
        },
        "IMPLEMENT": {
          "canonical": "STEP IMPLEMENT STEP-NNN",
          "chainAllowed": true,
          "target": "step",
          "input": "none",
          "summary": "Выполнить утверждённый план реализации выбранного STEP.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-implement",
          "dispatch": {
            "kind": "semantic",
            "skill": "implement-step",
            "contextPhase": "implement"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Изменение кода и конфигурации по утверждённому плану"
            ],
            "deterministicWork": [
              "Проверка готовности плана и зависимостей",
              "Запуск автоматических проверок",
              "Фиксация доказательств выполнения"
            ],
            "fastPaths": []
          }
        },
        "REVIEW": {
          "canonical": "STEP REVIEW STEP-NNN",
          "chainAllowed": true,
          "target": "step",
          "input": "none",
          "summary": "Провести независимую проверку текущей реализации STEP.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-review",
          "dispatch": {
            "kind": "semantic",
            "skill": "review-step",
            "contextPhase": "review"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Поиск смысловых дефектов реализации",
              "Проверка соответствия требованиям и критериям приёмки"
            ],
            "deterministicWork": [
              "Выбор обязательных специализированных проверок",
              "Фиксация точной ревизии",
              "Запись и проверка отчёта",
              "Проверка доказательства завершения"
            ],
            "fastPaths": []
          }
        },
        "FIX": {
          "canonical": "STEP FIX STEP-NNN",
          "chainAllowed": true,
          "target": "step",
          "input": "none",
          "summary": "Исправить подтверждённые замечания последней неуспешной проверки.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-fix",
          "dispatch": {
            "kind": "semantic",
            "skill": "fix-step"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Исправление подтверждённых замечаний"
            ],
            "deterministicWork": [
              "Контроль допустимого перехода",
              "Запуск автоматических проверок",
              "Обновление доказательств выполнения"
            ],
            "fastPaths": []
          }
        },
        "RUN": {
          "canonical": "STEP RUN STEP-NNN",
          "chainAllowed": false,
          "target": "step",
          "input": "none",
          "summary": "Автоматически провести STEP через планирование, реализацию, проверку и циклы исправлений.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-run",
          "dispatch": {
            "kind": "semantic",
            "skill": "run-step"
          },
          "reasoning": {
            "mode": "conditional",
            "modelWork": [
              "В обычном цикле модель вызывается внутри дочерних PLAN, IMPLEMENT, REVIEW и FIX",
              "Для специальных типов STEP дополнительно используется смысловая оркестрация самого STEP RUN"
            ],
            "deterministicWork": [
              "Оркестрация обычного цикла планирования, реализации, проверки и исправлений",
              "Учёт лимита циклов исправления и проверки",
              "Возобновление прерванного выполнения"
            ],
            "fastPaths": [
              {
                "id": "coding-step-orchestration",
                "description": "Для обычных задач разработки переходы между PLAN, IMPLEMENT, REVIEW и FIX выполняются без отдельного вызова модели",
                "implementation": ".harness/tools/command_dispatch.py::_dispatch_step_run"
              }
            ]
          }
        },
        "AUDIT": {
          "canonical": "STEP AUDIT STEP-NNN",
          "chainAllowed": false,
          "target": "step",
          "input": "none",
          "summary": "Провести формальный аудит STEP без изменения рабочего кода и данных проекта.",
          "documentation": ".harness/docs/COMMANDS.md#command-step-audit",
          "dispatch": {
            "kind": "semantic",
            "skill": "audit-step"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Сопоставление STEP, реализации и доказательств",
              "Формулировка выводов аудита"
            ],
            "deterministicWork": [
              "Сбор проверяемых фактов",
              "Проверка ссылок и состояния артефактов",
              "Запись отчёта"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": [
        {
          "from": "PLAN",
          "to": "IMPLEMENT",
          "onPreviousResult": [
            "SUCCESS"
          ],
          "runtimePreconditions": [
            "step-implement-ready"
          ]
        },
        {
          "from": "IMPLEMENT",
          "to": "REVIEW",
          "onPreviousResult": [
            "SUCCESS"
          ],
          "runtimePreconditions": []
        },
        {
          "from": "REVIEW",
          "to": "FIX",
          "onPreviousResult": [
            "FAIL"
          ],
          "runtimePreconditions": []
        },
        {
          "from": "FIX",
          "to": "REVIEW",
          "onPreviousResult": [
            "SUCCESS"
          ],
          "runtimePreconditions": []
        }
      ]
    },
    "SKILL": {
      "chainEnabled": false,
      "inheritTarget": false,
      "continuationAliases": {},
      "commands": {
        "FIND": {
          "canonical": "SKILL FIND:",
          "chainAllowed": false,
          "target": "none",
          "input": "required",
          "summary": "Найти подходящие навыки и сформировать короткий список кандидатов.",
          "documentation": ".harness/docs/COMMANDS.md#command-skill-find",
          "dispatch": {
            "kind": "semantic",
            "skill": "find-skill"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Оценка пригодности найденных навыков и связанных рисков"
            ],
            "deterministicWork": [
              "Ограничение размера выдачи",
              "Фиксация происхождения и результатов поиска"
            ],
            "fastPaths": []
          }
        },
        "INSTALL": {
          "canonical": "SKILL INSTALL:",
          "chainAllowed": false,
          "target": "none",
          "input": "required",
          "summary": "Установить выбранный навык после проверки содержимого и происхождения.",
          "documentation": ".harness/docs/COMMANDS.md#command-skill-install",
          "dispatch": {
            "kind": "semantic",
            "skill": "install-skill"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Проверка содержимого, происхождения и рисков стороннего навыка"
            ],
            "deterministicWork": [
              "Копирование выбранного набора файлов",
              "Обновление реестра и маршрутизации",
              "Проверка целостности"
            ],
            "fastPaths": []
          }
        },
        "CREATE": {
          "canonical": "SKILL CREATE:",
          "chainAllowed": false,
          "target": "none",
          "input": "required",
          "summary": "Создать навык проекта для отсутствующего сценария работы.",
          "documentation": ".harness/docs/COMMANDS.md#command-skill-create",
          "dispatch": {
            "kind": "semantic",
            "skill": "create-skill"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Проектирование нового навыка под отсутствующий сценарий"
            ],
            "deterministicWork": [
              "Проверка структуры",
              "Регистрация и проверка маршрутизации"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": []
    },
    "GITHUB": {
      "chainEnabled": false,
      "inheritTarget": false,
      "continuationAliases": {},
      "commands": {
        "GENERATE TEMPLATES": {
          "canonical": "GITHUB GENERATE TEMPLATES",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Пересоздать шаблоны GitHub для задач и запросов на слияние с учётом текущего проекта.",
          "documentation": ".harness/docs/COMMANDS.md#command-github-generate-templates",
          "dispatch": {
            "kind": "semantic",
            "skill": "generate-github-templates"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Анализ текущего технологического стека и правил проекта",
              "Формирование содержимого шаблонов"
            ],
            "deterministicWork": [
              "Запись шаблонов",
              "Проверка структуры файлов"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": []
    },
    "RELEASE": {
      "chainEnabled": false,
      "inheritTarget": false,
      "continuationAliases": {},
      "commands": {
        "CHECK": {
          "canonical": "RELEASE CHECK",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Проверить готовность проекта к выпуску новой версии.",
          "documentation": ".harness/docs/COMMANDS.md#command-release-check",
          "dispatch": {
            "kind": "semantic",
            "skill": "release-check"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Оценка смысловых рисков выпуска",
              "Проверка соответствия фактического состояния заявленной готовности"
            ],
            "deterministicWork": [
              "Сбор проверяемых фактов",
              "Запуск обязательных проверок",
              "Запись отчёта"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": []
    },
    "HARNESS": {
      "chainEnabled": true,
      "inheritTarget": true,
      "continuationAliases": {
        "APPLY": "UPDATE APPLY"
      },
      "commands": {
        "HELP": {
          "canonical": "HARNESS HELP",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать доступные команды Harness с краткими описаниями и ссылками на документацию.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-help",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-help"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Формирование справки из таблицы канонических команд"
            ],
            "fastPaths": []
          }
        },
        "UPDATE CHECK": {
          "canonical": "HARNESS UPDATE CHECK",
          "chainAllowed": true,
          "target": "release-optional",
          "input": "none",
          "summary": "Проверить доступный путь обновления Harness без внесения изменений.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-update-check",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-update-check"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Построение маршрута обновления",
              "Проверка версий, владения файлами и возможных конфликтов",
              "Предварительная проверка без изменения проекта"
            ],
            "fastPaths": []
          }
        },
        "UPDATE APPLY": {
          "canonical": "HARNESS UPDATE APPLY",
          "chainAllowed": true,
          "target": "release-optional",
          "input": "none",
          "summary": "Применить допустимое обновление Harness.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-update-apply",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-update-apply"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Пошаговое применение обновления",
              "Трёхстороннее слияние разрешённых файлов",
              "Откат при ошибке",
              "Проверка результата и обновление состояния версии"
            ],
            "fastPaths": []
          }
        },
        "STATUS": {
          "canonical": "HARNESS STATUS",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать текущее состояние Harness, Git и незавершённых выполнений команд.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-status",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-status"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Сбор состояния Harness, Git и незавершённых команд"
            ],
            "fastPaths": []
          }
        },
        "RESUME": {
          "canonical": "HARNESS RESUME",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Продолжить единственное выполнение, которое можно безопасно возобновить.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-resume",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-resume"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Поиск единственного безопасно возобновляемого выполнения",
              "Восстановление следующего действия"
            ],
            "fastPaths": []
          }
        },
        "DOCTOR": {
          "canonical": "HARNESS DOCTOR",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Проверить обязательные зависимости, исправность Harness и доступность необязательных возможностей.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-doctor",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-doctor"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Проверка обязательных зависимостей и исправности среды"
            ],
            "fastPaths": []
          }
        },
        "CONFIG": {
          "canonical": "HARNESS CONFIG",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать фактически применяемую конфигурацию Harness и файлы, из которых она получена.",
          "documentation": ".harness/docs/COMMANDS.md#command-harness-config",
          "dispatch": {
            "kind": "deterministic",
            "handler": "harness-config"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Сбор фактически применяемой конфигурации и её источников"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": [
        {
          "from": "UPDATE CHECK",
          "to": "UPDATE APPLY",
          "onPreviousResult": [
            "PASS"
          ],
          "runtimePreconditions": [
            "matching-update-target-and-route"
          ]
        }
      ]
    },
    "GIT": {
      "chainEnabled": true,
      "inheritTarget": false,
      "continuationAliases": {},
      "commands": {
        "CHECK": {
          "canonical": "GIT CHECK",
          "chainAllowed": true,
          "target": "none",
          "input": "none",
          "summary": "Показать результаты предварительной проверки Git и текущее состояние репозитория.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-check",
          "dispatch": {
            "kind": "deterministic",
            "handler": "git-check"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Проверка ветки, удалённого репозитория, рабочих изменений, политик и целостности Harness"
            ],
            "fastPaths": []
          }
        },
        "COMMIT": {
          "canonical": "GIT COMMIT",
          "chainAllowed": true,
          "target": "none",
          "input": "optional",
          "summary": "Безопасно подготовить и создать локальный коммит в соответствии с политикой Git.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-commit",
          "dispatch": {
            "kind": "semantic",
            "skill": "git-workflow"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Проверка, что изменения образуют одно смысловое изменение",
              "Выбор типа и формулировка сообщения коммита"
            ],
            "deterministicWork": [
              "Проверка политики Git",
              "Безопасная подготовка файлов",
              "Создание коммита",
              "Проверка изменения HEAD"
            ],
            "fastPaths": []
          }
        },
        "PUSH": {
          "canonical": "GIT PUSH",
          "chainAllowed": true,
          "target": "none",
          "input": "none",
          "summary": "Отправить текущую ветку в настроенный удалённый репозиторий без принудительной отправки.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-push",
          "dispatch": {
            "kind": "semantic",
            "skill": "git-workflow"
          },
          "reasoning": {
            "mode": "conditional",
            "modelWork": [
              "Проверка смысловой целостности отправляемого изменения при отдельном запуске команды"
            ],
            "deterministicWork": [
              "Проверка состояния Git и политики отправки",
              "Отправка без принудительной перезаписи",
              "Проверка опубликованного HEAD"
            ],
            "fastPaths": [
              {
                "id": "after-commit",
                "description": "Если PUSH следует сразу после доказанного GIT COMMIT в той же цепочке, повторный вызов модели не требуется",
                "implementation": ".harness/tools/command_dispatch.py::_git_push_after_commit_fast_path"
              }
            ]
          }
        },
        "PR": {
          "canonical": "GIT PR",
          "chainAllowed": true,
          "target": "none",
          "input": "none",
          "summary": "Создать или переиспользовать запрос на слияние для опубликованной ветки.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-pr",
          "dispatch": {
            "kind": "semantic",
            "skill": "git-workflow"
          },
          "reasoning": {
            "mode": "required",
            "modelWork": [
              "Формирование заголовка и описания запроса на слияние"
            ],
            "deterministicWork": [
              "Проверка опубликованной ветки",
              "Поиск существующего запроса на слияние",
              "Создание или переиспользование запроса",
              "Проверка опубликованной ревизии"
            ],
            "fastPaths": []
          }
        },
        "PR FINISH": {
          "canonical": "GIT PR FINISH",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Завершить локальную работу после слияния запроса: вернуться на исходную ветку и удалить локальную ветку запроса.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-pr-finish",
          "dispatch": {
            "kind": "deterministic",
            "handler": "git-pr-finish"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Подтверждение слияния",
              "Безопасный возврат на исходную ветку",
              "Синхронизация только перемоткой вперёд",
              "Удаление проверенной локальной ветки"
            ],
            "fastPaths": []
          }
        },
        "SYNC": {
          "canonical": "GIT SYNC",
          "chainAllowed": false,
          "target": "none",
          "input": "none",
          "summary": "Показать расхождение с удалённой веткой или выполнить разрешённую синхронизацию в режиме fast-forward.",
          "documentation": ".harness/docs/COMMANDS.md#command-git-sync",
          "dispatch": {
            "kind": "deterministic",
            "handler": "git-sync"
          },
          "reasoning": {
            "mode": "none",
            "modelWork": [],
            "deterministicWork": [
              "Обновление сведений об удалённом репозитории",
              "Расчёт расхождения",
              "Безопасная перемотка вперёд при разрешении"
            ],
            "fastPaths": []
          }
        }
      },
      "transitions": [
        {
          "from": "CHECK",
          "to": "COMMIT",
          "onPreviousResult": [
            "PASS"
          ],
          "runtimePreconditions": []
        },
        {
          "from": "CHECK",
          "to": "PUSH",
          "onPreviousResult": [
            "PASS"
          ],
          "runtimePreconditions": [
            "git-push-ready"
          ]
        },
        {
          "from": "CHECK",
          "to": "PR",
          "onPreviousResult": [
            "PASS"
          ],
          "runtimePreconditions": [
            "git-pr-ready"
          ]
        },
        {
          "from": "COMMIT",
          "to": "PUSH",
          "onPreviousResult": [
            "SUCCESS"
          ],
          "runtimePreconditions": []
        },
        {
          "from": "PUSH",
          "to": "PR",
          "onPreviousResult": [
            "SUCCESS"
          ],
          "runtimePreconditions": []
        }
      ]
    }
  }
} as const;

export const PROTOCOL_MODEL: ProtocolModel = protocolModelSchema.parse(RAW_PROTOCOL_MODEL);
