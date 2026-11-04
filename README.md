# TestForge AI

An enterprise SDET and test automation portfolio project, built around a real application under test.

> **Status: Phases 1 to 5 of 7 complete, and every result is local.** The commerce application and its backend, browser, API, contract, database, security, accessibility, performance and AI test suites exist and ran on this machine. **Firefox cannot launch here, so it is unverified. One WebKit failure is unresolved. No live LLM has been called, and offline chatbot results are modest.** Docker and CI are **not built yet**. See [TEST_RESULTS.md](TEST_RESULTS.md), [AI_EVALUATION.md](AI_EVALUATION.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md).

## The application

A synthetic B2B commerce and order management system. All companies, people and products are
fictional, and payments are simulated: no card data is accepted and no real money moves.

| Area | What it does |
| --- | --- |
| Auth | Server-side sessions in an HttpOnly, SameSite=Lax cookie. Only a hash of the token is stored. |
| Roles | Admin, Manager and Viewer, enforced in the backend. Customer-scoped buyers see only their own orders; other customers' orders return 404. |
| Products | Search, filter, sort, paginate, create, edit, soft delete. |
| Inventory | Stock per warehouse, with version checks so a stale edit cannot overwrite a newer one. |
| Orders | Multi-line orders in one transaction, row locks that prevent overselling, a status state machine, filtered grid, CSV export. |
| Payments | Deterministic simulated approve, decline and timeout, idempotency keys, settlement. |
| Audit | Business actions are recorded in the same transaction as the change they describe. |
| Support | A chat page that answers from approved articles with citations, and from orders the user may see. Offline by default. |

## Stack

React 19, TypeScript and Vite · FastAPI, Pydantic v2, SQLAlchemy 2 and Alembic · PostgreSQL 17 ·
pytest · Playwright with strict TypeScript · ESLint and Ruff.

## Getting started

Prerequisites: Node 22 or newer, and Python 3.12 or newer. PostgreSQL does not need to be installed:
the `embedded-postgres` dev dependency provides server binaries, and the data lives in `.local/`.
To use your own PostgreSQL binaries instead, set `PG_BIN` to their directory.

```bash
npm run setup         # install dependencies, start PostgreSQL, migrate, seed
npm run e2e:install   # download the Playwright browsers
npm run dev           # API on :8000, web app on http://localhost:5173
```

`Ctrl+C` stops the API and web app. PostgreSQL keeps running until `npm run db:stop`.

### Seed accounts

