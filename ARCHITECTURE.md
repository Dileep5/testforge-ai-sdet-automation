# Architecture

## Application

```
Browser ──> Web app (React, Vite) ──/api proxy──> FastAPI ──> PostgreSQL 17
```

- **Same origin in the browser.** The web server proxies `/api`, so the session cookie needs no CORS.
- **Sessions live on the server.** The cookie is HttpOnly and SameSite=Lax, and only a SHA-256 of the
  token is stored. Logout and privilege changes take effect immediately.
- **Money is integer cents,** with tax in basis points. Database check constraints reject totals that
  do not add up.
- **Business changes and their audit rows commit in one transaction.**

### Request admission

`ConcurrencyLimitMiddleware` admits at most as many requests as the database pool has connections (30),
and queues the rest before they acquire anything. Phase 2 showed why this is needed. FastAPI runs
synchronous dependencies and endpoints as separate jobs on a 40-thread pool, and a request keeps its
database connection between those jobs. Under a burst, all threads could be waiting for a connection
while all connections were held by requests waiting for a thread, freezing the API until the 30 second
pool timeout. `/health` is exempt, so a busy server does not look dead.

The limit is per process. Running several API processes means dividing database connections among them.

## Test environments

Each kind of test has its own database, so none can damage another's data.

| Used by | Database | API | Web |
| --- | --- | --- | --- |
| Local development | `testforge` | :8000 | :5173 (dev server) |
| Backend tests (pytest) | `testforge_test` | In process, plus real uvicorn for burst tests | None |
| Playwright | `testforge_e2e` | :8100 | :5273 (production build) |

All three databases live in one project-local PostgreSQL on :55432. Backend tests refuse any database
whose name does not end in `_test`, and Playwright refuses any not ending in `_e2e`.

## Playwright framework

```
tests/e2e/*.spec.ts       What should happen, in business terms
        │
framework/fixtures        Sessions per role, per-test data, read-only database
        │
framework/pages           One class per screen: actions and locators, no assertions on outcomes
framework/components      Grid, modal, toast, navigation, shared between pages
        │
framework/factories       Creates each test's records through the real API, and cleans them up
framework/helpers         Typed API client, read-only database, network waits, money, CSV
```

### Fixtures

Tests ask for the roles they need, and each one gets its own browser context and server-side session:

```ts
test("...", async ({ manager, buyer, data, db }) => {
  const product = await data.product({ priceCents: 1000, stock: { YYZ1: 5 } });
  await manager.app.orders.goto();   // a page object on the manager's own browser
  await manager.api.me();            // the API, on that same session
  expect(await db.stock(product.id, "YYZ1")).toBe(5);
});
```

| Fixture | Scope | Provides |
| --- | --- | --- |
| `admin`, `manager`, `viewer` | Test | Seeded account, freshly logged in through the API |
| `buyer` | Test | Customer-scoped Viewer, with a customer and user created for this test |
| `anon` | Test | A browser nobody has signed in to |
| `signIn` | Test | Opens another session for any credentials, such as a user the test created |
| `data` | Test | Factory for the test's records, with automatic cleanup |
| `setupApi` | Test | Admin API client with no browser, used by `data` |
| `db` | Worker | One read-only database connection |

**Login goes through the API, not saved files.** Each test logs in with `APIRequestContext` and passes
the resulting cookie to a new browser context. No session is shared between tests, so a test can log
out, or expire its own session, without affecting any other. No auth state is written to disk.

**The teardown also checks for crashes.** An uncaught error in any page fails the test, even if the
visible assertions passed.

### Page objects

- **Locators prefer roles and labels:** `getByRole` and `getByLabel`, with test IDs for data the user
  reads but no role describes. Fields in a dialog are scoped to it, because the page behind can have
  fields with the same labels.
- **Actions wait for their own API response.** `whileWaitingFor` registers the wait before the action
  starts, so a fast response cannot be missed. Filtering waits for a response with the exact parameters
  the form should produce, so a stale response from an earlier request cannot satisfy it.
- **`BasePage` is deliberately small.** It only holds what every page shares (toasts). A deep hierarchy
  would add indirection without removing duplication.

### Test isolation

| Risk | How it is handled |
| --- | --- |
| Name collisions between workers | Names derive from a hash of test ID, retry and repeat index. This is deterministic and unique per attempt and browser |
| Shared mutable records | Every test that changes data creates its own customer and products. Seeded records are only read |
| Global counts moving during a run | Assertions are scoped to the test's own customer or SKU. Moving lists such as the audit page are checked by shape only, and audit content is checked in the database by entity ID |
| Cleanup hitting another worker | `TestData` only touches the IDs it recorded creating. A framework test confirms a seeded product is left unchanged |
| Leftovers between runs | Global setup reseeds `testforge_e2e` at the start of every run |
| Verification changing data | `ReadOnlyDb` connects with `default_transaction_read_only=on`. A framework test confirms writes are refused |

Cleanup cancels orders that can still be cancelled, retires products and deactivates users. Customers
have no delete operation, and settled orders stay as history; both last until the next reseed.

The framework's only direct database write is `expireSession`, which ages one session, found by the
hash of the calling test's own cookie. Waiting out a real session lifetime would make that test
impractical.

### Browser configuration

Projects are defined in `playwright.config.ts`: `chromium`, `firefox`, `webkit`, plus a browserless
`framework` project for checks on the helpers themselves.

| Setting | Value | Override |
| --- | --- | --- |
| Workers | 50% of CPU cores (2 in CI) | `E2E_WORKERS=4` or `E2E_WORKERS=25%` |
| Retries | 0 locally, 1 in CI | `E2E_RETRIES=0` |
| Traces, screenshots, video | Kept for failures only | |

A retried test that passes is reported as flaky, not passed, so retries cannot hide a problem.

Playwright only records video automatically for its built-in `page` fixture. Role sessions open their
own contexts, so the fixture records and keeps video itself. Traces and screenshots do apply to those
contexts automatically. A deliberate failure with two sessions confirmed all three are captured.
