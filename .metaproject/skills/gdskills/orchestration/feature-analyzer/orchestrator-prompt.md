# Feature Analyzer — Orchestrator Prompt

<!--
  НАЗНАЧЕНИЕ
  ==========
  Этот промпт используется агентом-оркестратором для запуска feature-analyzer
  как субагента БЕЗ интерактивности. Оркестратор:
  1. Читает заполненный analysis-request.md (input-файл)
  2. Парсит параметры из таблиц
  3. Формирует единый промпт для субагента
  4. Запускает субагент через Task tool
  5. Получает результат — путь к сгенерированной документации

  ПОТОК ДАННЫХ
  ============
  [Пользователь] → заполняет analysis-request.md
                    ↓
  [Оркестратор]  → читает MD → парсит → формирует промпт → Task(subagent)
                    ↓
  [Субагент]     → выполняет SKILL.md feature-analyzer автономно
                    ↓
  [Результат]    → docs/analysis/<feature>-<date>/
-->

## Инструкция для оркестратора

### Шаг 1: Прочитать input-файл

Прочитай файл analysis-request с параметрами анализа. Файл может находиться:
- По пути указанному пользователем
- В `.metaproject/skills/gdskills/orchestration/feature-analyzer/analysis-request.md` (если пользователь заполнил шаблон)

Извлеки из таблиц следующие значения (парсинг Markdown-таблиц):

```
SOURCE:
  local_path     → из таблицы "Source Repository", строка "Local Path"
  github_repo    → из таблицы "Source Repository", строка "GitHub Repo"
  branch         → из таблицы "Source Repository", строка "Branch"

TARGET:
  local_path     → из таблицы "Target Repository", строка "Local Path"
  github_repo    → из таблицы "Target Repository", строка "GitHub Repo"
  branch         → из таблицы "Target Repository", строка "Branch"

MODE:
  mode           → из секции "Analysis Mode", значение после "Mode:"
  base_branch    → из секции "Analysis Mode", значение после "Base Branch"

FOCUS:
  description    → из таблицы "Focus", строка "Description"
  keywords       → из таблицы "Focus", строка "Keywords" (split by comma)
  directories    → из таблицы "Focus", строка "Directories" (split by comma)
  scope          → из таблицы "Focus", строка "Scope" (split by comma)

TICKET:
  url            → из таблицы "Ticket", строка "URL"

AUTOMATION:
  cache_strategy              → из таблицы "Automation Settings"
  large_changeset_action      → из таблицы "Automation Settings"
  large_changeset_max_files   → из таблицы "Automation Settings"
  timeout_strategy            → из таблицы "Automation Settings"
  intermediate_review         → из таблицы "Automation Settings"
  github_mcp_fallback         → из таблицы "Automation Settings"

OUTPUT:
  base_dir       → из таблицы "Output Configuration"
  folder_name    → из таблицы "Output Configuration"
  languages      → из таблицы "Output Configuration" (split by comma)
```

### Шаг 2: Валидация

Проверь обязательные поля:

```
ASSERT source.local_path   IS NOT EMPTY  → иначе ABORT("Source path missing")
ASSERT source.branch       IS NOT EMPTY  → иначе ABORT("Source branch missing")
ASSERT target.local_path   IS NOT EMPTY  → иначе ABORT("Target path missing")
ASSERT mode                IN ["A", "B"] → иначе ABORT("Invalid mode")
IF mode == "A":
  ASSERT base_branch       IS NOT EMPTY  → иначе ABORT("Mode A requires base_branch")
```

### Шаг 3: Сформировать промпт для субагента

Подставь извлечённые значения в шаблон ниже и запусти через Task tool.

---

## Шаблон промпта для субагента

