# Test Results

Only results from commands that were actually run are recorded here.

**Last updated:** 2026-11-03, Phase 2. **Environment:** macOS 27.0.1 (arm64), Python 3.13.5, Node 24.3.0,
PostgreSQL 17.11, Playwright 1.64.1. Everything ran locally. **CI has not run.**

## Summary

| Check | Result |
| --- | --- |
| Backend tests (pytest, real PostgreSQL) | **166 passed, 0 failed, 0 skipped**, 97% line coverage |
| Playwright Chromium 156 | **56 passed, 0 failed, 0 skipped, 0 flaky** |
| Playwright WebKit 27.2 | **56 passed, 0 failed, 0 skipped, 0 flaky** |
| Playwright Firefox 157 | **Not verified: 56 failed at browser launch, no test body ran** |
| Framework self-checks (no browser) | 6 passed |
| TypeScript strict type check | Passed (frontend and framework) |
| ESLint and Ruff | Passed, 0 warnings |
| Frontend production build | Passed |
| HTML and JUnit reports | Generated (JUnit: 118 tests, 0 failures, 0 errors) |
| Setup from a clean copy | Passed (see below) |
| `pip-audit`, and `npm audit --omit=dev` | No known vulnerabilities |
| `npm audit` including dev tools | 13 moderate (see limitations) |

**Not done yet, so no results exist:** contract tests, axe accessibility scans, k6 load tests, AI
evaluation, Docker, GitHub Actions, secret scanning.

## Playwright by browser

Every run used `E2E_RETRIES=0`, so nothing could pass on a retry.

| Run | Workers | Passed | Failed | Skipped | Flaky | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium | 4 | 56 | 0 | 0 | 0 | 18s |
| WebKit | 4 | 56 | 0 | 0 | 0 | 30s |
| Firefox | 4 | 0 | 56 (launch) | 0 | 0 | 12s |
| Framework + Chromium + WebKit together | 4 | 118 | 0 | 0 | 0 | 49s |
| Smoke, Chromium | 4 | 14 | 0 | 0 | 0 | 9s |
| Critical, Chromium and WebKit | 4 | 62 (31 each) | 0 | 0 | 0 | 28s |

### Parallel and stability runs

| Run | Passed | Failed | Flaky |
| --- | --- | --- | --- |
| Chromium and WebKit, each test 3 times, 4 workers | 336 | 0 | 0 |
| Chromium and WebKit, 8 workers | 112 | 0 | 0 |
| Chromium, 1 worker (serial) | 56 | 0 | 0 |

This is good evidence of stability, not proof that no flakiness exists. The suite has not yet run on
another machine or in CI.

### Firefox

**Firefox did not run on this machine, so nothing here says the app works in Firefox.**

Every test fails in about 0ms when Playwright launches the browser:

```
browserType.launch: Failed to launch the browser process.
[err] *** You are running in headless mode.
[err] Could not find profile folder.
<process did exit: exitCode=1>
```

**The cause is not established.** What was tested from inside the agent's shell:

| Experiment | Result |
| --- | --- |
| Firefox 157 (`firefox --version`) | Runs and reports its version |
| A valid, writable profile directory, in `/tmp` and under `~/Library` | Same error |
| `HOME` redirected to a clean directory | Same error |
| `-CreateProfile`, and `XRE_PROFILE_PATH` | Same error |
| Firefox's internal sandboxes disabled through `MOZ_DISABLE_*` | Same error |
| An older Playwright build, Firefox 134 | Also fails, with `Can't find profile directory` and `sandbox_extension_issue_file_to_process failed: Operation not permitted` |
| Same launch outside the agent's shell sandbox | Not possible: the permission system denied it |

This points towards macOS 27, which is a pre-release, but an environment restriction on the agent's
shell has not been ruled out. To settle it, run this in an ordinary terminal:

```bash
npm run db:start && npm run test:e2e:firefox
```

Chromium and WebKit launched normally in the same shell. WebKit here is Playwright's build, which
reports version 27.2 and downloads as its macOS 26 package. It is close to Safari but is not Safari.

## Do the tests detect real bugs?

Passing tests only mean something if they can fail. Each bug below was temporarily put back into the
final code, and the matching tests were run in Chromium. All 12 were caught, and every file was restored
and checked afterwards.

