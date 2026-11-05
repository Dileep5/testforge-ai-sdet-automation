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

**Status:** approved with Firefox marked unverified. Committed locally as `76e3a1e`.

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

## Phase 3: API, contract, PostgreSQL and security testing (2026-11-03)

**Status:** approved. Committed locally as `41097b3`. Firefox unverified.

### Built

- **`tests/api`:** typed API automation with `APIRequestContext` across every resource.
- **`tests/contract`, `framework/contract`:** validation against the generated OpenAPI spec with Ajv, including
  closed objects, requests and queries generated from the schema, and a breaking-change detector.
- **`tests/database`:** read-only SQL assertions, using a new SELECT-only PostgreSQL role.
- **`tests/security`:** a spec-driven authorization matrix, IDOR, sessions, injection, identifiers, leakage and
  idempotency abuse.
- **`tests/reliability`, `test_concurrency_limit.py`:** bursts against a real server, plus deterministic
  middleware tests that count admissions and do not depend on timing.
- **`framework/fixtures/api.ts`:** browserless sessions per role. Every response is contract-checked automatically.
- **`TEST_STRATEGY.md`:** new.

Dependencies added: `ajv` 8.20.0 and `ajv-formats` 3.0.1. Backend API changes: `after_id` and `sort=id` on
`GET /inventory`, and `idempotency_key` removed from payment responses.

### Verified

Exact counts are in [TEST_RESULTS.md](TEST_RESULTS.md). Backend 175; Chromium 57; WebKit 57; Firefox 0 of 57 (launch
failure); framework 6; API 147; contract 97; database 44; security 106; reliability 5. All with retries off.

### Failures and how each was resolved

