# Docker

**Status: none of this has ever run.** Docker is not installed on the development machine, so no image has been built and no container has started. The `docker` job in [CI_CD.md](CI_CD.md) is set up to run it on Linux, but the repository has no remote, so that has not happened either. Expect the first run to find problems.

## What was checked without Docker

| Check | Result |
| --- | --- |
| Compose and workflow files parse, and follow project rules | Passed (`npm run ci:policy`) |
| Base images exist at the pinned digests | Confirmed by reading each registry on 2026-11-04 |
| API image's install command, in a temporary virtual environment | Installed, with no pytest, ruff or coverage. The app imported and the bot answered |
| Web image's build steps, in a temporary copy | Built, and `embedded-postgres` was not installed |

**Not checked at all:** building the images, the nginx configuration, running as non-root, health checks, migrations and seeding in a container, data surviving a restart, the Linux browsers in the runner image, and `docker compose up --wait` with a one-shot service. Dockerfiles have also not been linted, because hadolint has no macOS arm64 build in the pinned release. The `policy` CI job lints them.

## What is here

| File | Purpose |
| --- | --- |
| `docker/api.Dockerfile` | FastAPI backend, as a non-root user. Also runs the one-shot migrate and seed step |
| `docker/web.Dockerfile` | Builds the React app, and serves it with unprivileged nginx |
| `docker/nginx.conf.template` | Serves the app and forwards `/api/` to `API_UPSTREAM` |
| `docker/playwright.Dockerfile` | Test runner, on the official Playwright image matching `@playwright/test` |
| `docker/migrate.sh` | Applies migrations, then seeds according to `SEED_MODE` |
| `compose.yaml` | The application stack, with a named volume |
| `compose.test.yaml` | An isolated test stack, with its database in memory |
| `scripts/docker-smoke.sh` | Starts the stack, creates a record, restarts, and checks the record survived |
| `scripts/docker-test.sh` | Runs the suites in the test stack, and copies reports out |

**The chatbot has no separate service.** It is a library inside the API, and adding a network hop would give it nothing it needs.

## Commands

These need Docker with Compose v2.

```bash
cp docker/.env.example docker/.env     # then choose your own password
npm run docker:up                      # build and start: http://localhost:8080
npm run docker:down                    # stop, and keep the data
npm run docker:reset                   # delete the volume, and start again from seed data

npm run docker:smoke                   # startup and persistence check, in its own project
npm run docker:test                    # suites in the isolated stack
```

## Design

| Requirement | How it is met |
| --- | --- |
| Pinned versions | Every base image is pinned by tag and digest. Python packages use the lock file as constraints |
| No credentials in images | `.dockerignore` excludes every `.env`. Compose reads the password from `docker/.env`, and stops if it is unset. A policy rule rejects `ENV` or `ARG` credentials |
| Health checks | PostgreSQL with `pg_isready`, the API with `/ready`, nginx with a request |
| Migrations and seeding | A one-shot `migrate` service runs before the API starts. `SEED_MODE=if-empty` leaves existing data alone, and the test stack uses `reset` |
| No embedded PostgreSQL | Containers use the official image. The web image does not install it, and the runner image installs it but never starts it, because it shares the root `package.json` |
| Local databases untouched | The stacks have their own project names, volumes and networks. No database port is published |
| Isolated test database | `compose.test.yaml` keeps data in `tmpfs`, names the database `testforge_e2e`, publishes nothing, and is removed afterwards |
| Same sort order as local | PostgreSQL is initialised with `--locale=C`, because the local cluster uses it and a different collation would change sorting |

`compose.test.yaml` contains a fixed password in plain text, on purpose: it protects a throwaway in-memory database on a private network with no published ports.

The `contract` project is **not** in the Docker test run, because its breaking-change check reads git history and the image has none. It runs natively in CI.

## Limitations

- **Unverified**, as stated above.
- **This is not a production deployment.** There is no TLS, `APP_ENV` is `development`, and the seed accounts have published passwords. `SEED_MODE` must be `none` anywhere real.
- **`--wait` and one-shot services:** some Compose versions report a service that exits as a failure under `--wait`. If the first run hits this, `docker:up` and `docker-smoke.sh` will need changing.
- **Digest pins go stale.** Dependabot is configured to propose updates, but this also has not run.
