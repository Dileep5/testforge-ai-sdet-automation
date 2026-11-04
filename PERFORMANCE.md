# Performance Testing

Measurements from k6 against the real local API. **These numbers describe one laptop running everything at once. They are
not capacity figures, and must not be compared with production targets.**

## Test environment

| Item | Value |
| --- | --- |
| Machine | MacBook Air, Apple M3, 8 cores, 8 GB, fanless |
| Operating system | macOS 27.0.1, listen queue `kern.ipc.somaxconn` 128 |
| Load generator | k6 v2.3.0, on the same machine |
| API | One uvicorn process, access log off, Python 3.13.5 |
| Database | PostgreSQL 17.11, dedicated `testforge_perf`, reseeded before each scenario |
| PostgreSQL settings | `max_connections` 100, `shared_buffers` 128MB, `work_mem` 4MB, `effective_cache_size` 4GB, `synchronous_commit` on, `fsync` on |
| API pool | 10 connections plus 20 overflow, 40 worker threads |
| Conditions | Date 2026-11-04. On AC power, battery low and charging, other desktop apps open |

Because k6, the API and PostgreSQL share one machine, k6 competes with what it measures.

**The machine's speed varies.** During this work, `/health` throughput dropped from about 3,200 to 1,200 req/s for a while with no
code change. Each scenario therefore starts with a fixed CPU calibration, and results are only compared when it matches. In the
runs below it stayed between 30.4 and 32.3 ms. Load average at the start of each scenario varied more, from 2.4 to 11.4.

## Commands

```bash
npm run perf:install                                   # pinned k6 in .local/k6, checksum verified
npm run perf                                           # all scenarios
npm run perf -- products orders                        # some scenarios
npm run perf -- --label mine overload                  # choose the report folder
PERF_PEAK_VUS=800 npm run perf -- overload             # a higher overload peak
MAX_QUEUED_REQUESTS=100000 npm run perf -- overload    # effectively unbounded, for comparison
PERF_SCALE=0.1 npm run perf                            # short check that the scripts work
```

Results are written to `reports/performance/<label>/<scenario>.json`, which is not committed. The runner refuses any database whose name
does not end in `_perf`.

## Workloads

| Scenario | Model | Virtual users | Duration | Traffic |
| --- | --- | --- | --- | --- |
| `health` | Constant | 20 | 30s | `/health`, `/ready` |
| `products` | Ramp, hold, ramp | 20 | 40s | List, sort, search, categories |
| `orders` | Ramp, hold, ramp | 20 | 40s | List, filters, detail |
| `auth` | Constant | 10 | 30s | Login, me, logout. Includes Argon2 hashing |
| `order-create` | Constant | 10 | 40s | Each user has its own login, customer and product. Create, then cancel |
| `mixed` | Ramp, hold, ramp | 30 | 65s | 70% of iterations read. 30% create, pay and cancel, a third of those on one shared hot product |
| `overload` | Before, peak, after | 10, then 300 or 800, then 10 | About 155s or 205s | 80% product lists, 20% simulated gateway timeouts that hold a slot for 1s |

These are closed-loop users with no think time, so each sends its next request as soon as the last finishes. Virtual users are not comparable to
real users.

**Respecting the 128-connection queue:** the overload peak ramps at 10 new connections per second. Established connections wait in the API's queue, not the
operating system's. Clients give up after 5 seconds, and back off for `Retry-After` plus up to 1 second of jitter after a failure.

## Results under normal load

The default configuration, with the queue limited to 200. **No scenario had a failed request or a 503.**

| Scenario | Requests | Req/s | p50 ms | p95 ms | p99 ms | Errors | Statuses | Peak DB connections |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `health` | 94,518 | 3,150 | 5.7 | 10.8 | 14.2 | 0% | 200: 94,518 | 14 |
| `products` | 36,700 | 918 | 20.4 | 26.6 | 30.0 | 0% | 200: 36,700 | 26 |
| `orders` | 20,075 | 502 | 36.7 | 51.0 | 65.1 | 0% | 200: 20,075 | 26 |
| `auth` | 3,315 | 111 | 66.2 | 222.5 | 274.3 | 0% | 200: 2,210, 204: 1,105 | 13 |
| `order-create` | 12,606 | 317 | 31.1 | 36.6 | 50.0 | 0% | 200: 6,308, 201: 6,298 | 13 |
| `mixed` | 24,628 | 379 | 66.3 | 121.5 | 157.4 | 0% | 200: 15,434, 201: 9,194 | 30 |

In each, connections settled at 10 idle afterwards, with none idle in transaction. No pool timeouts were logged.

### Did bounding the queue change normal load?

No meaningful change was measured. Each pair ran one after the other, with the same code and only the queue limit changed.

