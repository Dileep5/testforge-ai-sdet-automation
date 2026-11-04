# Test Results

Only results from commands that were actually run are recorded here.

**Last updated:** 2026-11-04, final audit. **Environment:** macOS 27.0.1 (arm64, MacBook Air M3, 8 GB), Python 3.13.5, Node 24.3.0,
PostgreSQL 17.11, Playwright 1.64.1, k6 2.3.0, axe-core 4.14, OpenAI Python SDK 3.45.0 (against a local fake server only). **The [latest verified evidence](#latest-verified-evidence) comes first. Other results are from macOS unless marked Linux. No live LLM has been called.**

## Latest verified evidence

**Verified, from GitHub Actions on Ubuntu 24.04 runners with 2 cores, at commit `3c1a6fd1d9b2c989d6e5c89162101de11232130e`, with retries off.**

[CI run 41910311071](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41910311071): **14 of 14 jobs succeeded**, including the final gate, in 16m 34s and about 56 job minutes.

| Suite | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- |
| Backend, 97% line coverage | **197** | 0 | 0 | n/a |
| AI | **353** | 0 | 0 | n/a |
| Chromium | 65 | 0 | 0 | 0 |
| Firefox | 65 | 0 | 0 | 0 |
| WebKit | 65 | 0 | 0 | 0 |
| Framework | 6 | 0 | 0 | 0 |
| Accessibility 82, keyboard Firefox 33, keyboard WebKit 33 | 148 | 0 | 0 | 0 |
| API 154, contract 100 | 254 | 0 | 0 | 0 |
| PostgreSQL 44, security 114, reliability 5 | 163 | 0 | 0 | 0 |
| **Docker, all of the above browsers and services except contract** | **666** | 0 | 0 | 0 |
| **Performance gates** | **22 of 22** | 0 | | |

[WebKit soak run 41913178899](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41913178899): **650 of 650 passed, with 0 failed, 0 skipped and 0 flaky.** Each test ran 5 times, for 325 tests at 2 workers and 325 at 4. It took 44m 56s and about 58 job minutes. The test that failed in the historical WebKit failure passed 10 of 10 times.

**Limitations of this evidence:**

- **Two fully green CI runs and one soak, on one day,** do not show long-term stability.
- **The historical macOS WebKit input failure remains unexplained.** It did not recur, but the soak used a different WebKit build, on a different operating system, and a WebKit-only suite.
- **The sanitizer's latest fix has been verified locally only.** It runs only when a test fails, and no GitHub run has failed since it was pushed.
- **A slow Ubuntu package mirror nearly stopped the soak.** One job spent 33.8 minutes in setup, and finished at 44.8 of its 45-minute limit, through infrastructure rather than tests. See [CI_CD.md](CI_CD.md#browser-install-reliability). A mitigation is prepared, and **has not run on GitHub.**
- **The first attempt at a soak ran no tests.** It failed at startup, with `Unexpected value '5'` at the two `repeat-each` inputs, because a manual input reached a `type: number` input as a string. Wrapping each in `fromJSON` fixed it, as the run above shows.

## Summary

**The table below is from macOS.**

Every Playwright run used `E2E_RETRIES=0` and 4 workers, so nothing could pass on a retry.

| Suite | Command | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- | --- |
| Backend (pytest, real PostgreSQL) | `npm run test:backend` | **197** | 0 | 0 | n/a |
| Playwright Chromium 156 | `npx playwright test --project=chromium` | **65** | 0 | 0 | 0 |
| Playwright WebKit 27.2 | `npm run test:e2e:webkit` | **65** | 0 | 0 | 0 |
| Playwright Firefox 157, macOS, when last run | `npm run test:e2e:firefox` | **0** | 64 at launch, no test body ran | 0 | 0 |
| Playwright Firefox 157, **Linux CI** | CI `firefox` job | **65** | 0 | 0 | 0 |
| Framework self-checks | `npx playwright test --project=framework` | 6 | 0 | 0 | 0 |
| Accessibility, Chromium | `npm run test:a11y` | **82** | 0 | 0 | 0 |
| Keyboard, WebKit | `npm run test:a11y:keyboard` | **33** | 0 | 0 | 0 |
| Keyboard, Firefox, macOS | `npx playwright test --project=keyboard-firefox` | **0** | 33 at launch, no test body ran | 0 | 0 |
| API automation | `npm run test:api` | **154** | 0 | 0 | 0 |
| OpenAPI contract | `npm run test:contract` | **100** | 0 | 0 | 0 |
| PostgreSQL validation | `npm run test:db` | **44** | 0 | 0 | 0 |
| Security regression | `npm run test:security` | **114** | 0 | 0 | 0 |
| Reliability | `npm run test:reliability` | **5** | 0 | 0 | 0 |
| AI package (pytest, offline) | `npm run test:ai` | **353** | 0 | 0 | n/a |

These counts include generated cases, which overstate distinct scenarios. Accessibility and keyboard detail is in
[ACCESSIBILITY.md](ACCESSIBILITY.md).

| Other check | Result |
| --- | --- |
| Backend line coverage | 97% (1,417 statements, 42 missed) |
| TypeScript strict type check (frontend and framework) | Passed |
| ESLint and Ruff (API and AI package) | Passed, 0 warnings |
| Frontend production build | Passed |
| HTML and JUnit reports | Generated (JUnit: 668 tests, 0 failures, 0 skipped, 0 errors) |
| axe-core | 41 screen states, 0 violations, no rule disabled |
| k6 scenarios, with thresholds | All 7 ran and passed their gates. See [PERFORMANCE.md](PERFORMANCE.md#quality-gates) |
| Offline chatbot evaluation | Held-out correctness 12/23, refusal recall 41/43. See [AI_EVALUATION.md](AI_EVALUATION.md) |
| Failure triage, real deliberately caused failures | Held-out 33/36. See [AI_EVALUATION.md](AI_EVALUATION.md#failure-triage-accuracy) |
| AI safeguards, bugs put back on purpose | 29 of 29 caught (Phase 5) |
| Phase 6 safeguards, bugs put back on purpose | 17 of 17 caught, 3 only after adding tests |
| `actionlint`, CI and Docker policy rules | Passed |
| Fresh copy with CI commands. See [the simulation](#ci-simulation-on-macos) | Passed |
| Development database after all runs | Row counts and content hashes identical to before Phase 3 |
| `npm audit --omit=dev` | No known vulnerabilities |
| `npm audit` including dev tools | 9 moderate, all from 1 advisory. See [why this changed from 13](#why-the-npm-count-changed-from-13-to-9) |

**Never run, so no results exist:** live LLM evaluation.

## First green GitHub Actions run

[Run 41902669074](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41902669074), commit `d3da95be4716c2d35f8f5ccb4371e5f82e24daf8`, ubuntu-24.04 on 2 cores, retries off. **All 14 jobs succeeded, including the final gate.** The [latest verified evidence](#latest-verified-evidence) is a second green run. It took 15m 10s, and 50.8 job minutes, or about 57 with each job rounded up.

| Native Linux job | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- |
| Backend (97% coverage) | 197 | 0 | 0 | n/a |
| AI | 353 | 0 | 0 | n/a |
| Chromium, plus framework | 65 + 6 | 0 | 0 | 0 |
| Firefox | 65 | 0 | 0 | 0 |
| WebKit | 65 | 0 | 0 | 0 |
| Accessibility 82, keyboard Firefox 33, keyboard WebKit 33 | 148 | 0 | 0 | 0 |
| API 154, contract 100 | 254 | 0 | 0 | 0 |
| PostgreSQL 44, security 114, reliability 5 | 163 | 0 | 0 | 0 |

| In Docker, 2 workers, retries off | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- |
| Framework 6, Chromium 65, Firefox 65, WebKit 65, accessibility 82, keyboard Firefox 33, keyboard WebKit 33, API 154, PostgreSQL 44, security 114, reliability 5 | **666** | 0 | 0 | 0 |

**The payment bug is fixed, and verified on real plain HTTP.** Docker serves `http://web:8080`, which browsers treat as an insecure context. The 19 tests that failed in the previous run all passed, and so did the new regression test in all 3 browsers and the corrected origin test. The key function also passed a direct check of 500,000 keys, with 0 format failures and 0 duplicates.

**Performance: 22 of 22 gates passed.** On this run's runner, p95 was 55.1 ms for health, 123.4 ms for products, 211.9 ms for orders and 1,085.7 ms for mixed. Recovery had 0 errors in 460 requests, at `rate==0`. Refusal p95 was 540.6 ms, against a limit of 1,000 ms. Each run landed on different hardware, and mixed p95 moved from 602 to 697 to 1,086 ms over 3 runs, so these gates could occasionally fail on a slow runner.

**Docker:** images built, both stacks became healthy, migrations and seeding worked, and a record survived a restart.

**Artifacts:** 2 artifacts, with 9 JSON files, and no traces, screenshots, videos or HTML report, because nothing failed. Text scans of these and all job logs found 0 credentials.

**The sanitizer fix has been verified locally only.** It runs only when a test fails, and nothing failed. Locally, it kept all 6 real traces, with 0 credential hits. The only sanitized upload on GitHub so far came before the fix, in the second run, and its 19 screenshots and 38 videos have not been reviewed one by one.

## Why the npm count changed from 13 to 9

The project did not change: `package-lock.json` is identical across all three CI runs, and has not changed since `c1e1ce5`. The first run reported 13 moderate findings, and the next two reported 9. A fresh local audit now also reports 9.

**The advisory was narrowed.** [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) first covered every `minimatch` below 11.0.1. Its record now reads `>= 7.0.0, < 11.0.1`, and was last updated on 2026-11-04 at 16:50 UTC. So `minimatch` 5.1.9, used by `@redocly/openapi-core`, is no longer affected, which removes 4 findings: `@redocly/openapi-core`, `openapi-typescript`, `@eslint-community/eslint-utils` and `eslint-plugin-playwright`. **The other 9 are unchanged, and nothing was fixed.** `minimatch` 10.2.6, through ESLint and `typescript-eslint`, is still in range.

The first CI run came after that update and still reported 13. That suggests npm's audit data lagged, but this is an inference, because npm's data history cannot be seen.

## First GitHub Actions run

[Run 41883893976](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41883893976), commit `2ad4bf0`, ubuntu-24.04, Linux on 2 cores, retries off. **It failed: 11 of 14 jobs succeeded, and the final gate is red, because 3 jobs failed.**

| Job | Result | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- | --- |
| TypeScript and ESLint | Success | n/a | | | |
| CI and Docker policy | **Failure** | n/a | | | |
| Ruff and backend pytest (97% coverage) | Success | 197 | 0 | 0 | n/a |
| AI tests and offline evaluation | Success | 350 | 0 | 0 | n/a |
| Chromium, plus framework checks | Success | 64 + 6 | 0 | 0 | 0 |
| **Firefox** | Success | **64** | 0 | 0 | 0 |
| WebKit | Success | 64 | 0 | 0 | 0 |
| Accessibility 82, keyboard Firefox 33, keyboard WebKit 33 | Success | 148 | 0 | 0 | 0 |
| API 154, contract 100 | Success | 254 | 0 | 0 | 0 |
| PostgreSQL 44, security 114, reliability 5 | Success | 163 | 0 | 0 | 0 |
| Performance gates, short | **Failure** | 21 of 22 gates | 1 | | |
| Docker build and tests | **Failure** | Smoke passed, and suites did not run | | | |
| Dependency audit and secret scan | Success | n/a | | | |
| All checks passed (gate) | **Failure** | | | | |

**This is the first time Firefox has run these tests, and all 97 passed (64 browser and 33 keyboard), in Firefox 157 on Linux.** On macOS it still cannot launch. All of this is from one run.

| Failure | Cause | Type | Fix |
| --- | --- | --- | --- |
| Policy | `hadolint` exits 1 on info-level notes, and I had wrongly said no macOS build existed, so it was never run before pushing | Infrastructure | Merged two `RUN` lines. One note suppressed, with its reason. hadolint now installs on macOS |
| Docker | `--abort-on-container-exit` stopped the stack when `migrate` succeeded, so the suites never ran | Test infrastructure | The stack and runner now start separately, with container logs on failure. **Unverified without Docker** |
| Performance | 4 of 466 recovery-stage requests got a 503. The short scenario's compressed ramp-down left the queue full. Reproduced on macOS under CPU load in 3 of 3 attempts, with 1 to 4 errors, all within 10 ms of the stage starting | Test design | A 5-second drain before recovery is measured, with `rate==0` unchanged. Then 3 of 3 attempts passed under the same load |

No application defect was found. Normal-load Linux p95: health 30.5 ms, products 78.4 ms, orders 141.2 ms, mixed 602 ms, all within the CI limits. Refusal gates passed, and connections returned to 10 idle.

**Artifacts and logs:** only 2 artifacts were uploaded, with 9 JSON files in total, because no test failed. No trace, screenshot, video or HTML report was uploaded, so **the sanitized failure upload has not yet been exercised on GitHub.** Scans of those files and all job logs found 0 seed passwords, session cookies, keys, tokens, authorization headers or passwords in database URLs. gitleaks found nothing in the artifacts. Artifacts expire on 2026-11-18.

## Second GitHub Actions run

[Run 41893657050](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41893657050), commit `86a8843`, 18m 10s from start to finish, about 62 job minutes. **It failed: 12 of 14 jobs succeeded. Only the Docker job failed, which also failed the final gate.** The suites ran in Docker for the first time.

| Native Linux job | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- |
| Backend | 197 | 0 | 0 | n/a |
| AI | 350 | 0 | 0 | n/a |
| Chromium, plus framework | 64 + 6 | 0 | 0 | 0 |
| Firefox | 64 | 0 | 0 | 0 |
| WebKit | 64 | 0 | 0 | 0 |
| Accessibility 82, keyboard Firefox 33, keyboard WebKit 33 | 148 | 0 | 0 | 0 |
| API 154, contract 100 | 254 | 0 | 0 | 0 |
| PostgreSQL 44, security 114, reliability 5 | 163 | 0 | 0 | 0 |
| Performance | 22 of 22 gates, with recovery at `rate==0` and 0 errors in 475 requests | | | |

| In Docker, 2 workers, retries off | Passed | Failed |
| --- | --- | --- |
| Framework | 6 | 0 |
| Chromium | 60 | 4 |
| Firefox | 60 | 4 |
| WebKit | 60 | 4 |
| Accessibility | 79 | 3 |
| Keyboard Firefox | 31 | 2 |
| Keyboard WebKit | 31 | 2 |
| API | 154 | 0 |
| PostgreSQL | 44 | 0 |
| Security | 113 | 1 |
| Reliability | 5 | 0 |
| **Total of 663** | **643** | **20** |

0 skipped and 0 flaky. The runner exited non-zero, and the job step exited 1. The `contract` project does not run in Docker.

| Failure | Cause | Type | Fix |
| --- | --- | --- | --- |
| 19 payment tests, in all browsers | **`crypto.randomUUID` does not exist on plain HTTP away from localhost, so the Run payment button threw and sent nothing.** Only Docker's `http://web:8080` exposed it | **Application bug** | Generate the key with `crypto.getRandomValues`, which works everywhere. A new test failed before the fix and passes after |
| 1 security test | It hard-coded `http://localhost:5273` as the app's origin | Test defect | Use the configured origin |
| 19 of 20 sanitized traces dropped | Error context in a trace is stored with no file extension, so it was treated as binary. It held a source excerpt with a seed password, so the leak check dropped the trace | Sanitizer. It failed safe, but lost evidence | Detect text by content. All 6 traces from 4 real local runs were then kept, with 0 credential hits |

**The fixes were then pushed, and passed in [the first green run](#first-green-github-actions-run), except that the sanitizer fix was not exercised, because nothing failed.**

**Artifacts:** `failure-docker-41893657050-1`, 18.2 MB, was the first real sanitized upload, with 20 error contexts, 19 screenshots, 38 videos and 1 trace, and no HTML report or raw `test-results`. A scan of its contents, inside the trace too, and of all job logs and other artifacts found 0 seed passwords, session cookies, keys, tokens, authorization headers or database passwords. It found **1 synthetic test password** (`E2E-Long-Password-1`) in the one kept trace, a test value that is already in this repository. The same fix covers it. Screenshots and videos were not reviewed one by one. Artifacts expire on 2026-11-18.

## WebKit soak

[Run 41909199483](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41909199483), the first attempt, ended after 50 seconds with **0 jobs and 0 tests.** GitHub's annotations gave `Unexpected value '5'` at lines 24 and 36, column 20, which are the `repeat-each` inputs of the two jobs. A manual input reached a `type: number` input as a string. `actionlint` did not catch it, and normal CI never passes that input.

[Run 41913178899](https://github.com/Dileep5/testforge-ai-sdet-automation/actions/runs/41913178899), after the fix, passed **650 of 650**. Its count gate required 325 per job, and each job met that exactly. Nothing failed, so no artifacts were uploaded, and a text scan of its logs found 0 credentials.

## Status of what remains

| Item | Status |
| --- | --- |
| Sanitizer fix on GitHub | **Not exercised**, because nothing has failed since. Verified locally |
| Browser install mitigation | **Prepared, and has not run on GitHub** |
| Live LLM evaluation | **Not run** |

## CI simulation on macOS

**This is not CI.** A fresh copy, with the commands from the workflows, `CI=1`, `EXTERNAL_POSTGRES=1`, 2 workers and retries off, against a separate new PostgreSQL on port 55432. The development cluster was stopped throughout. It ran before the last two fixes below, which were verified separately.

| Job's commands | Passed | Failed | Skipped | Flaky |
| --- | --- | --- | --- | --- |
| Backend | 197 | 0 | 0 | n/a |
| AI | 348 | 0 | 0 | n/a |
| `api-contract` | 254 | 0 | 0 | 0 |
| `database-security` | 163 | 0 | 0 | 0 |
| `chromium` | 70 | 0 | 0 | 0 |
| `webkit` | 64 | 0 | 0 | 0 |
| `accessibility`, without Firefox | 115 | 0 | 0 | 0 |
| `performance`, normal and overload | Exit 0 | | | |

## Artifact retention

Verified with `ai/triage-corpus/artifact-check.spec.ts`, which fails on purpose after typing a real password.

| Check | Result |
| --- | --- |
| Run twice | The first run's folder remained, with an identical `trace.zip` hash |
| Evidence kept | Trace, screenshot, video, error context, JUnit, JSON, and diagnostics with 2 console errors and the 500 response |
| Raw versus sanitized, over 3 real traces | Password hits 28 versus **0**. Cookie hits 111 versus **0** |
| Trace viewer | Playwright's viewer opens the sanitized trace with the same actions. The raw one shows the password in an action title, and the sanitized one does not |
| Triage on the sanitized copy | Still classified correctly from its evidence |
| Real failures | Sanitized the 2 real failures below, with evidence retained |

**One sanitizer gap was found by scanning real output.** Traces also bundle test source files, which held 2 synthetic passwords that the first version missed. Those files are now treated as text, and the leak check fails closed on the seed passwords.

## Dependency and secret scans

| Scan | Result |
| --- | --- |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit`, development tools | 9 moderate, from 1 advisory (13 before it was narrowed). None high or critical. See [CI_CD.md](CI_CD.md#dependency-findings) |
| `pip-audit` on both lock files | No known vulnerabilities |
| gitleaks over all 5 commits, and each source folder | No leaks, after allow-listing exact synthetic values. It first flagged 2 synthetic test passwords, which were checked by hand |

These scanners only know about published advisories and known secret shapes, so a clean result does not prove there are none.

## k6 summary

Normal load, default configuration. These numbers describe one laptop and are not capacity figures. Environment, workloads and overload
comparison are in [PERFORMANCE.md](PERFORMANCE.md).

| Scenario | VUs | Requests | Req/s | p50 ms | p95 ms | p99 ms | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Health and readiness | 20 | 94,518 | 3,150 | 5.7 | 10.8 | 14.2 | 0% |
| Product listing | 20 | 36,700 | 918 | 20.4 | 26.6 | 30.0 | 0% |
| Order lookup and filtering | 20 | 20,075 | 502 | 36.7 | 51.0 | 65.1 | 0% |
| Authentication | 10 | 3,315 | 111 | 66.2 | 222.5 | 274.3 | 0% |
| Order creation, isolated users | 10 | 12,606 | 317 | 31.1 | 36.6 | 50.0 | 0% |
| Mixed read and write | 30 | 24,628 | 379 | 66.3 | 121.5 | 157.4 | 0% |

| Overload, peak of 800 VUs | Unbounded queue | Bounded at 200 |
| --- | --- | --- |
| Served | 22,092 | 21,533 |
| Served p95 | 4,777 ms | 2,445 ms |
| Client timeouts after 5s | 2,660 | 0 |
| Refused with 503 | 0 | 34,598, p99 2.0 ms |

## Parallel and isolation runs

| Run | Workers | Passed | Failed | Skipped | Flaky | Duration |
| --- | --- | --- | --- | --- | --- | --- |
| Everything except Firefox, together, latest | 4 | 668 | 0 | 0 | 0 | 1.7m |
| Everything except Firefox, together, before the keep-alive fix | 8 | 666 | 0 | 0 | 0 | 3.8m |
| WebKit, Chromium, API and security together, 3 times, before the fix | 8 | 396 each | 0 | 0 | 0 | 2.0 to 3.5m |
| WebKit, each test 5 times, before the fix | 4 | 318 | **2** | 0 | 0 | 5.0m |
| WebKit, each test 5 times, after the fix, twice | 4 | 320 each | 0 | 0 | 0 | 2.9 and 3.5m |
| Accessibility and keyboard, each test 3 times (Phase 4, not rerun) | 4 | 336 | 0 | 0 | 0 | 117s |
| Smoke, Chromium | 4 | 15 | 0 | 0 | 0 | 10s |
| Critical, Chromium and WebKit | 4 | 64 (32 each) | 0 | 0 | 0 | 1.1m |

`reliability` always runs one test at a time, whatever the worker count.

## The intermittent WebKit failure: unresolved

**The cause is not established.** Failed browser tests now keep a trace, screenshot, video, error context, and a `diagnostics` attachment with the test title, project,
browser version, worker, retry, duration, console errors, page errors, failed requests and error responses. A deliberate failure confirmed these in both browsers.

| Attempt | Result |
| --- | --- |
| WebKit alone, 15 runs of 58 tests | 870 passed, 0 failed |
| WebKit, Chromium, API and security together, 8 workers, 5 runs | 1,844 passed, **1 failed** |
| Instrumented probe of the suspected race, 240 attempts, half with a response deliberately timed against typing | 0 reproductions |

The one failure was in WebKit, in `the low stock filter shows a low row and leaves out a healthy one`. What the evidence shows:

- `fill` reported success, but the DOM snapshot straight after it shows an empty search box, as does the failure screenshot.
- The warehouse dropdown rendered during that same fill.
- The empty form then matched the URL, so clicking Search sent no request, and the test timed out waiting for one.
- There were no console errors, page errors, failed requests or error responses.

**This does not separate an application race from a WebKit or Playwright input problem.** It is also unknown whether this is the same failure as the unidentified one in Phase 3. Search page objects now assert the
typed value right after filling, so a recurrence fails at the point of loss. No retry was added.

**Update:** the trace, screenshot and video from that failure no longer exist, because Playwright cleared `test-results/` on a later run. Only its JSON report entry survives. Each run now keeps its own folder, so this cannot happen again. The triage tool classifies this failure as timing, medium confidence, with review required, which is not a root cause.

**Since then:** WebKit ran about 1,150 more times on macOS, and 650 more on Linux in the soak, plus the normal CI runs. **This input failure did not recur, so its root cause remains unknown.** Two other failures occurred, with a different and now fixed cause, listed below. The soak does not reproduce the original conditions, which were macOS, 8 workers and mixed suites.

## Intermittent failures found in Phase 3

Single passes were not enough here. Repeated runs exposed these, and each is now fixed at its cause.

| Failure | Cause | Type |
| --- | --- | --- |
| A product appeared twice in the order form | Offset pages shifting mid-read | **Application defect** |
| Expired-session browser test timed out | The test aged the session while page requests were in flight | Test defect, from Phase 2 |
| `SESSION_EXPIRED` test received `INVALID_SESSION` | The test aged a shared user's session, and another worker's login removed it | Test defect |
| `ECONNRESET` with 101 fillers | Bulk setup opened too many connections at once | Test defect |

**One failure was not identified.** A single WebKit test failed in one Phase 3 run before failure details were
being kept. See [the unresolved failure above](#the-intermittent-webkit-failure-unresolved). Timing on other machines and in
CI is untested.

## Firefox

**On Linux, Firefox has passed in every GitHub Actions run since it first ran, most recently 98 tests (65 browser and 33 keyboard). On macOS, Firefox still cannot launch,** so it remains unverified there. The projects are kept and no test is skipped.

Exact failure, for each of the 97 tests (64 browser and 33 keyboard), when Playwright launches the browser:

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

No further macOS workarounds were attempted in Phases 3 or 4.

## Bugs found in Phase 6

| Defect | Found by | Type |
| --- | --- | --- |
| **`ECONNRESET` during test-data cleanup.** Uvicorn closes idle connections after 5 seconds, and a client reusing one at that moment is reset. 2 of 320 WebKit runs failed. At the boundary, a direct test failed 23 of 400 with the default and 0 of 400 with 75 seconds. It may also explain Phase 3's bulk-setup resets, but that was not tested | Repeated WebKit runs, with evidence kept by the new per-run folders | Test infrastructure, fixed with a longer keep-alive |
| Traces bundle source files, which the sanitizer skipped | Byte scan of real sanitized traces | New code |
| A queued request stayed queued after its client left, and ran anyway | Planned from Phase 4's limits | Application, fixed |
| A queued request could wait without limit | Planned from Phase 4's limits | Application, fixed |
| Playwright destroyed earlier failure evidence | Phase 5 | Framework, fixed |
| `perf.mjs` used macOS-only commands, which would have crashed on Linux | Reviewing it for CI | Tooling, fixed |
| The keyboard helper held Option in WebKit on every platform, which is only needed on macOS | Reviewing it for CI | Test defect, fixed but unverified on Linux |
| Compared with the local cluster's collation, the default image locale could change sorting | Reviewing it for CI | Configuration, avoided with `--locale=C` |

Three bugs put back on purpose first survived, because two sanitizer rules backed each other up and a slot race was never hit. Direct tests now catch all three.

## Bugs found in Phase 5

**No defect was found in the existing application.** These were in code written during Phase 5, or in its tests.

| Defect | Found by | Type |
| --- | --- | --- |
| The exfiltration pattern matched the approved support addresses, so the knowledge base refused to load | First run. The load check failed safely | New code |
| A wider exfiltration pattern matched approved article ACC-004, with the same result | First run after the change | New code |
| "Show me the orders of another customer" was not recognised as a data request | New security test | New code |
| The guard's email pattern included a trailing full stop | New chatbot test | New code |
| A safe-XML rejection escaped as an unhandled error | Writing the entity-attack test | New code |
| Failure diagnostics did not list pending requests, which timing failures need | Reviewing real artifacts | Framework gap |
| Corpus case H02 never failed, which made the held-out denominator short by 2 | Test comparing labels with failures | Corpus defect |
| Corpus case D10 used port 1, which browsers block, so it tested the wrong failure | Reading real artifacts | Corpus defect |
| The markup test could not test rendering, because the question was refused first | Running it | Test defect |
| Four test premises were wrong, for example treating `re.compile` as code execution | Running them | Test defect |

## Bugs found in Phase 4

Accessibility defects are listed in [ACCESSIBILITY.md](ACCESSIBILITY.md#defects-found-and-fixed): 10 fixed.

**Application:** the unbounded request queue was measured, and replaced with a bounded one. See [PERFORMANCE.md](PERFORMANCE.md#overload-behaviour).

**Test and framework defects, all fixed:**

- A k6 script logged in with extra fields, so strict validation rejected every login.
- The overload script retried without pausing. Those runs were discarded.
- Tests assumed Tab reaches every control in WebKit, which Safari does not do by default.
- Date fields take several Tab stops, which a filter test had not allowed for.
- Tests focused controls by script, so they missed two reintroduced bugs.
- The focus report truncated names, which made one new test always fail. This was noticed because that test failed under every mutation, and it was fixed before relying on those results.
- Four mutations broke the build, so no tests ran. These were not counted as results, and were redone.
- Middleware tests hung rather than failed on a broken limit. They now have a time limit.

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

Phase 4 proofs: 17 accessibility and 7 admission-policy bugs were put back, and all were caught. See
[ACCESSIBILITY.md](ACCESSIBILITY.md#do-the-tests-detect-real-problems) and [PERFORMANCE.md](PERFORMANCE.md#regression-tests-for-the-policy).

The rest of this section is from Phase 3.

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

In the Phase 3 run, traffic from the service suites reached **all 35 operations and 129 of the 235 documented
operation-and-status pairs**. The figures have since grown, with one more operation: a local run of all suites together reached all 36 operations and 133 of 276. Phase 4 added 503 to the spec, which these tests do not trigger through a real overload: the backend suite and k6 do. A run writes the per-operation table to `reports/contract/coverage.md`.

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
| `tests/contract/spec.spec.ts` | 41 | Spec drift, breaking-change rules, the checker itself |
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
| `orders.spec.ts` | 20 | Totals across UI, API and database, stock races, filters, sort, pagination, CSV, status rules |
| `payments.spec.ts` | 7 | Approve, decline, timeout, settlement gates, lost-response replay, key reuse |
| `inventory.spec.ts` | 8 | Search, audited updates, validation, stale edits, focus restoration, low stock |
| `products.spec.ts` | 7 | Filters, numeric sort, exact cents, duplicates, price history, retirement, dashboard |
| `support.spec.ts` | 6 | Citations, refusals, typed instructions, order scope, markup shown as text |
| `framework.spec.ts` | 6 | Read-only database, money helpers, namespaces, safe cleanup, CSV parser. No browser |

Tags: 15 `@smoke`, 32 `@critical`, and every browser test is `@regression`. A test can have several.

## Backend tests

197 test cases, of which three parametrized functions supply 33, and 20 of those cover every disallowed order status
transition, so the raw count overstates distinct scenarios. Deterministic tests cover the bounded admission policy, the queue wait limit and disconnect handling, and one test proves disconnect handling against real uvicorn.

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

## Third-party licences

This project is MIT licensed. No images or packages are published from it, and these are installed or downloaded by whoever runs it. This is a summary of an audit of the lock files, and is not legal advice.

| Item | Licence | How it is used |
| --- | --- | --- |
| npm runtime dependencies: React and React Router, with their dependencies | MIT | In the web app |
| Python runtime dependencies | Mostly MIT, BSD and Apache-2.0 | In the API |
| `psycopg`, `psycopg-binary` | LGPL-3.0 | Unmodified database driver, installed from PyPI |
| `caniuse-lite` | CC-BY-4.0 | Development build data |
| Some development tools, such as `lightningcss` | MPL-2.0 | Development only, unmodified |
| k6 | AGPL-3.0 | Downloaded by a script to run tests, and never redistributed |
| hadolint | GPL-3.0 | Downloaded in CI and locally to lint, and never redistributed |
| PostgreSQL, nginx, Playwright and Python base images | Their own licences | Pulled at build time, and images built from them are not published |

Anyone publishing the Docker images would need to review the licences of what those images contain.

## Known limitations

**Testing**

- **Firefox is verified on Linux only.** It cannot launch on the development Mac.
- **Limited CI history.** Two fully green runs and one soak, on one day. See [the latest evidence](#latest-verified-evidence).
- **One WebKit failure is unresolved,** as described above.
- **No live LLM has been called.** Offline chatbot results measure keyword retrieval and rules, and it scored 0/8 on held-out paraphrases. See [AI_EVALUATION.md](AI_EVALUATION.md#limitations).
- **Accessibility is not proven by these tests.** No screen reader was used. See [ACCESSIBILITY.md](ACCESSIBILITY.md#limitations).
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

- **The overload bound refuses requests that a patient client could have waited for.** The trade-off and other
  limits are in [PERFORMANCE.md](PERFORMANCE.md#limitations).
- **More than about 128 simultaneous new connections can be reset by macOS** before the API accepts them. Linux runners report a listen queue of 4096, though bursts that large have not been measured there.
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

- **`npm audit` reports 9 moderate findings, all dev tools.** They come from one `minimatch` advisory, through ESLint and `typescript-eslint`. See [CI_CD.md](CI_CD.md#dependency-findings).
- **`embedded-postgres` carries a `-beta` version tag,** though it wraps a PostgreSQL 17.11 release. It is for local
  development only. Its Linux and Intel paths in `scripts/db-local.sh` are untested, because CI uses a PostgreSQL container.
- **The test role `testforge_e2e_reader` lives in the local PostgreSQL cluster,** created by Playwright's global setup.
  It has no privileges on development tables.
