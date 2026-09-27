# Project Rules

This directory holds two different kinds of rule files. Do not treat them the same way.

## Imported entrypoint rules (this directory)

The `.md` files here (e.g. `agents-md.md`, `claude-md.md`) are repository-level instructions
imported from root agent entrypoints such as `AGENTS.md` or `CLAUDE.md`.

- treat files here as high-priority agent-readable mirrors of root instructions;
- update the root entrypoint first when changing project-wide instructions;
- rerun `keryx rules sync`, `keryx init`, or `keryx update` to resync imported rule files.

## Core rule library (`core/*.mdc`)

`core/*.mdc` is an on-demand rule library, not something loaded automatically. A rule file is
read only when a skill or `routing.md` cites it by path.

- `alwaysApply` and `globs` in each rule's frontmatter are Cursor-format metadata for Cursor's
  own auto-attach behavior; keryx itself does not read or act on either field;
- a stack-specific rule (e.g. `nestjs-dto.mdc`, `mobx-store-template.mdc`) declares the stack(s)
  it applies to via a `stack_requires` frontmatter key, using the same tag vocabulary as a
  skill's `metadata.stack_requires`; it is only relevant to projects on that stack;
- the bundled tree (`src/gdskills/bundled/rules/core/`) is the source of truth — `core/` here is
  an installed mirror, and `keryx init`/`keryx update` overwrite it wholesale on install;
  a rule retired from the bundled tree is removed from here too when it is an unmodified shipped
  copy; otherwise it is kept (with a warning that says why — edited, not a regular file, oversized,
  or unreadable/unremovable), since discarding it silently could lose your changes or hide a
  filesystem problem.