| Scenario | Bounded req/s | Unbounded req/s | Bounded p95 ms | Unbounded p95 ms |
| --- | --- | --- | --- | --- |
| `health` | 3,150 | 3,251 | 10.8 | 10.5 |
| `products` | 918 | 919 | 26.6 | 26.7 |
| `orders` | 502 | 505 | 51.0 | 51.3 |
| `auth` | 111 | 99 | 222.5 | 243.9 |
| `order-create` | 317 | 318 | 36.6 | 36.0 |
| `mixed` | 379 | 389 | 121.5 | 119.9 |

These are single runs, and differences of this size are within the noise seen here. The `auth` pair differed most, and its unbounded run started with a higher load average
(8.9 against 3.7).

## Overload behaviour

### What the unbounded queue did

At 300 virtual users it held up: no errors, but median latency rose from about 14 ms to 1.6 s. At 800, the queue's wait reached the clients' 5-second patience. In the final 40 seconds of the
peak, 25% to 37% of requests in each 10-second window timed out after a full 5 seconds. The server still did the work for clients that had left. Slow payments suffered most. There was no deadlock, and it
recovered within seconds once load fell, so the problem was slow failure and wasted capacity, not a crash.

That justified a bound.

### The policy

`ConcurrencyLimitMiddleware` admits 30 requests, one per database connection, queues up to 200 in arrival order, and answers everything else immediately with a `503`, the standard error envelope,
code `OVERLOADED`, and `Retry-After: 1`. A refused request runs nothing, so retrying a write is safe. `/health` is exempt. The limit is set by `MAX_QUEUED_REQUESTS`.

**Why 200:** sustained throughput on this mix was about 170 req/s, so 200 places is about 1.2 seconds of wait. That is well inside the 5-second client timeout. With only slow requests it would be about 6.7 seconds (200 ÷ 30 per second). That
figure is calculated, not measured. The number is a judgement for this workload on this machine.

### Results during the peak

Each pair ran one after the other. Calibration stayed between 30.4 and 31.3 ms.

| 800 virtual users, peak only, 144s | Unbounded | Bounded at 200 |
| --- | --- | --- |
| Requests served | 22,092 (152.6/s) | 21,533 (149.3/s) |
| Served: p50, p95, p99, max | 3,142, 4,777, 4,957, 5,000 ms | 1,284, 2,445, 2,941, 3,066 ms |
| Client timeouts after 5s | **2,660** | **0** |
| Refused with 503 | 0 | 34,598 |
| Refusal: p50, p95, p99, max | n/a | 0.2, 0.9, 2.0, 34.9 ms |
| Slow payments completed, whole run | 3,204 | 4,598 |
| Slow payments timed out, whole run | 1,612 | 0 |
| Failure rate, counting 503s and timeouts | 10.75% | 61.64% |

| 300 virtual users, peak only, 94s | Unbounded | Bounded at 200 |
| --- | --- | --- |
| Requests served | 14,089 (149.5/s) | 13,754 (145.6/s) |
| Served: p50, p95, p99, max | 1,632, 3,184, 3,477, 4,509 ms | 1,205, 2,716, 2,974, 3,028 ms |
| Client timeouts after 5s | 0 | 0 |
| Refused with 503 | 0 | 3,069 |
| Failure rate | 0% | 18.24% |

**Read the failure rate with care.** Bounding does not create capacity. Throughput of served requests was similar or slightly lower in both pairs. What changes is how excess demand fails: a sub-millisecond refusal instead of a 5-second wait for
nothing.

**The trade-off is real.** At 300 virtual users, the unbounded queue served everything within the clients' patience, while the bound refused 18% of requests that would have succeeded, at the cost of about 3,000 fast 503s. Those clients must
retry. A larger queue suits clients that will wait, and a smaller one suits those that will not.

### Recovery

| Check, after the peak | 800: unbounded | 800: bounded | 300: unbounded | 300: bounded |
| --- | --- | --- | --- | --- |
| Traffic after, p50 and p95 ms | 12.7, 1,049 | 14.3, 1,050 | 14.2, 1,056 | 14.1, 1,051 |
| Traffic before, p50 and p95 ms | 14.3, 1,051 | 14.4, 1,051 | 14.3, 1,051 | 14.3, 1,052 |
| Errors after | 0% | 0% | 0% | 0% |
| `/ready` after load | 17 ms | 21 ms | 10 ms | 22 ms |
| Connections after, idle in transaction | 10, 0 | 10, 0 | 10, 0 | 10, 0 |
| Server errors or pool timeouts logged | 0 | 0 | 0 | 0 |

The p95 of about 1,050 ms is the workload: 20% of this traffic is the simulated 1-second gateway delay. No deadlock and no connection leak were observed.

### Regression tests for the policy

`apps/api/tests/test_concurrency_limit.py` uses no timing: it counts admissions exactly. It covers exact admit, queue and refuse counts, the 503's envelope and headers, arrival order, full recovery, giving up a place on cancellation, exempt paths, and slot release after failure. A live
test confirms a real server refuses cleanly and returns every connection. All 7 deliberately reintroduced bugs were caught.

