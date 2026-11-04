# Implementation Log

Each phase records what was built, what was verified, what failed and what remains.

## Phase 1: Commerce application (2026-11-03)

**Status:** complete, awaiting approval to start Phase 2.

### Built

- **API (`apps/api`):** FastAPI with 34 operations across 26 paths, covering auth, users and roles,
  customers, products, warehouses, inventory, orders, status changes, CSV export, simulated payments,
  audit log, dashboard, health and readiness. All errors share one JSON envelope.
- **Database:** PostgreSQL 17 with SQLAlchemy 2 and one Alembic migration. Check constraints enforce
  non-negative stock, totals that add up, and valid statuses.
- **Seed:** deterministic data with 5 customers, 5 users, 4 warehouses, 24 products and 60 orders.
- **Web (`apps/web`):** React, TypeScript strict mode and Vite, with types generated from the OpenAPI spec.
- **Scripts:** setup, local PostgreSQL control, dev runner, OpenAPI export.

### Decisions

- **Server-side sessions, not JWTs,** so logout and privilege changes take effect immediately. The
  cookie is HttpOnly and SameSite=Lax, and cross-site writes are also rejected by an Origin check.
- **A customer-scoped Viewer** was added beyond the three required roles' base behaviour. It gives
  Phase 3 real IDOR behaviour to test. Other customers' records return 404, not 403.
- **Declined and timed-out payments return 201** with a status field. They are recorded business
  outcomes, not request errors. Replays return 200 with `Idempotency-Replayed: true`.
- **Idempotency keys are scoped per user,** so one user's key can never replay another user's payment.
- **Project-local PostgreSQL from `embedded-postgres`.** See the environment notes below.

### Environment

- **Docker is not installed** on this machine. No Docker work was attempted in this phase.
- **Homebrew could not install PostgreSQL:** it fails with `unknown or unsupported macOS version` on
  this pre-release macOS 27. No system packages were installed.
- **PostgreSQL 17.11 runs from the `embedded-postgres` npm package.** Unix sockets are disabled because
  long paths exceed the socket length limit, which made the server fail to start during evaluation.

### Verified

Results are in [TEST_RESULTS.md](TEST_RESULTS.md).

| Acceptance criterion | Evidence |
| --- | --- |
| Application starts locally | `npm run setup` and `npm run dev` from a clean copy; readiness returned `ready` through the web proxy |
| Frontend uses the real backend | Browser check through the Vite proxy, with results confirmed in PostgreSQL |
| PostgreSQL persists data | Same order count and order total after a server restart |
| Auth and authorization work | 29 auth and user tests; browser checks for each role; a direct Viewer write returned 403 |
| Order can be created in the UI | Two-line order created in the browser check |
| Totals match the database | UI, API, CSV and PostgreSQL agreed: 65472 cents |
| CSV export works | Downloaded in the browser and compared; 7 backend tests |
| Invalid requests get meaningful errors | Envelope asserted across the suite, including field names and no leaked internals |
| Backend tests pass | 161 passed, 0 failed, 0 skipped |

### Failures found and fixed

Application defects, fixed in the application:

1. **Timestamps depended on the server's time zone.** A replayed payment returned `-05:00` where the
   original returned `Z`. Found by the idempotency replay test. Connections now use UTC.
2. **Unhandled errors lost `X-Request-ID`,** because that handler runs outside the middleware. Found by
   the rollback test. The header is now set when the error response is built.
3. **The orders filter could discard what the user just typed.** React Router commits URL changes as
   low-priority transitions, so `Clear` could land after new input and the resync effect blanked it.
   Found by the browser check. The effect now ignores URL changes the form made itself.
4. **Closing a modal lost keyboard focus,** because React had already removed the dialog when cleanup
   ran. Found by the browser check. Focus is now returned to the opening element explicitly.
5. **Form errors stayed visible after the field was fixed.** All automated checks passed; this was found
   by looking at screenshots. Errors are now derived from current values after the first submit.
6. **Smaller issues found in screenshots:** lowercase history labels, unbounded toast stacking that hid
   content, misaligned filter labels, and order numbers wrapping at phone width.
7. **`scripts/dev.sh` used `wait -n`,** which macOS's stock Bash 3.2 lacks. Found by review before it ran.
8. **Seed reset left stale objects in the session,** causing SQLAlchemy warnings.

Test and script mistakes, where the application was correct:

- A concurrency test compared against an ORM object that had refreshed itself. It now captures the
  version up front, with an equally strict assertion.
- The browser script expected the dashboard after login, but the app correctly returned to the
  originally requested page. The script now asserts that behaviour.
- Three browser script locators were wrong: two text matches were too loose, and one SKU was on page 2.

No assertion was weakened to make a test pass.

### Remains

- Phases 2 to 7. Nothing from them has been started.
- Directories in the target layout that belong to later phases have deliberately not been created.
- Nothing has been committed or pushed. The git repository is initialized with no commits.
