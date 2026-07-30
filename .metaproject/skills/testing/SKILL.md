---
name: testing
description: Use before creating, changing, debugging, or reviewing tests. Read testing context and normalized reports before raw test logs.
---

# testing Skill

Use this skill by default for test-related work. The user does not need to
explicitly ask for testing context.

## Workflow

1. Read `.metaproject/data/testing/context.md` before creating or changing tests.
2. Use related-test discovery before broad test search:

```bash
keryx test related <file>
```

3. For focused verification, prefer:

```bash
keryx test run --changed
```

4. Read `.metaproject/data/testing/artifacts/latest.md` before raw logs.
5. Use raw log only when summary and JSON are insufficient.
6. If failures reveal a reusable lesson, feed it to gdskills:

```bash
keryx skills learn --from-test .metaproject/data/testing/artifacts/latest.json --skill <module>/<skill>
```

## Commands

```bash
keryx test analyze
keryx test run
keryx test run --changed
keryx test status
keryx test context
keryx test explain <file-or-scope>
keryx test related <file>
keryx test report latest
```

## Rules

- Do not infer test conventions from one file when testing context exists.
- Do not load raw test logs first.
- Do not install dependencies or create a new test stack unless explicitly requested.
- Treat Testing Module reports as the source for test execution status; Code Health consumes them.
