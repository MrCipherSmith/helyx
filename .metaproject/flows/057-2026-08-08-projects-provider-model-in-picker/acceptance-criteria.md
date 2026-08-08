# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `bun run typecheck` exits 0 with no errors.
- AC2: `bun test tests/unit/` passes, including a test asserting the projects render gives each project two button rows — the action row and an info row whose left button is the provider label and whose right button is the model label.
- AC3: For a configured project (non-default provider and a model), `/projects` renders an info row with left button = provider name (e.g. "GLM (Z.ai)") and right button = the current model (e.g. "glm-5.2"); for a default project the provider label is "Claude" and the model is the selected/default model.
- AC4: The message text lines no longer contain the `· Provider/model` annotation (it lives only in the buttons now).
- AC5: The provider/model info buttons use a callback that changes no project, provider, or model state (display-only, answered via answerCallbackQuery).
- AC6: `handleProjects` and `handleProjectCallback` do not duplicate the list/keyboard building — both call one shared render helper.
