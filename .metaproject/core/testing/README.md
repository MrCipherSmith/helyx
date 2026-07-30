# Testing Core

Local Testing Module service layer installed by `keryx init`.

Responsibilities:

- detect test stack, scripts, configs, CI and test files;
- write reusable testing context under `.metaproject/data/testing`;
- run tests through the existing project runner;
- normalize results into JSON/Markdown artifacts;
- expose agent commands under `keryx test`.
