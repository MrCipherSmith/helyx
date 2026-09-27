# gdskills

## Purpose

Native bundled Metaproject working skills and orchestrators.

## Install Profile

`recommended`

## Installed Skills

### core

- `context-router`: Choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.
- `entity-skill-creator`: Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.
- `entity-skill-learner`: Update project-skills from review findings, test failures, health reports, memory entries, and verifier reports.
- `entity-skill-router`: Select relevant project-skills for known modules, components, stores, services, and domain entities.
- `entity-skill-verifier`: Run `keryx skills verify` to check a project-skill's required files, SKILL.md metadata, manifest registration, target-path existence, and evidence artifacts (gdgraph, gdctx, validated gdwiki, Code Health, canonical accepted memory), then classify it as fresh, needs-review, stale, or blocked. The command does not read the skill's prose or compare it against current code — that comparison is a manual agent step.
- `metaproject-router`: Choose which Metaproject module, working skill, or project-skill should be used for a user request.
- `reviewer-skill-creator`: Create a project-local reviewer for review-orchestrator from a rules file, review profile, or written team standard.

### orchestration

- `code-verifier`: Run and summarize verification gates: typecheck, lint, tests, build, imports, and changed-scope checks.
- `context-collector`: Build compact task context from graph, ctx, wiki, memory, health, project-skills, and selected files.
- `feature-analyzer`: Analyze a feature, module, branch, or migration area and produce an implementation map.
- `flow-orchestrator`: Run Task Manager-backed implementation flows through keryx flow state, frozen acceptance criteria, an explicit completion choice, review, and Code Health.
- `issue-analyzer`: Convert GitHub or local issues into atomic implementation tasks with acceptance criteria.
- `job-documenter`: Create and maintain persistent job documentation for orchestrated analysis, implementation, and review work.
- `job-orchestrator`: Run full task pipelines: clarify, collect context, plan, implement, verify, review, and summarize.
- `task-implementer`: Implement one atomic task end to end using local project context and verification.

### planning

- `brainstorm`: Explore architecture, product, or implementation options with trade-offs and recommendation.
- `docpack-orchestrator`: Create or update Metaproject requirements packages under docs/requirements with PRD, specification, README, optional protocols/schemas, verification, review, and roadmap updates. Use autodoc-orchestrator instead for reverse-engineering current codebase documentation.
- `docpack-review`: Review Metaproject requirements packages for completeness, versioning, consistency, schema references, roadmap updates, and unsupported implementation claims.
- `interview`: Clarify implementation ambiguities after context is collected and the goal is known (job-orchestrator 0.3, implement intent); to scope the request itself, use interviewer.
- `interviewer`: Scope a vague or expensive request before any context is collected (job-orchestrator 0.1.5, custom intent); for implementation specifics after context exists, use interview.
- `prd-creator`: Convert vague requests into structured PRD and acceptance criteria.

### platform

- `agent-entrypoint-distiller`: Split large AGENTS.md/CLAUDE.md files into high-priority Metaproject rules and project-specific skills.
- `agent-entrypoint-manager`: Maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.
- `hook-manager`: Create and verify lightweight git hooks for graph, health, and skill verification.
- `skill-catalog-manager`: Generate `.metaproject/skills/catalog.md` and machine-readable skill registry.

### quality

- `api-truth`: Write dependency calls against the version installed here, and mark the ones that went out unchecked.
- `deprecation-path`: Retire a spelling this project publishes without breaking the callers nobody can enumerate.
- `fresh-eyes`: Doubt work still in flight from a reader who was never told why it works.
- `metaproject-security`: Check Metaproject Security policies for prompts, external content, memory/wiki/report writes, PII, secrets, prompt injection, and data exfiltration.
- `perf-check`: Run or summarize performance, bundle, and complexity checks.
- `pr-issue-documenter`: Create PR descriptions and linked issue documentation from branch changes.
- `root-cause`: Find the mechanism behind a reported defect, repair it, and leave a guard that fails without the repair.
- `security-audit`: Run dependency and secret/security checks and normalize findings.
- `test-gen`: Generate tests for a file or module using local patterns and existing test stack.
- `tests-creator`: Create test scenarios before implementation from acceptance criteria and project patterns.

### review

- `review-architecture`: Review boundaries, dependency direction, layering, and abstraction stability.
- `review-backend`: Review backend services, API contracts, DTOs, validation, persistence, and integration boundaries.
- `review-clean-code`: Review function and class maintainability, SOLID issues, cohesion, naming, and complexity.
- `review-core-boundaries`: Review shared/core module coupling, public API stability, and dependency minimization.
- `review-flow-graph`: Review graph or flow UI abstractions, graph surfaces, layout lifecycle, and large-graph behavior.
- `review-frontend`: Review frontend components, state boundaries, rendering behavior, and UI integration patterns.
- `review-frontend-conventions`: Review frontend code against repository-local frontend conventions and agent entrypoints.
- `review-highload`: Review concurrency, retries, queues, idempotency, resource pools, and high-traffic risks.
- `review-layout`: Review rendered layout: flex/grid sizing, collapse and overflow, box model, logical properties and RTL, and locale-driven geometry.
- `review-logic`: Review logic correctness, contracts, edge cases, nullability, and async behavior.
- `review-orchestrator`: Route review requests to specialized reviewers and consolidate findings.
- `review-performance`: Review hot paths, unnecessary work, bundle/perf regressions, blocking operations, and memory risk.
- `review-regression`: Review the blast radius of a change — the code it can break — rather than the change itself. Scope B of a deep round.
- `review-security-code`: Review code-level security risks, injections, authorization gaps, unsafe secrets, and data exposure.
- `review-style`: Review naming, readability, duplication, dead code, and maintainability.
- `review-testing-practices`: Review test structure, coverage quality, determinism, and repository test conventions.
- `review-verifier`: Verify reported findings by executing a check that fails if the finding is real; delete-only.

## Commands

- `keryx skills status`
- `keryx skills catalog --profile recommended`
- `keryx skills install --profile recommended`

## Storage

- `skills/gdskills/` - installed working skills.
- `project-skills/` - generated entity/project skills.
- `data/gdskills/` - reports, proposals, and artifacts.
