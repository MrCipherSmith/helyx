# Project Rules

This directory stores repository-level instructions imported from root agent entrypoints such as `AGENTS.md` or `CLAUDE.md`.

Rules:

- treat files here as high-priority agent-readable mirrors of root instructions;
- update the root entrypoint first when changing project-wide instructions;
- rerun `gd-metapro rules sync`, `gd-metapro init`, or `gd-metapro update` to resync imported rule files.
