# Issue Analyzer — Analysis Request

<!--
  ШАБЛОН ЗАПРОСА НА АНАЛИЗ ISSUE
  ===============================
  Заполняется оркестратором (или человеком) ПЕРЕД запуском issue-analyzer.
  Все обязательные поля (*) должны быть заполнены.
  
  Валидация: input-contract.schema.json
  Использование: orchestrator-prompt.md читает этот файл и формирует промпт для субагента.
-->

## Issue *

| Field | Value |
|-------|-------|
| URL * | `https://github.com/<ORG>/<PROJECT>/issues/4141` |
| Repo | `<ORG>/<PROJECT>` |
| Number | `4141` |
| Title (fallback) | |
| Description (fallback) | |

<!-- Укажи URL ИЛИ Repo+Number. Title/Description — fallback если gh CLI недоступен. -->

## Codebase Paths *

| Path * | Role * | Branch |
|--------|--------|--------|
| `/Users/dev/<PROJECT>` | `frontend` | `develop-2` |
| `/Users/dev/<PROJECT>` | `backend` | `develop-2` |

<!-- Минимум одна строка. Role: frontend / backend / shared -->

## Focus (optional)

| Field | Value |
|-------|-------|
| Keywords | `executor, step, save` |
| Directories | `src/pipelines` |

## Automation Settings *

| Setting | Value | Description |
|---------|-------|-------------|
| skip_confirmation * | `true` | Must be true for autonomous mode |
| max_tasks | `7` | Max tasks to decompose into (1-10) |
| search_depth | `focused` | `shallow` / `focused` / `deep` |
| include_context | `true` | Include code context in output |
| timeout_strategy | `partial` | `partial` / `abort` |
| gh_cli_fallback | `skip_enrichment` | `skip_enrichment` / `abort` |