| Bug put back | Tests failed |
| --- | --- |
| Order filter race: router transitions on, form guard removed | 1 of 1 |
| Form controls snap back: router transitions on | 1 of 1 |
| Modal does not return keyboard focus | 3 of 3 |
| Order form errors go stale | 1 of 1 |
| Login errors go stale | 1 of 1 |
| Order form loads only the first page of stock | 1 of 1 |
| New idempotency key on every retry | 1 of 1 |
| Customer scope removed in the API | 3 of 4 |
| Tax truncates instead of rounding half-up | 1 of 1 |
| Cancelling does not restore stock | 1 of 1 |
| CSV formula protection removed | 1 of 1 |
| Viewers allowed to write inventory | 1 of 1 |

The one customer-scope test that still passed checks that buyers cannot reach order creation, which
that bug does not affect. The API freeze was checked the same way in the backend suite: without the
fix, all 300 requests in a burst timed out; with it, all 300 returned 200.

This is a hand-picked set of known risks, not full mutation testing. Bugs outside this list could go
unnoticed.

## Coverage by area (cases per browser)

| File | Cases | Covers |
| --- | --- | --- |
| `auth.spec.ts` | 7 | Login, cookie flags, generic errors, server-side logout, expiry, return-to-page, open redirect |
| `rbac.spec.ts` | 10 | Navigation per role, UI and API refusals, session revocation, customer-scoped Viewer |
| `orders.spec.ts` | 18 | Totals across UI, API and database, stock races, filters, sort, pagination, CSV, status rules |
| `payments.spec.ts` | 6 | Approve, decline, timeout, settlement gates, lost-response replay, key reuse |
| `inventory.spec.ts` | 8 | Search, audited updates, validation, stale edits, focus restoration, low stock |
| `products.spec.ts` | 7 | Filters, numeric sort, exact cents, duplicates, price history, retirement, dashboard |
| `framework.spec.ts` | 6 | Read-only database, money helpers, namespaces, safe cleanup, CSV parser. No browser |

Tags: 14 `@smoke`, 31 `@critical`, and every browser test is `@regression`. A test can have several.

## Backend tests

166 test cases come from 136 test functions. Three functions are parametrized and supply 33 cases, 20
of which cover every disallowed order status transition, so the raw count overstates distinct scenarios.
New in Phase 2: 3 customer-creation tests and 2 burst tests against a real server.

## Setup from a clean copy

Only git-trackable files were copied to a new directory with no existing database. These all worked:
`npm run setup`, `npm run e2e:install`, type check, lint, 166 backend tests, 118 Playwright tests in
Chromium and WebKit, and `npm run test:e2e:smoke`. No listeners were left running afterwards.

Earlier Phase 1 verification, including data surviving a PostgreSQL restart, is in
[IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## Known limitations

**Testing**

- **Firefox is unverified,** as described above.
- **CI has not run.** Timing on a slower machine is untested.
- **Modal focus return is tested for keyboard use only.** Safari does not focus buttons on mouse click,
  so there is no opener to return to in that case.
- **The audit page's content is not asserted in the UI.** It is a moving list during parallel runs and
  has no filter. Audit content is checked in the database instead.
- **The filter race test uses a script to place input in the same browser task as Clear.** Real
  keystrokes cannot force that order in a production build.
- **Tests run against the production build,** not the dev server.
- **Only one Playwright run at a time.** Each run reseeds `testforge_e2e`.

**Application**

- **No login rate limiting or lockout.** Failed logins are audited but not throttled.
- **No refunds.** A settled order cannot be cancelled.
- **The request queue is unbounded.** Under sustained overload, requests wait until the client gives up
  rather than receiving a fast 503. Phase 4 load tests should examine this.
- **Tax is simplified.** One rate per warehouse; Quebec is rounded to 14.98%. Not for real tax use.
- **CSV export is built in memory** with no row cap.
- **Product and inventory search boxes** do not resync with the browser's back button. Results do.
- **Customer-scoped buyers** can see all stock levels, and staff names in their own orders' history.
  This is a demo design choice and might not suit a real deployment.
- **Sessions have an absolute lifetime** (8 hours by default) and do not extend with activity.
- **Customers cannot be edited or deleted** through the API.

**Tooling**

- **`npm audit` reports 13 moderate findings, all dev tools.** They come from one `minimatch` issue,
  reached through ESLint and `openapi-typescript`. These tools do not ship and only read this project's
  own files. Production dependencies report 0.
- **`embedded-postgres` carries a `-beta` version tag,** though it wraps a PostgreSQL 17.11 release.
  It is for local development only. Its Linux and Intel paths in `scripts/db-local.sh` are untested.
