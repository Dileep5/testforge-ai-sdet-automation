# Implementation Log

Each phase records what was built, what was verified, what failed and what remains.

## Phase 1: Commerce application (2026-11-03)

**Status:** complete and approved. Committed locally as `e0a5a40`.

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

- Phases 2 to 7 were not started in this phase.

## Phase 2: Playwright framework (2026-11-03)

**Status:** complete except Firefox, which could not run on this machine. Awaiting review. Phase 3 has
not been started. Nothing has been pushed, and Phase 2's changes are not yet committed.

### Built

- **Framework (`framework/`):** Playwright with strict TypeScript. Page objects for every screen; grid,
  modal, toast and navigation components; typed role fixtures; a typed API client generated from the
  OpenAPI spec; deterministic factories with tracked cleanup; a read-only database helper.
- **Tests (`tests/e2e/`):** 56 browser tests per browser, plus 6 browserless framework checks.
- **Dedicated environment:** a `testforge_e2e` database and separate ports, against the production build.
- **Tooling:** ESLint with type-aware rules and Playwright rules that ban hard waits and forced clicks.
  HTML, JUnit and JSON reports. Traces, screenshots and video kept for failures.

Design is explained in [ARCHITECTURE.md](ARCHITECTURE.md). Results are in [TEST_RESULTS.md](TEST_RESULTS.md).

### Application changes

- **Added `POST /customers` (Admin only),** with 3 backend tests. Without it, tests could not create
  their own customers and would have had to share seeded ones.
- **Added `ConcurrencyLimitMiddleware`,** to fix bug 1 below.
- **Disabled router transitions and made filter state updates functional,** to fix bugs 2 and 3.
- **The order form now loads every page of stock,** to fix bug 4.

### Real bugs found

1. **The API froze completely under a burst of concurrent requests. (Severe)** Requests held a database
   connection while waiting for a worker thread, and threads waited for a connection, so nothing could
   proceed until the 30 second pool timeout. Found when a test creating many products made unrelated
   calls time out across the suite; `pg_stat_activity` showed 30 connections `idle in transaction`.
   Backend tests could not see it, because the in-process client does not create that concurrency.
   Admission is now limited to the number of connections. A regression test runs a burst of 300 against
   a real server: all 300 timed out without the fix, and all returned 200 with it.
2. **URL-driven controls snapped back after being used.** Router updates ran as low-priority transitions,
   so a checkbox or select reverted until the transition committed. Found by Playwright reporting that
   clicking a checkbox did not change its state. This was also the root cause of the Phase 1 filter race.
3. **A stale closure could restore old filter values.** Filter changes spread a previous copy of the
   form's state, so input arriving before the next render brought back a value just cleared. Found by the
   filter race test.
4. **The order form silently hid products beyond the first 100 stock rows.** Recorded as a limitation in
   Phase 1. Fixed because parallel tests routinely exceed that many rows.

### Test and framework mistakes found

- **A regression test that could not fail.** The first burst test passed with the fix removed, because
  its requests were not truly simultaneous. It was rewritten until it reproduced the freeze.
- **A filter race test that could not fail.** In a production build, ordinary typing never hits the race.
  It now places input in the same browser task as Clear, and fails when the bug is put back.
- **A weak tax test.** Its values never reached a rounding boundary, so truncating passed too. It now uses
  a value where the two differ.
- **A real isolation bug.** The CSV test used a fixed customer name, so it selected another test's customer
  under parallel repeats. A single pass did not show this; `--repeat-each=3` did. Names are now namespaced.
- **Login sent extra fields.** The fixture posted the whole created-user object, and the API's strict
  validation rejected it. This failed 7 tests on the first run.
- **Mutation script errors.** Two mutations broke the build or the Python, so no tests ran and they showed
  `0/0`. Those were not treated as results; they were corrected and rerun.

### Flakiness

No test needed a retry to pass in the final runs, and retries were off for all of them. The failures seen
during development all had root causes above, and each was fixed at its cause.

### Environment

- **Firefox:** see [TEST_RESULTS.md](TEST_RESULTS.md#firefox). The cause is not established. Launching it
  outside the agent's shell sandbox was attempted once and denied by the permission system, and that was
  not retried.
- **Docker:** still not installed.
- **Dev database:** confirmed untouched after all runs, with 60 seeded orders and no test data.

### Remains

- Confirm or rule out Firefox from an ordinary terminal.
- Phases 3 to 7.
