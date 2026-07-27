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
gd-metapro wiki status
gd-metapro wiki new <type> <slug> --title "<title>"
gd-metapro wiki collect
gd-metapro wiki index
gd-metapro wiki check-links
gd-metapro wiki validate
```

## Maintenance

- New pages start at `Version: 0.1.0`; bump `Version` on every edit.
- Run `gd-metapro wiki index` after adding or renaming pages.
- Run `gd-metapro wiki collect` to generate safe draft pages from gdgraph, health, and testing context.
- Run `gd-metapro wiki check-links` before relying on cross-page links.

## Skip When

- The request is a pure code lookup with no architectural/domain/business context.
- `gd-metapro wiki` is unavailable.

## Reporting

When wiki context is used, mention which pages were read.
