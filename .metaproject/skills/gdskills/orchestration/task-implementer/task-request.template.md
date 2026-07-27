# Task Implementer — Task Request

<!--
  ШАБЛОН ЗАПРОСА НА ИМПЛЕМЕНТАЦИЮ ЗАДАЧИ
  =======================================
  Заполняется оркестратором ПЕРЕД запуском task-implementer.
  Все обязательные поля (*) должны быть заполнены.
  
  Валидация: input-contract.schema.json
  Использование: orchestrator-prompt.md читает этот файл и формирует промпт для субагента.
-->

## Task *

| Field | Value |
|-------|-------|
| Task ID * | `task-1` |
| Task Name * | `Add validation to pipeline step form` |
| Task Type * | `ui_component` |
| Complexity | `medium` |
| Dependencies | `none` |

## Description *

<!-- Полное описание задачи из Scenario issue-analyzer -->

Add client-side validation to the pipeline step configuration form. Validate required fields (name, type) before allowing save. Show inline error messages using Ant Design Form validation.

## Target Files *

| Path | Action |
|------|--------|
| `src/pipelines/components/StepForm.tsx` | `modify` |
| `src/pipelines/components/StepForm.test.tsx` | `create` |
| `src/pipelines/components/StepForm.stories.tsx` | `create` |

## Acceptance Criteria *

- Required fields show validation errors when empty on submit
- Form cannot be submitted with invalid data
- Error messages disappear when field is corrected
- Validation follows existing form patterns in the project

## Context

<!-- Контекст кода: типы, сигнатуры, паттерны -->

```typescript
// Existing type from src/pipelines/types.ts
interface StepConfig {
  name: string;
  type: StepType;
  params: Record<string, unknown>;
}
```

## Existing Tests

| Path |
|------|
| `none` |

## Existing Stories

| Path |
|------|
| `none` |

## Module Patterns

<!-- Как написан похожий код в этом модуле -->

Components in `src/pipelines/components/` use `observer()` wrapping, props interfaces named `<Component>Props`, Ant Design `Form` with `useForm` hook. Validation uses `rules` prop on `Form.Item`.

## Workspace *

| Field | Value |
|-------|-------|
| Codebase Path * | `/Users/dev/<PROJECT>` |
| Branch * | `feature/4141-add-pipeline-validation` |
| Issue Number * | `4141` |
| Issue Title | `Add validation to pipeline step form` |

## Fix Context (only for fix tasks)

<!-- Заполняется только если task_type = "fix" и задача пришла из review loop -->

| Field | Value |
|-------|-------|
| Original Task ID | |
| Iteration | |

### Review Feedback

<!-- Structured findings from reviewers -->

| File | Line | Severity | Message | Reviewer |
|------|------|----------|---------|----------|
| | | | | |

## Automation Settings *

| Setting | Value | Description |
|---------|-------|-------------|
| skip_confirmation * | `true` | Must be true for autonomous mode |
| auto_commit | `true` | Commit changes after implementation |
| verify_lint | `true` | Run ESLint |
| verify_types | `true` | Run type-check |
| verify_tests | `true` | Run tests |
| verify_stories | `false` | Build storybook |
| max_self_fix_attempts | `3` | Max self-fix attempts |
