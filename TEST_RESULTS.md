# Test Results

Only results from commands that were actually run are recorded here.

**Last updated:** 2026-11-03, Phase 3. **Environment:** macOS 27.0.1 (arm64), Python 3.13.5, Node 24.3.0,
PostgreSQL 17.11, Playwright 1.64.1. Everything ran locally. **CI has not run.**

## Summary

Every Playwright run used `E2E_RETRIES=0`, so nothing could pass on a retry.

| Suite | Command | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- | --- |
| Backend (pytest, real PostgreSQL) | `npm run test:backend` | **175** | 0 | 0 | n/a |
| Playwright Chromium 156 | `npx playwright test --project=chromium` | **57** | 0 | 0 | 0 |
| Playwright WebKit 27.2 | `npm run test:e2e:webkit` | **57** | 0 | 0 | 0 |
| Playwright Firefox 157 | `npm run test:e2e:firefox` | **0: unverified** | 57 at launch, no test body ran | 0 | 0 |
| Framework self-checks | `npx playwright test --project=framework` | 6 | 0 | 0 | 0 |
| API automation | `npm run test:api` | **147** | 0 | 0 | 0 |
| OpenAPI contract | `npm run test:contract` | **97** | 0 | 0 | 0 |
| PostgreSQL validation | `npm run test:db` | **44** | 0 | 0 | 0 |
| Security regression | `npm run test:security` | **106** | 0 | 0 | 0 |
| Reliability | `npm run test:reliability` | **5** | 0 | 0 | 0 |

These counts include generated cases. For example, the security count has one authorization test per
operation, and the raw number overstates distinct scenarios.

| Other check | Result |
| --- | --- |
| Backend line coverage | 97% (1,284 statements, 33 missed) |
| TypeScript strict type check (frontend and framework) | Passed |
| ESLint and Ruff | Passed, 0 warnings |
| Frontend production build | Passed |
| HTML and JUnit reports | Generated (JUnit: 519 tests, 0 failures, 0 skipped, 0 errors) |
| Setup from a clean clone, with the uncommitted Phase 3 changes applied | 175 backend and 519 Playwright passed; type check, lint and build passed |
| Development database after all runs | Row counts and content hashes identical to before Phase 3 |
| `npm audit --omit=dev` | No known vulnerabilities |
| `npm audit` including dev tools | 13 moderate (see limitations) |

**Not done yet, so no results exist:** axe accessibility scans, k6 load tests, AI evaluation, Docker,
GitHub Actions, secret scanning.

## Parallel and isolation runs

| Run | Workers | Passed | Failed | Skipped | Flaky | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| All 5 service suites together | 4 | 399 | 0 | 0 | 0 | 46s |
| All 5 service suites, each test 3 times | 4 | 1,197 | 0 | 0 | 0 | 156s |
| All 5 service suites | 8 | 399 | 0 | 0 | 0 | 48s |
| All 5 service suites | 1 | 399 | 0 | 0 | 0 | 51s |
| Everything except Firefox, together | 4 | 519 | 0 | 0 | 0 | 96s |
| Smoke, Chromium | 4 | 14 | 0 | 0 | 0 | 13s |
| Critical, Chromium and WebKit | 4 | 62 (31 each) | 0 | 0 | 0 | 42s |

`reliability` always runs one test at a time, whatever the worker count.

### Intermittent failures found by repeating runs

Single passes were not enough here. Repeated runs exposed these, and each is now fixed at its cause.

| Failure | Cause | Type |
| --- | --- | --- |
| A product appeared twice in the order form | Offset pages shifting mid-read | **Application defect** |
| Expired-session browser test timed out | The test aged the session while page requests were in flight | Test defect, from Phase 2 |
| `SESSION_EXPIRED` test received `INVALID_SESSION` | The test aged a shared user's session, and another worker's login removed it | Test defect |
| `ECONNRESET` with 101 fillers | Bulk setup opened too many connections at once | Test defect |

