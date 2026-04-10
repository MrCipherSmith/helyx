# Job Report: Security Hardening

**Job:** security-hardening  
**Date:** 2026-04-10  
**Status:** ✅ Completed  
**Commit:** `e343bc4`  
**Duration:** ~15 min (3 parallel agents + direct fixes)

---

## What Was Done

### Execution Plan
3 agents launched in parallel, each owning non-overlapping files:
- **Agent 1** → `utils/files.ts` (path traversal)
- **Agent 2** → `mcp/server.ts` (3 fixes: isLocalRequest + transcript_path + startup check)
- **Agent 3** → `mcp/dashboard-api.ts` + `docker-compose.yml` + `.env.example`

All 3 agents were denied Edit/Bash tools in their sandboxed context. Fixes were applied directly by the orchestrator.

---

## Fixes Applied

| Severity | Issue | File | Fix |
|----------|-------|------|-----|
| CRITICAL | Path traversal via `doc.file_name` | `utils/files.ts` | `basename()` + regex sanitize |
| HIGH | Webhook without secret accepted all POSTs | `mcp/server.ts` | `process.exit(1)` on startup if missing |
| HIGH | `isLocalRequest` trusted all RFC 1918 | `mcp/server.ts` | Narrowed to 127.x + 172.17.x only |
| HIGH | `transcript_path` unvalidated in Stop hook | `mcp/server.ts` | `isAllowedTranscriptPath()` — allows /home, /root, /tmp |
| MEDIUM | Port 3847 exposed on 0.0.0.0 | `docker-compose.yml` | Bound to `127.0.0.1` |
| MEDIUM | `ref` param unsanitized in git API | `mcp/dashboard-api.ts` | Regex validation, fallback to HEAD |
| MEDIUM | Env example missing secret doc | `.env.example` | Documented as REQUIRED |

---

## Verification

```
bun test tests/unit/  →  77 pass, 0 fail
docker compose build bot  →  Image claude-bot-bot Built
curl http://localhost:3847/health  →  {"status":"ok","db":"connected","uptime":9}
```

---

## What Was NOT Changed
- Access control middleware (`bot/access.ts`) — already correct
- JWT auth on dashboard — already correct
- Telegram user allowlist — unchanged
- Database — no migrations needed
- MCP auth flow — unchanged

---

## Remaining Security Recommendations (not in scope of this job)
- Add integration tests for the path traversal fix (send malicious filename, verify landing path)
- Consider rotating `TELEGRAM_WEBHOOK_SECRET` periodically
- Add rate limiting on `/api/*` endpoints (currently none beyond Docker network trust)
