# Test Results

Only results from commands that were actually run are recorded here.

**Last updated:** 2026-11-03, Phase 1. **Environment:** macOS 27 (arm64), Python 3.13.5, Node 24.3.0,
PostgreSQL 17.11.

## Summary

| Check | Result |
| --- | --- |
| Backend tests (pytest, real PostgreSQL) | **161 passed, 0 failed, 0 skipped** |
| Backend line coverage (`app/`) | 97% (33 of 1246 lines missed) |
| Ruff lint and format | Passed |
| Frontend type check (strict) and production build | Passed |
| One-off browser check, Chromium only | 41 of 41 passed (see below) |
| `pip-audit` on `requirements.lock` | No known vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` including dev dependencies | 3 moderate, 1 underlying issue (see limitations) |

**Not done yet, so no results exist:** Playwright framework tests, Firefox and WebKit, API tests in
Playwright, contract tests, axe accessibility scans, k6 load tests, AI evaluation, Docker, GitHub
Actions, secret scanning.

## Backend tests

161 test cases come from 131 test functions. Three functions are parametrized and supply 33 cases,
20 of which cover every disallowed order status transition, so the raw count overstates the number
of distinct scenarios.

| File | Cases | Covers |
| --- | --- | --- |
| `test_auth.py` | 14 | Login, cookie flags, hashed tokens, logout replay, expiry, cross-site writes |
| `test_users.py` | 15 | Admin-only access, session revocation on privilege change, input rejection |
| `test_catalog.py` | 19 | Search, filter, sort, pagination, validation, soft delete, warehouses, customers |
| `test_inventory.py` | 9 | Authorization, validation, audit, version conflicts, concurrent updates |
| `test_orders.py` | 20 | Totals against the database, rollback, overselling races, deadlock, filters, buyer scope |
| `test_order_status.py` | 28 | Full lifecycle, every disallowed transition, payment gates, cancel restores stock |
| `test_payments.py` | 17 | Each outcome, idempotent replay, key reuse, concurrent duplicates, settlement |
| `test_export.py` | 7 | CSV against the database, filters, scope, formula neutralising, quoting |
| `test_money.py` | 14 | Tax rounding and integer arithmetic |
| `test_platform.py` | 18 | Health, error envelope, no leaked internals, DB constraints, migrations, seed, OpenAPI |

Stability: the suite passed on three consecutive runs and under `TZ=Asia/Tokyo`, then again from a
clean copy. That is a small sample, not proof that no flakiness exists.

## Browser check

A throwaway script drove the running app in headless Chromium and compared results with PostgreSQL.
It is **not in this repository** and is not the Phase 2 framework; it exists only as evidence for the
Phase 1 acceptance criteria. Formal, repeatable UI tests arrive in Phase 2.

Example from the run: a two-line order at the Toronto warehouse showed $579.40 + $75.32 = $654.72, and
PostgreSQL held 57940 + 7532 = 65472 cents. The CSV export contained the same 65472 and 654.72.

## Other verified behaviour

- **Clean copy:** only git-trackable files were copied to a new directory. `npm run setup`, lint, tests,
  type check, build and `npm run dev` all worked there, and `npm run dev` left no listeners after stopping.
- **Persistence:** order count and a specific order's total were unchanged after stopping and restarting
  PostgreSQL.
- **Spec drift:** regenerating the OpenAPI spec and frontend types produced no differences.

## Known limitations

- **No login rate limiting or lockout.** Failed logins are audited but not throttled.
- **No refunds.** A settled order cannot be cancelled; the API rejects it with `REFUND_NOT_SUPPORTED`.
- **No frontend automated tests or linting yet.** Both are planned for Phase 2. The browser check above
  is not repeatable from this repository.
- **Dev-dependency audit finding.** `npm audit` reports a moderate `minimatch` DoS via
  `openapi-typescript`, a build-time tool that only reads this project's own spec. npm's suggested fix
  downgrades a major version, and a scoped override did not clear the finding, so it is accepted for now.
- **`embedded-postgres` carries a `-beta` version tag**, though it wraps a PostgreSQL 17.11 release.
  It is for local development only. Its Linux and Intel paths in `scripts/db-local.sh` are untested.
- **Tax is simplified.** One rate per warehouse; Quebec is rounded to 14.98%. Not for real tax use.
- **CSV export is built in memory** with no row cap.
- **New order product list** loads at most 100 inventory rows per warehouse. The seed has 24 products.
- **Product and inventory search boxes** do not resync when using the browser's back button. Their
  results do. The orders filter form does resync.
- **Customer-scoped buyers** can see all stock levels, and staff names in their own orders' history.
  This is a design choice for the demo and might not suit a real deployment.
- **Sessions have an absolute lifetime** (8 hours by default) and do not extend with activity.
