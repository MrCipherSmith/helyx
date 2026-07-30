# flow-complete Skill

Finish a flow whose status is `implemented`.

## Workflow

1. Re-verify the package: description matches the result; plan followed or
   deviations journaled; all tasks done.
2. Confirm every acceptance criterion after actually checking it:
   `keryx flow ac confirm <id> ACn --note "<evidence>"`.
3. Run `keryx flow complete <id>`. Gates: AC confirmed + checksum intact;
   draft PR exists with green checks; code-health gate passes.
4. Gates fail -> flow auto-returns to in-progress with fix notes:
   - small fixes: run a fix agent, then re-run from step 2;
   - large fixes: describe what is wrong in the journal and relaunch the
     implementor/orchestrator against the updated plan.
5. Gates pass -> flow is done:
   - source was an issue: `keryx flow complete <id> --comment` posts a
     short, factual summary comment to the issue;
   - no issue: ask the user whether to create a ticket for the record.
