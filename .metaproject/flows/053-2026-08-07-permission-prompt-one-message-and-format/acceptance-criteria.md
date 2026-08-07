# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A permission prompt whose rendered HTML fits within Telegram's 4096-character limit is delivered as exactly one message, carrying the `🔐 Allow?` header, the tool line, the change in a `<pre><code>` block, and the three-button keyboard.
- AC2: A permission prompt whose rendered HTML exceeds the limit still delivers, by falling back to the existing preview-message-then-prompt-message pair.
- AC3: The tool line names the file by its last two path segments, matching the spelling the preview header already uses; no absolute path appears in the prompt.
- AC4: After `✅ Yes`, `✅ Always` or `❌ No`, the edited message is sent with `parse_mode: HTML` and its fenced block is still a fenced block — the text is rebuilt from stored request fields, not read back from `ctx.callbackQuery.message.text`.
- AC5: A pending request stored before this change, with no rendered fields, still answers on tap without throwing, falling back to the previous plain-text edit.
- AC6: The inline keyboard is defined in exactly one place; `channel/permissions.ts` and `scripts/tmux-watchdog.ts` both call it.
- AC7: `bun test tests/unit/` passes with new tests covering the single-message render, the oversize fallback, the rebuilt HTML edit, and the legacy-row fallback.
