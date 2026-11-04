# Test Strategy

How TestForge is tested, what each layer is responsible for, and what is deliberately left out.
Results are in [TEST_RESULTS.md](TEST_RESULTS.md). The framework's design is in
[ARCHITECTURE.md](ARCHITECTURE.md#playwright-framework).

## Layers

| Layer | Location | Runs against | Answers |
| --- | --- | --- | --- |
| Backend | `apps/api/tests` (pytest) | App in process, real PostgreSQL; real uvicorn for bursts | Do business rules and edge cases hold, including failures that are hard to trigger from outside? |
| Browser | `tests/e2e` | Production web build, real API and database | Can a user do the job in each browser? |
| API | `tests/api` | Real API over HTTP | Does each endpoint behave correctly for valid and invalid requests? |
| Contract | `tests/contract` | Real API and the generated OpenAPI spec | Does the API do what its spec says, and has the spec broken for existing clients? |
| Database | `tests/database` | Read-only SQL on the database the API wrote to | Is what was stored correct, whatever the API reported? |
| Security | `tests/security` | Real API and read-only SQL, local app only | Can a caller reach or change what they should not? |
| Reliability | `tests/reliability`, plus `test_concurrency_limit.py` | Real API under a fixed burst | Does the API keep answering, and stay correct, under concurrency? |

Nothing in these layers mocks the API or database. A test fails if the real system misbehaves.

**Overlap is deliberate but limited.** Rules are tested in detail at the lowest layer that can reach
them, and the higher layers confirm they hold end to end. For example, pytest covers all 20 disallowed
status transitions, while `tests/api` covers six through HTTP and `tests/e2e` covers what the user sees.

## API tests

Tests call the API through `ApiClient`, typed by types generated from the OpenAPI spec, so an API change
that breaks a test's assumptions fails the type check.

Each area covers success, each documented failure, invalid and missing fields, wrong types, and
authorization where it applies. Lists also cover pagination, sorting and filtering. A validation test
asserts which field was reported, so a request rejected for some other reason cannot pass.

**Coverage is only as good as the assertions.** The tests check the values returned and, for writes,
that a refused request changed nothing.

## Contract validation

The committed `apps/api/openapi.json` is generated from the API code by `npm run openapi:export`. It is
the only API specification: the tests hold no copy of the schemas.

| Check | How |
| --- | --- |
| The spec matches the code | The live `/api/v1/openapi.json` must equal the committed file exactly |
| Responses match the schema | `observeContract` validates **every** response in the API, contract, database and security suites using Ajv with JSON Schema 2020-12 |
| Undeclared fields | The validator treats objects as closed, so a field the spec does not declare fails. FastAPI's schemas alone would allow it |
| Status codes | A status the operation does not document fails |
| Errors | Each must fit `ErrorResponse`, and `error.request_id` must equal the `X-Request-ID` header |
| Requests | For each operation with a body, every missing required field, wrong type and unknown field is generated from the schema. The spec and the server must both reject it, and the unchanged body must succeed |
| Query parameters | Values the schema forbids are generated from each parameter's type and limits, and must be rejected |
| Operation coverage | A table lists how to reach each success response, and a test fails if an operation in the spec is missing from it |
| Breaking changes | `framework/contract/breaking-changes.ts` compares the spec with a base revision |

### Breaking changes

The check compares against `OPENAPI_BASE_REF`, or the last commit if that is unset. CI should set it to
the merge base, which needs enough git history to be available.

Rules: removed operations, statuses, parameters or properties; new required fields or parameters; type
changes; tighter limits or patterns; request enum values removed; response enum values added; response
fields made optional or nullable. Additive changes are not reported, and tests confirm this.

A deliberate breaking change must be recorded with its reason in
`apps/api/openapi-accepted-breaking-changes.json`, which makes it visible in review.

The check covers what this API's generated spec uses. It is not a general OpenAPI diff tool.

## SQL assertions

Tests read the database the API wrote to, so a bug that returns the right response but stores the wrong
data still fails.

| Area | Examples |
| --- | --- |
| Orders | Header and line items match, and totals recomputed in SQL agree. Prices stay as sold after a product changes |
| Integer cents | Every `*_cents` column is `bigint`. No float, decimal or money column exists anywhere |
| Inventory | Stock and version move exactly once. Sold plus remaining equals the starting stock after a race |
| Payments | Amounts, timestamps per status, one row per replay. Unique indexes exist in the database itself |
| Rollback | A database failure after stock is taken leaves stock, version, orders and audit rows unchanged |
| Referential integrity | Every `*_id` column has a validated foreign key, except the audit log's polymorphic `entity_id`. Orphan sweeps run across all rows |
| Audit | Each business action records its actor and details. Passwords never appear |
| Isolation | What a buyer reaches through the API equals a SQL query for their customer alone |

Sweeps across all rows are safe during parallel runs, because each statement sees one consistent snapshot.

### Protecting data

| Protection | Effect |
| --- | --- |
| Name guard | The framework and test API refuse any database whose name does not end in `_e2e` |
| SELECT-only role | SQL assertions log in as `testforge_e2e_reader`, which has no write privileges. Tests confirm that writes fail even after switching the session's read-only mode off |
| No dev access | That role has no privileges on development tables, and a test confirms it |
| One write path | `expireSession` is the only direct write, and it changes one session, found by the calling test's own cookie |

## Security regression

These tests run only against the local TestForge application. They guard known risks and do not replace
a penetration test.

| Area | What is tested |
| --- | --- |
| Authorization | Every operation against every role. A policy table states who may call what, and a test fails if the spec gains an operation it does not list |
| Role escalation | Self-promotion, Managers administering users, smuggled fields, promoting a customer account |
| IDOR | Another customer's order, history and payments look exactly like a missing record. Filters, CSV and the dashboard cannot widen scope |
| Sessions | Logout, role change, deactivation, expiry, session fixation, forged cookies, the stored hash not being a credential |
| Inventory | Viewers and buyers cannot change stock, and nothing is written |
| SQL injection | Payloads through search, filters, sort, login and stored text. Text is matched and stored literally |
| Invalid identifiers | Malformed ids on every templated route |
| Data leakage | No internals in errors, passwords never echoed, no hash or token in responses |
| Payment idempotency abuse | Key reuse across users, orders and tokens, including races |
| Cross-site writes | Foreign origins are refused even with a valid session |

A refused request is checked twice: the status code, and read-only SQL confirming nothing changed.

## Reliability

The connection and thread-pool deadlock from Phase 2 is guarded at three levels:

1. **Deterministic unit tests** of `ConcurrencyLimitMiddleware` count exactly how many requests are
   admitted. They do not depend on timing.
2. **A structural test** confirms the app admits no more requests than it has database connections.
3. **Bursts against a real server** check that every request gets an answer. Removing the fix makes
   these fail.

Burst sizes are fixed. No test sleeps or retries to get a result, and client errors are reported by their
message.

**Not covered here:** sustained load, latency targets, and the unbounded request queue. Those belong to
Phase 4 performance testing.

## Test data and isolation

- Each test creates its own customers, products, users and orders through the real API.
- Names derive from a hash of test ID, retry and repeat index.
- Seeded records are only read, and only reference data is read for exact values.
- Cleanup touches only IDs that the test created.
- Every run reseeds `testforge_e2e`, so one run cannot affect the next.
- Assertions on shared totals are scoped to the test's own records.

## Flakiness policy

Tests use auto-waiting and no fixed sleeps. Retries are 0 locally and 1 in CI, and a test that passes on
retry is reported as flaky rather than passed. A flaky test is treated as a defect in the test or the
application, and its cause is fixed.

## Checking the tests themselves

Passing tests only mean something if they can fail, so known bugs are temporarily put back and the
matching tests must catch them. The contract checker and breaking-change detector also have their own
tests using deliberately wrong input. This is a hand-picked set of risks, not full mutation testing.

## Not covered yet

| Topic | Where |
| --- | --- |
| Accessibility and load testing | Phase 4 |
| AI test generation and evaluation | Phase 5 |
| CI, Docker, Firefox on Linux | Phase 6 |
| Dependency and secret scanning in CI | Phase 6 |
| Penetration testing, TLS, production hardening | Out of scope for a local portfolio app |