```
You are running the feature-analyzer skill in AUTONOMOUS MODE.
All interactive checkpoints are pre-resolved. DO NOT ask the user any questions.
DO NOT stop for confirmation. Execute the full workflow end-to-end.

Load the skill: feature-analyzer (from .metaproject/skills/gdskills/orchestration/feature-analyzer/SKILL.md)

═══════════════════════════════════════════════
  PRE-RESOLVED CONTEXT (Guard Clause SATISFIED)
═══════════════════════════════════════════════

SOURCE REPOSITORY:
  Local path:  {{source.local_path}}
  GitHub repo: {{source.github_repo}}
  Branch:      {{source.branch}}

TARGET REPOSITORY:
  Local path:  {{target.local_path}}
  GitHub repo: {{target.github_repo}}
  Branch:      {{target.branch}}

ANALYSIS MODE: {{mode}}
{{IF mode == "A"}}
  Base branch: {{base_branch}}
  → Run Mode A: Changes Analysis (git diff merge-base..HEAD)
{{ELSE}}
  → Run Mode B: Current State Analysis (explore entire codebase)
{{ENDIF}}

{{IF focus.description}}
FOCUS AREA:
  Description:  {{focus.description}}
  Keywords:     {{focus.keywords}}
  Directories:  {{focus.directories}}
  Scope:        {{focus.scope}}
  → Apply focus-based priority boost per SKILL.md rules
{{ENDIF}}

{{IF ticket.url}}
TICKET REFERENCE:
  URL: {{ticket.url}}
  → Fetch via GitHub MCP and extract business context
{{ENDIF}}

═══════════════════════════════════════════════
  AUTOMATION OVERRIDES (All interactions pre-resolved)
═══════════════════════════════════════════════

1. GUARD CLAUSE CONFIRMATION:
   → SKIP. Context is pre-validated. Proceed immediately.

2. ANALYSIS MODE SELECTION:
   → RESOLVED as Mode {{mode}}. Do not ask.

3. BASE BRANCH (Mode A):
   → RESOLVED as "{{base_branch}}". Do not ask.

4. EXISTING CACHE/REPORTS:
   → Strategy: {{automation.cache_strategy}}
   {{IF automation.cache_strategy == "fresh"}}
     → Ignore all existing analyses. Create new.
   {{ELIF automation.cache_strategy == "reuse_if_valid"}}
     → Check cache. If <7 days old AND same SHA → reuse. Else create new.
   {{ELIF automation.cache_strategy == "refresh"}}
     → Load previous analysis, analyze only new commits, merge results.
   {{ELIF automation.cache_strategy == "compare"}}
     → Create new analysis AND generate diff with existing.
   {{ENDIF}}

5. LARGE CHANGESET (50+ files):
   → Strategy: {{automation.large_changeset_action}}
   → Max files: {{automation.large_changeset_max_files}}
   {{IF automation.large_changeset_action == "p0_only"}}
     → Analyze only P0 priority files, max {{automation.large_changeset_max_files}}.
   {{ELIF automation.large_changeset_action == "directory"}}
     → Filter to directories: {{automation.large_changeset_filter_paths}}
   {{ELIF automation.large_changeset_action == "file_types"}}
     → Filter to extensions: {{automation.large_changeset_filter_extensions}}
   {{ELIF automation.large_changeset_action == "commits"}}
     → Analyze first {{automation.large_changeset_max_commits}} commits only.
   {{ELIF automation.large_changeset_action == "abort"}}
     → Return error: "Changeset too large, aborting per automation config."
   {{ENDIF}}

6. TIMEOUT (approaching 30 min):
   → Strategy: {{automation.timeout_strategy}}
   {{IF automation.timeout_strategy == "partial"}}
     → Generate report with whatever findings are available at that point.
   {{ELIF automation.timeout_strategy == "extend"}}
     → Continue for 15 more minutes, then force partial.
   {{ELIF automation.timeout_strategy == "prioritize_p0"}}
     → Drop all non-P0 files and finish only P0 analysis.
   {{ELIF automation.timeout_strategy == "abort"}}
     → Return error: "Analysis timed out, aborting per automation config."
   {{ENDIF}}

7. INTERMEDIATE REVIEW:
   → Strategy: {{automation.intermediate_review}}
   {{IF automation.intermediate_review == "skip"}}
     → Do NOT show intermediate summary. Proceed directly to documentation.
   {{ELIF automation.intermediate_review == "log_only"}}
     → Log intermediate summary in output but do not wait for confirmation.
   {{ELIF automation.intermediate_review == "include_in_report"}}
     → Include intermediate findings as a section in the final report.
   {{ENDIF}}

8. GITHUB MCP UNAVAILABLE:
   → Fallback: {{automation.github_mcp_fallback}}
   {{IF automation.github_mcp_fallback == "git_only"}}
     → Proceed with local git data only. No GitHub API calls.
   {{ELIF automation.github_mcp_fallback == "abort"}}
     → Return error: "GitHub MCP unavailable, aborting per automation config."
   {{ENDIF}}

═══════════════════════════════════════════════
  OUTPUT CONFIGURATION
═══════════════════════════════════════════════

Base directory: {{output.base_dir | default("<DOCS_ROOT>/analysis")}}
Folder name:    {{output.folder_name | default("auto-generated per SKILL.md rules")}}
Languages:      {{output.languages | default("en, ru, ai")}}
Include metrics: {{output.include_metrics | default("true")}}

═══════════════════════════════════════════════
  EXECUTION INSTRUCTIONS
═══════════════════════════════════════════════

1. Load feature-analyzer SKILL.md
2. Skip directly to Step 1 (context is pre-provided above)
3. Follow the workflow for Mode {{mode}} from SKILL.md
4. At every interaction checkpoint (marked above), use the pre-resolved strategy
5. Generate all output documents per SKILL.md structure
6. Return the following in your final message:
   - Path to generated analysis directory
   - Summary of key findings (3-5 bullet points)
   - Complexity score and risk level
   - List of generated files

DO NOT ask questions. DO NOT stop for user input. Run to completion.
```

