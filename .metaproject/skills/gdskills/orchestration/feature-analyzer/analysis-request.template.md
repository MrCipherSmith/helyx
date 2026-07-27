# Feature Analyzer — Analysis Request

<!-- 
  ШАБЛОН ЗАПРОСА НА АНАЛИЗ
  ========================
  Этот файл заполняется оркестратором (или человеком) ПЕРЕД запуском feature-analyzer.
  Все обязательные поля (*) должны быть заполнены, чтобы скилл работал автономно.
  
  Валидация: input-contract.schema.json
  Использование: orchestrator-prompt.md читает этот файл и формирует промпт для субагента.
-->

## Source Repository *

| Field | Value |
|-------|-------|
| Local Path * | `/Users/dev/<PROJECT>` |
| GitHub Repo | `org/<PROJECT>` |
| Branch * | `feature/pipeline-variables` |

## Target Repository *

| Field | Value |
|-------|-------|
| Local Path * | `/Users/dev/<PROJECT>` |
| GitHub Repo | `org/<PROJECT>` |
| Branch | `main` |

## Analysis Mode *

<!-- Выбери один: A или B -->

- **Mode**: `A`
  - `A` = Changes Analysis (diff base..HEAD) — requires base_branch
  - `B` = Current State Analysis (explore entire codebase) — no base_branch needed

- **Base Branch** (only for Mode A): `main`

## Focus (optional)

| Field | Value |
|-------|-------|
| Description | `variables in pipelines` |
| Keywords | `variable, pipeline, param` |
| Directories | `src/pipelines, src/models` |
| Scope | `api_contracts, business_logic` |

<!-- Scope options: api_contracts, full_plan, breaking_changes, business_logic, feature_formalization -->

## Ticket (optional)

| Field | Value |
|-------|-------|
| URL | `https://github.com/org/repo/issues/123` |
| Title | |
| Description | |

## Automation Settings *

<!-- Эти настройки УСТРАНЯЮТ все 7 точек интерактивности скилла -->

| Setting | Value | Description |
|---------|-------|-------------|
| skip_confirmation * | `true` | Пропустить Guard Clause — не спрашивать подтверждение |
| cache_strategy * | `reuse_if_valid` | `fresh` / `reuse_if_valid` / `refresh` / `compare` |
| large_changeset_action * | `p0_only` | `directory` / `file_types` / `commits` / `p0_only` / `abort` |
| large_changeset_max_files | `7` | Макс. кол-во файлов |
| timeout_strategy * | `partial` | `partial` / `extend` / `prioritize_p0` / `abort` |
| intermediate_review * | `skip` | `skip` / `log_only` / `include_in_report` |
| github_mcp_fallback | `git_only` | `git_only` / `abort` |

## Output Configuration (optional)

| Field | Value |
|-------|-------|
| Base Dir | `<DOCS_ROOT>/analysis` |
| Folder Name | |
| Languages | `en, ru, ai` |
| Include Metrics | `true` |