**One failure was not identified.** A single WebKit test failed in one run before failure details were
being kept, so its cause is unknown. It may be the expired-session race, but that is not established.
It did not recur in the later runs: 6 Chromium and WebKit runs, 3 runs of everything, and the final
verification. Treat this as good evidence of stability, not proof that no flakiness exists. Timing on
other machines and in CI is untested.

## Firefox

**Firefox remains unverified. Nothing here says the app works in Firefox.** The project configuration
and its tests are unchanged, and none are skipped. Firefox should be tested on Linux in CI in Phase 6.

Exact failure, for each of the 57 tests, when Playwright launches the browser:

```
Error: browserType.launch: Failed to launch the browser process.
[err] *** You are running in headless mode.
[err] Could not find profile folder.
<process did exit: exitCode=1, signal=null>
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

No further macOS workarounds were attempted in Phase 3.

## Bugs found in Phase 3

**Application defects, all fixed, each with a regression test at backend and API level:**

| Bug | Effect | Found by |
| --- | --- | --- |
| `date_to=9999-12-31` overflowed | Valid request returned 500 on the order list and CSV export | API test |
| Failed login with an email over 64 characters overflowed the audit column | 422 instead of 401, and the failed attempt was not audited | API test |
| Payments exposed the staff member's idempotency key | Customer-scoped buyers could read it | Security test |
| Order form read the catalog with offset pages | A product could appear twice, or a sellable product could be missing, if the catalog changed mid-read | Repeated combined runs |

Removing `idempotency_key` from responses is a breaking change. The new detector flagged all 8 affected
locations, and they are recorded with a reason in `apps/api/openapi-accepted-breaking-changes.json`.

The order form now reads with a keyset cursor (`sort=id`, `after_id`), which returns every row that
exists throughout the read exactly once. Deduplicating alone would not have restored skipped
rows.

**Test and framework defects, not application bugs:**

- Playwright re-encoded a malformed JSON string, so the invalid-JSON test sent valid JSON. It now sends raw bytes.
- A contract case logged out on the admin client, which cleared that client's cookie.
- A test miscounted the money columns (7, not 8).
- Tests ran parallel queries on one database client, which `pg` deprecates.
- See the table above for the three intermittent test defects.

**Environment limit, not an application bug:** a burst of 300 simultaneous connections from Playwright got
`connect ECONNRESET` on some requests. This Mac's listen queue is capped at 128 (`kern.ipc.somaxconn`), so
the operating system refuses connections before the API sees them. No retry was added to hide it. The
burst was reduced to 100, which is still well above the 30 connections and 40 threads, and removing the fix
still makes it fail: 99 of 100 requests time out. The 300-request backend test still passes because its
client connects more gradually.

## Do the tests detect real bugs?

Each bug below was temporarily put back, and the service suites listed were run. All 20 were caught, and
every file was restored and checked afterwards.

| Bug put back | Suites run | Failed |
| --- | --- | --- |
| Customer scope removed from the API | security, database | 11 |
| Role checks disabled | security | 18 |
| Sessions survive a role change or deactivation | security | 2 |
| Raw SQL string in product search | security | 2 |
| `password_hash` exposed in user responses | contract, security | 108 |
| Stock committed before the order is written | database | 1 |
| Tax truncates instead of rounding half-up | database, API | 5 |
| Idempotency fingerprint not checked | API, security | 4 |
| Idempotency key returned to clients again | security, contract | 28 |
| Date filter overflow | API | 1 |
| Long-email audit overflow | API, database | 2 |
| Inventory update not audited | database | 1 |
| Origin check removed | security | 2 |
| Unknown request fields accepted | contract, API | 19 |
| Error body `request_id` wrong | contract | 17 |
| Undocumented status from an endpoint | contract | 1 |
| Cancelling does not restore stock | database | 1 |
| Stale inventory version accepted | API | 3 |
| Payment order lock removed | API, security | 3 |
| SQL assertions connect as the table owner | database | 7 |

Three more were checked separately:

| Bug put back | Result |
| --- | --- |
| Admission limit removed (the Phase 2 deadlock) | All 5 reliability tests failed; 99 of 100 requests timed out |
| Order form uses offset pages again | Regression test failed in Chromium and WebKit, 1 duplicate found |
| Cursor skips rows | API test failed |

This is a hand-picked set of known risks, not full mutation testing. These 20 ran before the cursor fix
and the final test fixes, and were not repeated afterwards. Bugs outside this list could go unnoticed. The
12 browser-suite proofs from Phase 2 were not repeated either.

## API coverage

Traffic from the service suites reached **all 35 operations and 129 of the 235 documented
operation-and-status pairs**. A run writes the per-operation table to `reports/contract/coverage.md`.

**The other 106 are mostly not real gaps, and this number should not be read as coverage.** FastAPI adds
400, 401, 403, 404, 409 and 422 to nearly every operation, including ones that cannot occur, such as 409 on
`GET /auth/me`. One genuine exception: `/ready` 503 needs the database down, so it is only tested in pytest.

| File | Cases | Covers |
| --- | --- | --- |
| `tests/api/auth.spec.ts` | 18 | Login, cookie flags, invalid payloads, logout, independent sessions, expiry |
| `tests/api/users.spec.ts` | 13 | Users, customers, warehouses, roles, self-modification |
| `tests/api/products.spec.ts` | 27 | CRUD, retirement, invalid fields, pagination, sort, filters, literal wildcards |
| `tests/api/inventory.spec.ts` | 16 | Filters, cursor, versions, concurrent edits, invalid updates |
| `tests/api/orders.spec.ts` | 41 | Creation, tax, stock races, invalid payloads, state machine, listing |
| `tests/api/payments.spec.ts` | 17 | Success, decline, timeout, replay, concurrency, settlement, invalid keys |
| `tests/api/export.spec.ts` | 4 | Headers, content, filters, formula protection |
| `tests/api/errors.spec.ts` | 11 | Envelopes, request IDs, invalid bodies, NUL bytes, health |
| `tests/contract/spec.spec.ts` | 40 | Spec drift, breaking-change rules, the checker itself |
| `tests/contract/operations.spec.ts` | 57 | Every operation's success response, error envelopes, generated invalid requests and queries |
| `tests/database/persistence.spec.ts` | 35 | Totals, integer cents, inventory, payments, rollback, integrity, audit, isolation |
| `tests/database/safety.spec.ts` | 9 | Read-only role, no dev access, database name guard |
| `tests/security/authorization.spec.ts` | 41 | Every operation by role, escalation, cross-site writes |
| `tests/security/idor.spec.ts` | 9 | Cross-customer reads, filters, CSV, dashboard, writes |
| `tests/security/sessions.spec.ts` | 14 | Revocation, expiry, fixation, forged cookies, stored hash |
| `tests/security/input-handling.spec.ts` | 32 | SQL injection, invalid identifiers, leakage |
| `tests/security/idempotency-abuse.spec.ts` | 10 | Key reuse across users, orders and tokens, including races |
| `tests/reliability/burst.spec.ts` | 5 | Bursts of reads, mixed reads, orders and slow payments; liveness |

The approach for each is in [TEST_STRATEGY.md](TEST_STRATEGY.md).

## Browser coverage (cases per browser)

| File | Cases | Covers |
| --- | --- | --- |
| `auth.spec.ts` | 7 | Login, cookie flags, generic errors, server-side logout, expiry, return-to-page, open redirect |
| `rbac.spec.ts` | 10 | Navigation per role, UI and API refusals, session revocation, customer-scoped Viewer |
| `orders.spec.ts` | 19 | Totals across UI, API and database, stock races, filters, sort, pagination, CSV, status rules |
| `payments.spec.ts` | 6 | Approve, decline, timeout, settlement gates, lost-response replay, key reuse |
| `inventory.spec.ts` | 8 | Search, audited updates, validation, stale edits, focus restoration, low stock |
| `products.spec.ts` | 7 | Filters, numeric sort, exact cents, duplicates, price history, retirement, dashboard |
| `framework.spec.ts` | 6 | Read-only database, money helpers, namespaces, safe cleanup, CSV parser. No browser |

Tags: 14 `@smoke`, 31 `@critical`, and every browser test is `@regression`. A test can have several.

## Backend tests

175 test cases come from 145 test functions. Three functions are parametrized and supply 33 cases, 20 of
which cover every disallowed order status transition, so the raw count overstates distinct scenarios. New in
Phase 3: 4 deterministic middleware tests, and regressions for the date overflow, long email, key exposure
and cursor.

## Phase 2 mutation results

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

Earlier Phase 1 verification, including data surviving a PostgreSQL restart, is in
[IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## Known limitations

**Testing**

- **Firefox is unverified,** as described above.
- **CI has not run.** Timing on a slower machine is untested.
- **One WebKit failure was not identified,** as described above.
- **The spec documents statuses that cannot occur,** so the status check is looser than it looks: an
  unexpected 409 on a read would pass it. Specific tests assert exact statuses where they matter.
- **The spec does not declare cookie authentication or roles.** Authorization expectations live in a policy
  table in `tests/security/authorization.spec.ts`.
- **CSV bodies are not schema-validated,** because the spec only says "string". API tests check their content.
- **The breaking-change check covers what this API's spec uses.** In CI it needs enough git history to read the
  base revision. A shallow clone would make it fail.
- **The mid-transaction rollback test relies on PostgreSQL rejecting a NUL byte** as its way to fail late.
- **Security tests are regression checks,** not a penetration test. Timing-based user enumeration is not tested.
- **Bursts are limited to 100 connections** by the macOS listen queue.
- **The filter race test uses a script to place input in the same browser task as Clear.**
- **Modal focus return is tested for keyboard use only.**
- **The audit page's content is not asserted in the UI.** It is checked through the API and database.
- **Only one Playwright run at a time.** Each run reseeds `testforge_e2e`.

**Application**

- **The request queue is unbounded,** to be examined in Phase 4. Under sustained overload, requests wait until
  the client gives up rather than receiving a fast 503.
- **More than 128 simultaneous new connections can be reset by the operating system on this machine** before the
  API accepts them. Phase 4 should measure this on Linux too.
- **List pages use offset pagination.** Turning pages while data changes can repeat or skip a row on screen. Only
  the order form's full read uses the cursor.
- **No login rate limiting or lockout.** Failed logins are audited but not throttled, so the audit table can grow.
- **No `Cache-Control: no-store` on authenticated responses,** and the API docs and spec are public. Both would need
  revisiting for a real deployment.
- **The largest possible order total exceeds JavaScript's safe integer range** (50 lines of 100,000 units at the
  maximum price). The code allows it, and no test covers it.
- **No refunds.** A settled order cannot be cancelled.
- **Tax is simplified.** One rate per warehouse; Quebec is rounded to 14.98%. Not for real tax use.
- **CSV export is built in memory** with no row cap.
- **Product and inventory search boxes** do not resync with the browser's back button. Results do.
- **Customer-scoped buyers** can see all stock levels, retired products by ID, and staff names in their own orders'
  history. This is a demo design choice and might not suit a real deployment.
- **Sessions have an absolute lifetime** (8 hours by default) and do not extend with activity.
- **Customers cannot be edited or deleted** through the API.

**Tooling**

- **`npm audit` reports 13 moderate findings, all dev tools.** They come from one `minimatch` issue, reached through
  ESLint and `openapi-typescript`. These tools do not ship and only read this project's own files. Production
  dependencies report 0.
- **`embedded-postgres` carries a `-beta` version tag,** though it wraps a PostgreSQL 17.11 release. It is for local
  development only. Its Linux and Intel paths in `scripts/db-local.sh` are untested.
- **The test role `testforge_e2e_reader` lives in the local PostgreSQL cluster,** created by Playwright's global setup.
  It has no privileges on development tables.
