# Feature Analyzer — Analysis Request: Async Search

## Source Repository *

| Field | Value |
|-------|-------|
| Local Path * | `<SOURCE_PROJECT_DIR>` |
| GitHub Repo | |
| Branch * | `develop-2` |

## Target Repository *

| Field | Value |
|-------|-------|
| Local Path * | `<TARGET_PROJECT_DIR>` |
| GitHub Repo | |
| Branch | `develop-2` |

## Analysis Mode *

- **Mode**: `B`
  - `B` = Current State Analysis (explore entire codebase) — no base_branch needed

- **Base Branch**: _(not applicable for Mode B)_

## Focus (optional)

| Field | Value |
|-------|-------|
| Description | `async search` |
| Keywords | `async, search, query, find, filter, lookup` |
| Directories | `src/search, src/services, src/modules` |
| Scope | `api_contracts, business_logic, feature_formalization` |

## Ticket (optional)

| Field | Value |
|-------|-------|
| URL | |
| Title | |
| Description | |

## Automation Settings *

| Setting | Value | Description |
|---------|-------|-------------|
| skip_confirmation * | `true` | Пропустить Guard Clause |
| cache_strategy * | `fresh` | Всегда новый анализ |
| large_changeset_action * | `p0_only` | Только P0 файлы |
| large_changeset_max_files | `7` | Макс. кол-во файлов |
| timeout_strategy * | `partial` | Отдать что есть при таймауте |
| intermediate_review * | `include_in_report` | Включить в отчёт |
| github_mcp_fallback | `git_only` | Только локальный git |

## Output Configuration (optional)

| Field | Value |
|-------|-------|
| Base Dir | `.metaproject/jobs/<job-name>/ai/analysis` |
| Folder Name | `async-search-current-state` |
| Languages | `en, ru, ai` |
| Include Metrics | `true` |
