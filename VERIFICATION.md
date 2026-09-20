# Verification record

Fixture: **deploy-test-hono** (Hono + `@hono/node-server` Node adapter +
`better-sqlite3`).

## Command

```bash
bash scripts/verify.sh
```

## Environment

| Component | Version |
|-----------|---------|
| Node.js   | v22.23.2 |
| npm       | 10.9.8 |
| Hono      | 4.13.8 |
| @hono/node-server | 2.1.1 |
| better-sqlite3 | 13.0.3 |
| SQLite    | via `better-sqlite3` |

## Steps and outcome (exit 0 = all passed)

1. `scripts/build.sh` — writes `VERSION` release marker and compiles `dist/`
   via `tsc`: **passed**.
2. Clean install — `rm -rf node_modules && npm ci` (frozen lockfile): **passed**.
3. Strict typecheck — `tsc --noEmit`: **passed**.
4. Client JavaScript syntax check — `node --check public/app.js`: **passed**.
5. Unit/integration suite — `node --test "dist/tests/*.test.js"`:
   **35 tests, 0 failed** (CRUD, search/filter, LIKE-wildcard escaping,
   validation negatives, seed/schema idempotency, restart persistence,
   database-unavailable readiness).
6. Production smoke — `scripts/smoke.sh` against the real process
   `node dist/src/index.js`: **50 checks, 0 failed**, including:
   - liveness/readiness, release marker, static UI + assets;
   - project/task CRUD over HTTP, read-back, delete;
   - search and status/priority filters;
   - negative/validation cases (400) and not-found (404);
   - sqlite file written to disk;
   - persistence survivor survives graceful stop → restart on the **same**
     SQLite path with stable counts;
   - database-unavailable readiness: `503` with `status: "unavailable"`
     while liveness stays `200` and static UI keeps serving.

## Notes

- `VERSION` resolves to the git short SHA once committed; the builds above
  ran before the git commit and used the UTC-date fallback marker.
- No live platform/deployment qualification was performed; this is local
  production verification only.