These fictional accounts are for local development only. Seeding is refused when `APP_ENV=production`.

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@testforge.example` | `Admin!Forge2026` |
| Manager | `manager@testforge.example` | `Manager!Forge2026` |
| Viewer | `viewer@testforge.example` | `Viewer!Forge2026` |
| Viewer, scoped to Maple Ridge | `buyer@mapleridge.example` | `Buyer!Forge2026` |
| Viewer, scoped to Granite Harbour | `buyer@granite.example` | `Buyer!Forge2026` |

## Running the tests

Backend tests need PostgreSQL running (`npm run db:start`). Playwright starts everything it needs,
against its own database and ports, so it does not touch development data.

| Command | Purpose |
| --- | --- |
| `npm run test:backend` | Backend tests |
| `npm run test:backend:coverage` | Backend tests with a coverage report |
| `npm run test:e2e` | All browsers (not the service suites) |
| `npm run test:e2e:chromium`, `test:e2e:webkit`, `test:e2e:firefox` | One browser |
| `npm run test:e2e:smoke` | Fast core journeys in Chromium |
| `npm run test:e2e:critical` | Critical paths in Chromium and WebKit |
| `npm run test:e2e:regression` | Everything tagged for regression |
| `npm run test:api` | API automation |
| `npm run test:contract` | OpenAPI contract and breaking-change checks |
| `npm run test:db` | PostgreSQL validation with read-only SQL |
| `npm run test:security` | Security regression, against the local app only |
| `npm run test:reliability` | Bounded concurrent bursts |
| `npm run test:service` | All five of the above |
| `npm run test:a11y` | axe, semantics, focus and keyboard tests in Chromium |
| `npm run test:a11y:keyboard` | Keyboard tests in WebKit |
| `npm run perf:install`, then `npm run perf` | k6 scenarios on a dedicated database. See [PERFORMANCE.md](PERFORMANCE.md) |
| `npm run test:ai`, `npm run lint:ai` | AI tests and lint, offline with no key. See [AI_TESTING.md](AI_TESTING.md) |
| `npm run ai:eval`, `npm run ai:eval:heldout` | Chatbot evaluation. See [AI_EVALUATION.md](AI_EVALUATION.md) |
| `npm run ai:triage:corpus` | Run deliberately failing tests, then classify them. Failures are expected |
| `npm run typecheck` | Strict type check of the frontend and framework |
| `npm run lint` / `npm run lint:backend` | ESLint / Ruff |
| `npm run build` | Frontend production build |

Useful options:

```bash
E2E_WORKERS=8 npm run test:e2e:chromium                      # parallelism
npx playwright test --project=chromium --repeat-each=3       # hunt for flakiness
npx playwright test --grep "rapid typing" --headed           # watch one test
```

**On this machine, use `npm run test:e2e:chromium` and `test:e2e:webkit`.** Firefox currently fails to
launch here, so `npm run test:e2e` reports 64 launch failures and Firefox is unverified. See
[TEST_RESULTS.md](TEST_RESULTS.md#firefox).

### Investigating a failure

Failures keep a trace, screenshots and video in `test-results/<test-name>/`.

```bash
npm run e2e:report                                           # HTML report, with all attachments
npx playwright show-trace test-results/<test-name>/trace.zip # step through one failure
```

Failed browser tests also attach `diagnostics`, with console errors, failed requests and execution metadata.

The trace viewer shows each action with a before and after snapshot of the page, plus console output
and network calls. A test with two signed-in users has one trace covering both sessions, plus a
screenshot and video for each. Reports are written to `playwright-report/` and
`reports/junit/playwright.xml`.

`OPENAPI_BASE_REF=<ref> npm run test:contract` compares the spec with another revision. A deliberate breaking change
must be recorded, with its reason, in `apps/api/openapi-accepted-breaking-changes.json`.

To reproduce a failure, run that one test with `--grep`. Tests create their own data, so they do not
depend on what ran before them. If a failure only appears in parallel, add `--repeat-each=3`.

## Other commands

| Command | Purpose |
| --- | --- |
| `npm run db:start`, `db:stop`, `db:status` | Control the local PostgreSQL |
| `npm run db:reset` | Migrate, then replace all **dev** data with the deterministic seed |
| `npm run db:destroy` | Delete the local PostgreSQL data directory |
| `npm run openapi:export` | Regenerate `apps/api/openapi.json` and the frontend types |

The API serves interactive docs at `http://localhost:8000/api/v1/docs`. The committed spec is
[apps/api/openapi.json](apps/api/openapi.json), and a test fails if it drifts from the code.

## Layout

```
apps/api      FastAPI app, Alembic migrations, seed data, pytest suite
apps/web      React app
framework     Playwright page objects, components, fixtures, factories, helpers and contract checks
tests/e2e     Playwright browser tests
tests/api, contract, database, security, reliability    Playwright tests with no browser
tests/accessibility    axe, semantics, focus and keyboard tests
performance   k6 scenarios
ai            AI test generation, support chatbot, LLM evaluation and failure triage
scripts       Setup, local PostgreSQL, dev runner, E2E API runner, OpenAPI export
```

The fixture design, page objects, isolation and browser configuration are explained in
[ARCHITECTURE.md](ARCHITECTURE.md#playwright-framework). What each test layer covers is in
[TEST_STRATEGY.md](TEST_STRATEGY.md), and results are in [TEST_RESULTS.md](TEST_RESULTS.md),
[ACCESSIBILITY.md](ACCESSIBILITY.md), [PERFORMANCE.md](PERFORMANCE.md), [AI_TESTING.md](AI_TESTING.md) and [AI_EVALUATION.md](AI_EVALUATION.md).

## Known limitations

See [TEST_RESULTS.md](TEST_RESULTS.md#known-limitations).
