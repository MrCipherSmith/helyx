# security Core

Local Metaproject Security service layer.

Responsibilities:

- run rules + entropy + PII + injection/egress detectors over content;
- resolve the most restrictive action per span and compute the gate
  (`block > require-approval > redact > warn > allow`);
- redact with fixed-width, length-hiding masks and safe previews;
- keep HMAC-keyed hashes local-only (`data/security/raw/`), never plain digests
  and never in committable artifacts;
- verify `configChecksum` and record incidents on tamper or mode downgrade.

The service is an in-process library seam (`createSecurityService().check(...)`)
called before side-effecting writes; the CLI is a thin wrapper over it. In
`advisory` mode `check` never throws; in `enforced`/`ci` mode a
`fail`/`needs-approval` decision must stop the write.
