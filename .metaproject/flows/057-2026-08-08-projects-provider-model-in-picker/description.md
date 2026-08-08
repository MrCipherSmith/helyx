# /projects — show provider under Stop and current model under the gear

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

The `/projects` command renders each project as one text line (`icon name (path) · Provider/model`)
plus a single two-button row: `⏹/▶️ <name>` (left column) and `⚙️` (right column). The provider
and model live only in the text line, unaligned with the controls. The operator wants each
project's active config visible *next to* its controls — the **provider name under the Stop/Start
button** (left column) and the **current model under the `⚙️` gear** (right column) — so a glance at
the keyboard shows what every project runs on.

The rendering is also duplicated: `handleProjects` and `handleProjectCallback` build the same
list+keyboard by copy-paste, so any change has to be made twice.

## Expected Outcome

`/projects` renders, per project, a **second button row** under the action row: left cell =
provider name, right cell = current model. The two render sites share one helper (no duplication),
and the now-redundant `· Provider/model` text annotation is removed. typecheck + unit tests pass.

## Out of Scope

- The model picker itself (fixed in #101 — live Ollama base labels).
- The broken Ollama provider / altsay session (dead proxy on :3458) — separate work.
- Provider registration / preset changes.
- Making the provider/model info buttons navigate (kept display-only this flow).
