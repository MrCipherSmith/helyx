# Metaproject Hooks

Hooks are local project scripts executed by selected `keryx` lifecycle commands.

Git hooks are installed as marked managed blocks:

```sh
# keryx:<hook-id>:begin
...
# keryx:<hook-id>:end
```

`keryx update --hooks` replaces only those managed blocks. Existing user
content, Husky wrappers, Lefthook dispatchers, lint-staged calls, and other
project-owned hook lines are preserved.

## git post-commit gdgraph hook

When enabled during `keryx init`, the Git `post-commit` hook detects commits that touched files relevant to the graph and prints the explicit refresh command.

Purpose:

- prevent stale graph usage by surfacing the refresh command close to the commit;
- avoid broad raw file search when graph context is stale;
- avoid mutating versioned `.metaproject` artifacts after the commit is already written.

## git post-commit gdskills hook

When enabled during `keryx init`, the Git `post-commit` hook runs lightweight project-skill verification after relevant project or Metaproject context changes.

Purpose:

- keep generated project-skills from silently drifting after code/wiki/rule changes;
- run non-mutating dry-run verification and report failures without changing files;
- write verification reports only during explicit `keryx skills verify` runs or orchestrator-controlled checks;
- keep the hook local, optional and non-blocking.

## git post-commit health hook

When enabled during `keryx init`, the Git `post-commit` hook detects relevant source/config changes and prints the explicit Code Health refresh command.

Purpose:

- keep Code Health refresh visible close to the commit that may affect it;
- avoid writing health reports after commit, which leaves the worktree dirty;
- avoid heavy sources in hooks: tests, audit, coverage and external providers stay manual or orchestrator-controlled.

## git post-commit testing hook

When enabled during `keryx init`, the Git `post-commit` hook detects relevant source, test, config or documentation changes and prints the explicit testing refresh command.

Purpose:

- keep test-context staleness visible without mutating versioned files after commit;
- stay non-blocking and avoid running analyzers or heavy suites on every commit;
- give agents fresh context before test generation or debugging.

## git post-commit dashboard hook

When any Metaproject post-commit hook is enabled, a lightweight dashboard hook reminds the user to rebuild the dashboard after Metaproject-facing changes.

Purpose:

- keep `.metaproject/index.md` and `.metaproject/keryx-dashboard.html` aligned through explicit `keryx update` or `keryx dashboard build`;
- recover missing `.metaproject/metaproject.json` for older initialized projects;
- avoid mutating service files after commit, especially from stale global CLI installations.

## git pre-push testing hook

When enabled during `keryx init`, the Git `pre-push` hook runs changed-scope tests and blocks the push on failure.

Purpose:

- catch focused test failures before remote publication;
- use Testing Module related-test selection instead of always running the whole suite;
- keep blocking behavior explicit and opt-in.

## post-update.d

Executable files in `post-update.d/` run only when `keryx update --hooks` is requested.

Rules:

- keep hooks idempotent;
- keep hooks project-local;
- do not require network access unless the hook clearly documents it;
- use generated data under `.metaproject/data` for outputs.
