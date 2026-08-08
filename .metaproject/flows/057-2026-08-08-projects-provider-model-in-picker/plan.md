# Implementation Plan

Status: draft (flow-init skill fills this after context and brainstorm)

## Approach

Extract the duplicated list+keyboard rendering into one shared helper and, inside it, add a second
info button row per project (provider left, model right). Chosen over editing the two call sites in
parallel: the copy-paste is the reason a one-line change would land in two places and drift, so
removing the duplication is part of the fix, not a detour.

Telegram inline keyboards are grids of buttons — there is no "plain text under a button" — so the
provider/model cells are themselves buttons. They are display-only: a `pminf:<id>` callback that
answers the query with the full config and changes no state. (Making them open the provider/model
picker is a deliberate future option, left out of scope.)

## Steps

1. Add `renderProjectsMessage(projects, selections, pending)` → `{ text, keyboard }` in
   `bot/commands/projects.ts`. It builds the text lines and the InlineKeyboard once.
2. Per project: keep the action row (`⏹/▶️ <name>` | `⚙️`); append an info row
   `kb.text(providerLabel, "pminf:<id>").text(modelLabel, "pminf:<id>").row()`.
   - `providerLabel = cfg.providerName ?? "Claude"`, `modelLabel = cfg.model ?? "default"`.
3. Drop the `cfgLabel` (`· Provider/model`) from the text line — it now duplicates the buttons.
4. Add a `pminf` callback branch in `handleProjectModelCallback` (or the projects callback router):
   `answerCallbackQuery({ text: "<name> · <provider> / <model>" })`, no state change, no edit.
5. Replace the list-building blocks in `handleProjects` and `handleProjectCallback` with calls to
   the helper.
6. Add/extend unit tests for the helper (text without the annotation; two rows per project with
   provider/model labels; default vs configured project).

## Risks

- Keyboard size grows to 2 rows × N projects. Telegram caps ~100 buttons/inline keyboard; the
  current project count (~11) is far under, but the helper should not hard-fail if it grows.
- Removing the text annotation changes the existing list look — intended (buttons supersede it),
  but worth calling out in the PR.
- The info buttons must not be mistaken for controls: the `pminf` callback changes no state, and
  the label wording should read as status, not an action.
