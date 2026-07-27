# Testing Core

Local Testing Module service layer installed by `gd-metapro init`.

Responsibilities:

- detect test stack, scripts, configs, CI and test files;
- write reusable testing context under `.metaproject/data/testing`;
- run tests through the existing project runner;
- normalize results into JSON/Markdown artifacts;
- expose agent commands under `gd-metapro test`.
