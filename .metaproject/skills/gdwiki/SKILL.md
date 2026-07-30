---
name: gdwiki
description: Use FIRST for conceptual questions - how something works, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions. Read wiki/index.md, then use gdgraph to reach code.
---

# gdwiki Skill

Use this skill for project knowledge that is not a literal code detail:
architecture, domain models, business rules, user scenarios, service/component
responsibilities, integrations, and known decisions. The user does not need to
explicitly ask for wiki usage.

## Routing (which skill first)

Pick the entry point by question type:

- Conceptual question - "how does X work", "why", architecture, domain, business rules, user scenarios, auth and other flows, integrations, known decisions - **use gdwiki first**: read `wiki/index.md`, open the relevant page, then use gdgraph to jump from that page to code.
- Structural question - "where is X", "what files are related", "what breaks if I change Y", usages, cycles, orphans - **use gdgraph first**; wiki is optional.
- gdctx runs **in parallel** in either case to keep command/search/file-read output compact. It is not a step in the sequence.

## Trigger Examples

- "Как работает авторизация?"
- "Где описан флоу логина / регистрации?"
- "Какие бизнес-правила у платежей?"
- "Объясни архитектуру этого модуля."
- "Какая доменная модель у заказа?"
- "Какие пользовательские сценарии при оплате?"
- "Почему приняли такое решение по интеграции?"
- "За что отвечает этот сервис и какие у него контракты?"

## Workflow

1. Read `.metaproject/wiki/index.md` first. It is short and lists every page by type with a summary.
2. Open only the specific pages relevant to the task. Do not read the whole wiki.
3. To move from a wiki concept to code, use `skills/gdgraph/SKILL.md` (each page has a `Related Code` section).
4. For compact command/search/read output while working, use `skills/gdctx/SKILL.md`.
5. Treat wiki pages as curated context. Verify important claims against source code before editing or reporting.

## Commands

```bash
keryx wiki status
keryx wiki new <type> <slug> --title "<title>"
keryx wiki collect
keryx wiki index
keryx wiki check-links
keryx wiki validate
```

## Maintenance

- New pages start at `Version: 0.1.0`; bump `Version` on every edit.
- Run `keryx wiki index` after adding or renaming pages.
- Run `keryx wiki collect` to generate safe draft pages from gdgraph, health, and testing context.
- Run `keryx wiki check-links` before relying on cross-page links.

## Enriching Collected Drafts (the wiki part)

`keryx wiki collect` is deterministic and needs no model: it fills the
`## Reference` section of each page (Public API, Key files, real dependencies)
from the graph and source. The `## Overview`, `## How it works`,
`## Key concepts`, and `## Main flows` sections are left as `Draft -`
placeholders. Those are the actual wiki - the understanding the graph cannot
express - and they are filled by **this skill**, not by the CLI.

### Model policy - use a cheap model

This is **bounded, mechanical synthesis**: read a module's key files and write
structured prose into fixed sections. It is NOT deep reasoning. Run it on a
**non-flagship / cheap model** (e.g. Haiku, or Sonnet at most) - do not spend a
flagship model on it. If you orchestrate, dispatch **one subagent per page on
the cheap model**; the flagship's job is only to review a sample at the end.

### Work-front

The scaffold is graph-driven and covers the WHOLE project — a page per module at
every nesting depth (`src/pipelines`, `src/pipelines/store`,
`src/pipelines/features/pipeline-variables`, …), so there can be many draft
pages. Do NOT try to enrich all at once — work in priority batches, incrementally.

### Procedure

0. Prepare (deterministic, do this yourself — no subagents):
   ```bash
   keryx gdgraph build     # fresh symbols + cross-file links (feeds Public API)
   keryx wiki collect      # full scaffold; read its final line:
                           #   "enrichment needed: N component page(s) still Status: draft"
   keryx wiki index
   ```
   That `enrichment needed` count is your work-front. On later commits,
   `keryx wiki collect --changed --since HEAD~1` re-scaffolds only the modules
   whose graph shape moved — enrich exactly those.
1. List + order the drafts to enrich:
   ```bash
   grep -rl "Status: draft" .metaproject/wiki/components .metaproject/wiki/architecture
   ```
   Order by importance - most-depended-on modules first (they anchor the Project
   Map). Use the page's `Reference` -> `Depended on by`. Take a batch (e.g. 20);
   leave the rest for the next pass.
2. For each draft page, read the files listed under `Reference` -> `Key files`
   (they are the highest-connectivity files, i.e. the module's core). Read a few
   more if needed. Do NOT read the whole module.
3. Fill the prose sections from what you read:
   - `## Overview` - 2-4 sentences: what the module owns and its purpose.
   - `## How it works` - the internal architecture: layers, key abstractions,
     how they relate. Explain the design, do not re-list files.
   - `## Key concepts` - the domain vocabulary and core objects.
   - `## Main flows` - trace 1-3 concrete flows through the key files.
4. Leave the `## Reference` section untouched (it is graph-owned and
   regenerated). Update `## Summary` if the overview sharpened it.
5. Set `Status: accepted` and bump `Version` (e.g. to `1.0.0`). This marks the
   page human-owned; `keryx wiki collect --force` will never overwrite it.
6. Ground every claim in code you read - write "appears to" rather than
   inventing. When you link related pages, link ONLY to pages that ACTUALLY
   exist - never guess a slug. Verify the target first
   (`ls .metaproject/wiki/components` or the wiki index); a module's page slug
   is its path slugified (`src/lineage` -> `src-lineage.md`, NOT
   `lineage-graph.md`). Do not invent `Related Wiki` entries or link to
   non-wiki files (e.g. `CLAUDE.md`). The graph-derived `## Reference` /
   `Related Code` links are already correct - reuse those. Broken links from
   guessed slugs are the #1 enrichment defect; run `keryx wiki check-links` and
   fix any you introduced.
7. As orchestrator you do NOT read code or write prose yourself — only subagents
   do (one per page, cheap model). When the batch is done, review a sample
   (prose accurate, real symbol names, `## Reference` untouched), then run
   `keryx wiki index` and `keryx wiki check-links`. Report: pages enriched,
   pages still draft, next batch.

`--force` regenerates only unmodified drafts, so collect and enrich compose:
re-run collect after code changes, then enrich the newly created drafts.

## Always-on orientation (optional)

To make wiki knowledge always available (not just when the agent remembers to
read the index), install the orientation injector — it adds the wiki index +
code-graph map to the agent's context each turn:

```bash
keryx orient install-hook [--runtime <id|all>]   # claude, codex, cursor
keryx wiki context                               # the wiki half of that orientation
```

## Skip When

- The request is a pure code lookup with no architectural/domain/business context. Skipping the wiki is fine here — but it does not license raw `rg`: the code lookup itself still goes through gdgraph and `keryx ctx rg` (see the gdgraph and gdctx skills).
- `keryx wiki` is unavailable.

## Reporting

When wiki context is used, mention which pages were read. For non-trivial tasks, record `wiki_used: pages / not-relevant / unavailable` as part of the routing audit (see the gdgraph skill's Reporting section).