---

## Пример вызова оркестратором

### Input: Заполненный analysis-request.md

```markdown
## Source Repository *
| Field | Value |
|-------|-------|
| Local Path * | `/Users/dev/<PROJECT>` |
| GitHub Repo | `<ORG>/<PROJECT>` |
| Branch * | `feature/pipeline-variables` |

## Target Repository *
| Field | Value |
|-------|-------|
| Local Path * | `/Users/dev/<PROJECT>` |
| Branch | `main` |

## Analysis Mode *
- **Mode**: `A`
- **Base Branch**: `main`

## Focus
| Field | Value |
|-------|-------|
| Description | `variables in pipelines` |
| Keywords | `variable, pipeline, param` |
| Directories | `src/pipelines, src/models` |

## Automation Settings *
| Setting | Value |
|---------|-------|
| skip_confirmation | `true` |
| cache_strategy | `fresh` |
| large_changeset_action | `p0_only` |
| large_changeset_max_files | `7` |
| timeout_strategy | `partial` |
| intermediate_review | `include_in_report` |
| github_mcp_fallback | `git_only` |
```

### Output: Сгенерированный промпт (после подстановки)

```
You are running the feature-analyzer skill in AUTONOMOUS MODE.
All interactive checkpoints are pre-resolved. DO NOT ask the user any questions.
...

SOURCE REPOSITORY:
  Local path:  /Users/dev/<PROJECT>
  GitHub repo: <ORG>/<PROJECT>
  Branch:      feature/pipeline-variables

TARGET REPOSITORY:
  Local path:  /Users/dev/<PROJECT>
  Branch:      main

ANALYSIS MODE: A
  Base branch: main
  → Run Mode A: Changes Analysis (git diff merge-base..HEAD)

FOCUS AREA:
  Description:  variables in pipelines
  Keywords:     variable, pipeline, param
  Directories:  src/pipelines, src/models
  → Apply focus-based priority boost per SKILL.md rules
...
```

### Вызов через Task tool

```javascript
Task({
  description: "Feature analysis: pipeline-variables",
  subagent_type: "general",
  prompt: "<сгенерированный промпт выше>"
})
```

---

## Карта устранённых интерактивных точек

| # | Interaction Point | Где в SKILL.md | Как устраняется |
|---|-------------------|---------------|-----------------|
| 1 | Guard Clause Confirmation | L22-54 | `skip_confirmation: true` + pre-provided context |
| 2 | Mode Selection | L576-589 | `analysis_mode.mode: "A"/"B"` |
| 3 | Base Branch Query | L650-670 | `analysis_mode.base_branch: "main"` |
| 4 | Existing Cache Dialog | L489-510 | `cache_strategy: "fresh"/"reuse_if_valid"/...` |
| 5 | Large Changeset Dialog | L442-457 | `large_changeset_strategy.action: "p0_only"/...` |
| 6 | Timeout Dialog | L427-431 | `timeout_strategy: "partial"/"extend"/...` |
| 7 | Intermediate Review | L1009-1046 | `intermediate_review: "skip"/"log_only"/...` |

---

## Рекомендуемые automation-профили

### Profile: Quick (быстрый анализ, минимум взаимодействия)
```
cache_strategy:         reuse_if_valid
large_changeset_action: p0_only
large_changeset_max_files: 5
timeout_strategy:       partial
intermediate_review:    skip
github_mcp_fallback:    git_only
```

### Profile: Thorough (полный анализ, максимум данных)
```
cache_strategy:         fresh
large_changeset_action: p0_only
large_changeset_max_files: 10
timeout_strategy:       extend
intermediate_review:    include_in_report
github_mcp_fallback:    git_only
```

### Profile: CI/CD (для автоматических пайплайнов)
```
cache_strategy:         fresh
large_changeset_action: p0_only
large_changeset_max_files: 7
timeout_strategy:       partial
intermediate_review:    skip
github_mcp_fallback:    git_only
```