## Quality gates

Phase 6 added pass or fail thresholds in `performance/thresholds.js`. **They catch large regressions on a known machine. They are not service level objectives, and passing says nothing about production.** Limits are about 3 times what this laptop measured (`PERF_PROFILE=local`), or looser on shared runners (`PERF_PROFILE=ci`). `PERF_P95_MS` overrides any p95 limit. `npm run perf` exits non-zero if a threshold fails, and an impossible limit confirmed this.

| Scenario | p95 limit, local | p95 limit, CI | Measured p95 |
| --- | --- | --- | --- |
| Health and readiness | 50 ms | 500 ms | 10.9 ms |
| Product listing | 100 ms | 1,000 ms | 28.5 ms |
| Order lookup | 200 ms | 1,500 ms | 53.3 ms |
| Authentication | 800 ms | 3,000 ms | 222.4 ms |
| Order creation | 150 ms | 1,500 ms | 36.9 ms |
| Mixed | 500 ms | 3,000 ms | 123.9 ms |

**Every normal scenario also requires** under 1% failed requests, under 1% 4xx responses and no 5xx responses. All passed on macOS, with 0% errors.

**Overload requires** no 5xx except 503, no client left without a response, some 503s (proving the queue was reached), a 503 p95 under 100 ms, and no failed requests after the peak. All 6 passed at 800 and at 300 virtual users.

**In CI,** the `performance` job runs short versions with a queue of 5 and 60 virtual users. `performance-stress.yml` runs the full set, by hand only. **Shared runners** vary in speed and share hosts, so CI results can fail without a regression, and pass despite one. Limits there are deliberately loose. The Linux listen queue also differs from the macOS limit of 128.

### Bounded wait and disconnected clients

`MAX_QUEUE_WAIT_SECONDS`, default 4, limits how long a request may wait. It then gets the same 503. A queued request whose client disconnects now leaves the queue, and never runs. A test against real uvicorn proves this, which corrects Phase 4's statement that it could not be detected. Neither case has done any work, so both are safe to retry.

| Measured, with the wait limit on and off | 800 VUs, on | 800 VUs, off | 300 VUs, on | 300 VUs, off |
| --- | --- | --- | --- | --- |
| Served | 21,346 | 21,341 | 13,361 | 13,653 |
| Served p95 | 2,477 ms | 2,508 ms | 2,593 ms | 2,653 ms |
| Longest served | 3,079 ms | 3,235 ms | 3,105 ms | 3,132 ms |
| Refused with 503 | 34,536 | 34,496 | 3,046 | 3,047 |
| 503 p95 | 1.2 ms | 1.1 ms | 1.2 ms | 1.0 ms |
| Client timeouts | 0 | 0 | 0 | 0 |

**The wait limit changed nothing measurable, because it never fired:** the longest wait stayed near 3 seconds, as the 200-place queue already bounds it for this mix. It is a backstop for a slower workload, such as all requests holding a slot for a second, and is calculated rather than measured to matter there. Disconnect handling was not separately measured under load.

**The trade-off remains.** At 300 virtual users, about 19% of overload-stage requests got a fast 503, though Phase 4 showed a queue with no limit would have served them within the client's patience. A short limit protects clients that give up quickly. Clients that retry after `Retry-After` and can wait may do better with a longer queue. These numbers cannot choose the right value for production.

## Discarded runs

Two sets of measurements were thrown out, and neither appears above.

1. **The first overload script was flawed.** A failed login retried immediately with no pause, creating about 330,000 connection attempts that were reset in 0 ms (k6 error 1220). That measured the operating system's connection queue, not the API. The script now backs off.
2. **A slow period on the machine.** `/health` fell to 1,205 req/s, with the same code. This is what prompted the calibration.

## Limitations

- **One machine, single runs.** There are no confidence intervals, and repeatability has only been checked by eye between paired runs.
- **Not a soak test.** The longest run is under 4 minutes, so slow leaks would not appear.
- **Not realistic users:** no think time and few distinct sessions. The data set is small, about 60 orders and 24 products, plus what each scenario creates, so query plans on larger data are untested.
- **More than about 128 simultaneous new connections can be reset by the operating system on this machine** before the API sees them. The bound does not address this. Linux behaviour has not been measured.
- **The wait limit has not been seen working under real load.** It is proven by deterministic tests only, because no measured workload waited 4 seconds.
- **A request that has been admitted is not cancelled when its client leaves.** Only queued requests are. Bodies above 1 MB stop being watched while queued.
- **The limit is per process.** Several API processes would need their database connections divided between them.
- **The API has no per-client fairness or rate limiting.** One client can fill the queue.
- **`/ready` queues like other requests,** and answers 503 under overload. A load balancer would stop sending traffic, which may or may not be wanted.
