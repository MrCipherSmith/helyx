# Shared: Git Scope Detection

## Purpose
Reusable bash script for determining the review scope (merge-base) for review skills.
Used by: code-ai-review, code-boss-review, code-mobx-store-review, code-style-review.

## Script

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || true)"

PARENT=""
if git rev-parse --verify -q "origin/main" >/dev/null; then
  PARENT="origin/main"
elif git rev-parse --verify -q "origin/master" >/dev/null; then
  PARENT="origin/master"
elif git rev-parse --verify -q "main" >/dev/null; then
  PARENT="main"
elif git rev-parse --verify -q "master" >/dev/null; then
  PARENT="master"
elif [ -n "$UPSTREAM_REF" ] && [ "$UPSTREAM_REF" != "$BRANCH" ] && [ "$UPSTREAM_REF" != "origin/$BRANCH" ]; then
  PARENT="@{upstream}"
else
  echo "Cannot determine parent ref" >&2
  exit 1
fi

BASE_SHA="$(git merge-base HEAD "$PARENT")"
```

## Usage
Copy-paste or reference this script at the start of any review skill's scope detection phase.
