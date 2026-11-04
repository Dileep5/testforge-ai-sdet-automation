# Docker

**Status: images build, and the application stack is verified on Linux. The test suites have run in Docker, with 643 passed and 20 failed. Fixes for those failures are local, and have not run.** Docker is not installed on the development machine, so this comes only from [the second GitHub Actions run](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41893657050).

| Check | Result on GitHub, ubuntu-24.04 |
| --- | --- |
| API, web and runner images | Built |
| Application stack healthy, with `up --wait` and a one-shot `migrate` | Passed |
| Migrations and seeding | Passed: the API only starts after `migrate` succeeds, and the seeded admin signed in |
| A record survives `down` and `up`, keeping the volume | Passed |
| Test stack healthy | Passed |
| Playwright suites in the test stack | 643 passed, **20 failed**. See [TEST_RESULTS.md](TEST_RESULTS.md#second-github-actions-run) |

The Dockerfiles pass `hadolint` locally, with one suppressed note: `USER pwuser` is named by the base image, which documents no fixed numeric id.

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

- **No green Docker run yet,** as stated above.
- **Plain HTTP:** the stack serves `http://web:8080`, which is not a secure context. This found a real bug, and is a useful difference from localhost.
- **This is not a production deployment.** There is no TLS, `APP_ENV` is `development`, and the seed accounts have published passwords. `SEED_MODE` must be `none` anywhere real.
- **Digest pins go stale.** Dependabot would propose updates, but it is temporarily off, and has never run. See [CI_CD.md](CI_CD.md#security).
