# TestForge AI

An enterprise SDET and test automation portfolio project, built around a real application under test.

> **Status: Phase 1 of 7 complete.** The commerce application and its backend tests exist and are
> verified. The Playwright framework, contract, accessibility, performance and AI evaluation suites,
> Docker and CI are **not built yet**, and this README will only describe them once they are.
> See [IMPLEMENTATION_LOG.md](IMPLEMENTATION_LOG.md) and [TEST_RESULTS.md](TEST_RESULTS.md).

## The application

A synthetic B2B commerce and order management system. All companies, people and products are
fictional, and payments are simulated: no card data is accepted and no real money moves.

| Area | What it does |
| --- | --- |
| Auth | Server-side sessions in an HttpOnly, SameSite=Lax cookie. Only a hash of the token is stored. Absolute expiry and server-side logout. |
| Roles | Admin, Manager and Viewer, enforced in the backend. Customer-scoped buyers see only their own orders; other customers' orders return 404. |
| Products | Search, filter, sort, paginate, create, edit, soft delete. |
| Inventory | Stock per warehouse, with optimistic version checks so a stale edit cannot overwrite a newer one. |
| Orders | Multi-line orders in one transaction, row locks that prevent overselling, a status state machine, filtered grid, CSV export. |
| Payments | Deterministic simulated approve, decline and timeout, idempotency keys, settlement. |
| Audit | Business actions are recorded in the same transaction as the change they describe. |

Money is integer cents throughout, with tax in basis points rounded half-up. The API and the UI
preview use the same formula, and database constraints reject totals that do not add up.

## Stack

React 19, TypeScript and Vite · FastAPI, Pydantic v2, SQLAlchemy 2 and Alembic · PostgreSQL 17 ·
pytest. Frontend API types are generated from the backend's OpenAPI spec.

```
Browser ──> Vite dev server (:5173) ──/api proxy──> FastAPI (:8000) ──> PostgreSQL (:55432)
```

## Getting started

Prerequisites: Node 22 or newer, and Python 3.12 or newer. PostgreSQL does not need to be installed:
the `embedded-postgres` dev dependency provides server binaries, and the data lives in `.local/`.
To use your own PostgreSQL binaries instead, set `PG_BIN` to their directory.

```bash
npm run setup   # install dependencies, start PostgreSQL, migrate, seed
npm run dev     # API on :8000, web app on http://localhost:5173
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

### Commands

| Command | Purpose |
| --- | --- |
| `npm run test:backend` | Backend tests. PostgreSQL must be running (`npm run db:start`). |
| `npm run test:backend:coverage` | The same, with a coverage report. |
| `npm run lint:backend` | Ruff lint and format check. |
| `npm run typecheck` / `npm run build` | Frontend type check / production build. |
| `npm run db:start`, `db:stop`, `db:status` | Control the local PostgreSQL. |
| `npm run db:reset` | Migrate, then replace all dev data with the deterministic seed. |
| `npm run db:destroy` | Delete the local PostgreSQL data directory. |
| `npm run openapi:export` | Regenerate `apps/api/openapi.json` and the frontend types. |

Backend tests use a separate `testforge_test` database and refuse to run against any database whose
name does not end in `_test`, because they wipe it.

The API serves interactive docs at `http://localhost:8000/api/v1/docs`. The committed spec is
[apps/api/openapi.json](apps/api/openapi.json), and a test fails if it drifts from the code.

## Layout

```
apps/api    FastAPI app, Alembic migrations, seed data, pytest suite
apps/web    React app
scripts     Setup, local PostgreSQL, dev runner, OpenAPI export
```

## Known limitations

See [TEST_RESULTS.md](TEST_RESULTS.md#known-limitations).