See [TEST_RESULTS.md](TEST_RESULTS.md#bugs-found-in-phase-3). In short: 4 application defects fixed, 7 test
defects fixed, 1 environment limit recorded, and 1 WebKit failure not identified because details were not yet being
kept. A clean-copy run exposed the order form bug, after earlier runs on the working tree had passed.

### Operator notes

- The clean copy was once deleted while its temporary PostgreSQL was still shutting down, so the project's own server
  failed one start attempt. It then started normally, and a content hash confirmed the dev database was unchanged.
- Mutation runs edited source files temporarily. Each was restored from a backup and checked with `git diff`.

### Environment

- **Firefox:** the project configuration is kept and no test is skipped. No further macOS workarounds were attempted.
  It should run on Linux in CI in Phase 6.
- **Docker:** still not installed.
- **Dev database:** row counts and content hashes matched the pre-Phase 3 snapshot, checked twice.

### Remains

- Phase 4 should examine the unbounded request queue and the connection limit under load.
- Firefox on Linux, CI and Docker in Phase 6.
- Phases 4 to 7.

## Phase 4: Accessibility and performance testing (2026-11-04)

**Status:** complete, awaiting review. Not committed. Nothing pushed. Firefox unverified.

### Built

- **`tests/accessibility`:** axe scans of 37 screen states, semantics and focus visibility checks, and keyboard tests in Chromium and WebKit, with a Firefox project ready for CI.
- **`performance/`, `scripts/perf.mjs`:** 7 k6 scenarios, and a runner with a dedicated database, PostgreSQL sampling, CPU calibration, and per-status and per-stage results.
- **`scripts/install-k6.sh`:** pinned k6, checksum verified, because Homebrew refuses macOS 27.
- **Bounded admission:** at most 200 queued requests, then an immediate 503. `MAX_QUEUED_REQUESTS` configures it.
- **Failure diagnostics:** failed browser tests attach console errors, failed requests and execution metadata.
- **`ACCESSIBILITY.md`, `PERFORMANCE.md`:** new.

Dependency added: `@axe-core/playwright` 4.14.0. API changes: 503 is documented on every operation except `/health`, and `/ready`'s 503 can be either of two shapes, recorded as accepted in the breaking-change list.

### Verified

Exact counts are in [TEST_RESULTS.md](TEST_RESULTS.md). Backend 181; Chromium 58; WebKit 58; accessibility 80; keyboard WebKit 32; Firefox 0 of 90 (launch failure); API 147; contract 98; database 44; security 106; reliability 5; framework 6. All with retries off.

### Failures and how each was resolved

10 accessibility defects fixed, 1 reliability change justified by measurement, and 8 test defects fixed. These are listed in [TEST_RESULTS.md](TEST_RESULTS.md#bugs-found-in-phase-4). The WebKit failure reproduced once with full diagnostics and remains **unresolved**.

### Operator notes

- Two sets of k6 runs were discarded, and the reasons are in [PERFORMANCE.md](PERFORMANCE.md#discarded-runs).
- A cleanup of `reports/performance/` was refused by a safety check, and was not attempted another way. Older report folders remain there. They are ignored by git and can be deleted by hand.
- The Phase 3 `/ready` and idempotency entries changed in the accepted breaking-change list: it only holds differences from the current base revision.
- The new database `testforge_perf` was added to the local cluster. The development database was not modified, confirmed by content hash.

### Environment

- **Firefox:** still fails at launch, and no further workaround was attempted.
- **Docker:** still not installed.
- **Machine:** a fanless laptop with variable speed. See [PERFORMANCE.md](PERFORMANCE.md#test-environment).

### Remains

- Manual accessibility review, including a screen reader.
- Firefox on Linux, CI and Docker in Phase 6.
- Phases 5 to 7.

## Phase 5: AI automation and LLM quality engineering (2026-11-04)

Phase 4 was committed locally as `c1e1ce5`. Phase 5 is uncommitted.

### Built

- **`ai/testforge_ai`:** one Python package with an optional OpenAI provider that needs an explicit opt-in.
- **Test generation:** structured stories, an offline template generator, validation, traceability, duplicate and assumption detection, human review, and skeletons that cannot run.
- **Support chatbot:** 31 approved articles, BM25, citations, refusals, guards, a scoped order lookup, `POST /api/v1/support/chat` and a chat page.
- **Evaluation:** 148 rows split evenly into development and held-out, rule-based metrics with denominators and intervals, and an opt-in model-graded check.
- **Failure triage:** parsers for JUnit, Playwright JSON, diagnostics and traces, a rule-based classifier, an optional model opinion, and a corpus of 35 deliberately failing cases plus a real Firefox launch failure.

### Application and framework changes

- One new endpoint and page. The route adds no writes, and existing behaviour did not change. The navigation gains a Support link.
- Failure diagnostics now list pending requests.
- `npm run setup` also installs the AI package.

### Verified

Exact counts are in [TEST_RESULTS.md](TEST_RESULTS.md). Backend 188; AI 305; Chromium 64; WebKit 64; accessibility 82; keyboard WebKit 33; Firefox 0 of 97 (launch failure); API 154; contract 100; PostgreSQL 44; security 114; reliability 5; framework 6. All except Firefox, together: 666 at 4 and at 8 workers, retries off. Also verified from a clean copy. The development database was unchanged, by content hash.

### Results that matter

- Offline chatbot, held-out: 12/23 correct, 8/23 falsely refused, 41/43 refusal recall, 0/8 paraphrases. It scored 23/23 correct on development, so it overfits.
- Triage: 33/36 on held-out, on failures its author deliberately caused.
- Nothing was tuned after the held-out results were seen. One later pattern change left the held-out output hash unchanged.

### Failures and how each was resolved

Listed in [TEST_RESULTS.md](TEST_RESULTS.md#bugs-found-in-phase-5). No defect was found in the existing application.

### Operator notes

- An `OPENAI_API_KEY` is set in the development shell. **It was not used,** and live evaluation was not run, because that needs your opt-in and costs money. The regression run removed it from its environment.
- Real traces contain session cookies and login passwords for the synthetic accounts. They stay under ignored folders. Committed triage fixtures are redacted records, checked for these values.
- Playwright clears `test-results/` on each run, so the Phase 4 WebKit trace, screenshot and video no longer exist.
- k6 and the 3-times accessibility repeat were not rerun. The admission code did not change, but the chat route has not been load tested.

### Remains

- A live model evaluation, when you choose to run one, followed by new held-out questions for any further tuning.
- Firefox on Linux, CI and Docker in Phase 6.
- Phases 6 and 7.

## Phase 6: Docker, CI and quality gates (2026-11-04)

Phase 5 was committed locally as `738ccb1`. Phase 6 was committed as `5b6fcd8`.

At the end of Phase 6 itself, nothing had run on Linux. The CI checkpoint below changed that.

### Built

- **Docker:** images for the API, web app and test runner, an application stack with a named volume, and an isolated test stack. See [DOCKER.md](DOCKER.md).
- **CI:** 14 jobs, plus hand-started stress and WebKit soak workflows, and a policy checker with its own tests. See [CI_CD.md](CI_CD.md).
- **Artifacts:** per-run folders, a fail-closed sanitizer, count gates and pruning.
- **k6:** thresholds for errors, p95, status families and overload behaviour.

### Application changes

- A queued request is refused after `MAX_QUEUE_WAIT_SECONDS`, and dropped if its client disconnects.
- `app.seed --if-empty`, for restarts.

### Verified on macOS only

Exact counts are in [TEST_RESULTS.md](TEST_RESULTS.md). Backend 197; AI 350; Chromium 64; WebKit 64; accessibility 82; keyboard WebKit 33; Firefox 0 of 97 (launch failure); API 154; contract 100; PostgreSQL 44; security 114; reliability 5; framework 6. All except Firefox together: 666, retries off. The CI commands also passed in a fresh copy against a separate empty database. The development database was unchanged, by content hash.

### Failures and how each was resolved

Listed in [TEST_RESULTS.md](TEST_RESULTS.md#bugs-found-in-phase-6). The main one is a keep-alive race that repeated WebKit runs exposed. The Phase 4 WebKit input failure did not recur, and remains unexplained.

### Operator notes

- `.local/tools` now holds actionlint, gitleaks and pip-audit. It is ignored by git.
- `reports/runs` holds raw artifacts, including session cookies and synthetic passwords. It is ignored by git.
- The stale `reports/performance` folders from Phase 4 are still there.

### Remains

- Push, and read the first CI run: this needs your approval.
- Docker verification and Firefox on Linux, through that run.
- Phase 7.

### First CI checkpoint (2026-11-04)

`2ad4bf0`, which disables Dependabot for now, was pushed to the private repository after approval. [The first run](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41883893976) failed on 3 of 14 jobs, and its results are in [TEST_RESULTS.md](TEST_RESULTS.md#first-github-actions-run). Linux Firefox passed for the first time. The fixes are committed locally, and are not pushed.

- `hadolint` had not been run before the push, on the mistaken belief that it had no macOS arm64 build. It has one.

### Second CI checkpoint (2026-11-04)

The 4 approved commits were pushed as `86a8843`. [Run 41893657050](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41893657050) passed 12 of 14 jobs. The suites ran in Docker for the first time, with 643 passed and 20 failed. This found the **first application bug since Phase 4**: payments could not run on plain HTTP away from localhost. The fixes are committed locally, and are not pushed. Details are in [TEST_RESULTS.md](TEST_RESULTS.md#second-github-actions-run).

### Further CI runs (2026-11-04)

[Run 41902669074](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41902669074) was the first fully green run. The first soak attempt failed at startup, because of a number input passed as a string, and the fix was confirmed by [CI run 41910311071](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41910311071) and [soak run 41913178899](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41913178899), which passed 650 of 650.

## Final audit (2026-11-04)

An audit for public release added the MIT `LICENSE` and rewrote the README, and corrected stale documents. Retries now default to 0 everywhere. A bounded, cached browser install was added after one job's slow package mirror nearly used up its time limit, and has not yet run on GitHub.

Further local work added a payment form that recovers from every failure, CI concurrency that keeps every result for `main`, static checks for the repository's scripts, `SECURITY.md`, and a sanitizer self-test workflow. The workflow has not been run.

[Run 41928911349](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41928911349) passed every test it ran, but a slow package mirror stopped the Accessibility job's install at the new 15-minute limit. Flaws in the cache design were then fixed locally, and that version has not run on GitHub.

[Run 41933122691](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41933122691) then passed all 14 jobs, with 772 native and 672 Docker Playwright tests, and filled the shared package cache. [The sanitizer self-test](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41935807067) passed, on a synthetic fixture. Dependabot stays off through public release, by the owner's decision.

[Run 41936962432](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41936962432), with only documentation changed, passed all 14 jobs, and its 4 browser jobs each got an exact hit on the shared package cache.

