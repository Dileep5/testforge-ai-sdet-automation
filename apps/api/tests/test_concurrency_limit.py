"""Runs against a real server, because the in-process test client cannot reproduce this failure."""

import asyncio
import json
import socket
import threading
import time
from collections import Counter
from collections.abc import Iterator

import httpx2 as httpx
import pytest
import uvicorn

from app.config import get_settings
from app.db import MAX_CONNECTIONS, engine
from app.main import create_app
from app.middleware import ConcurrencyLimitMiddleware
from tests.conftest import API, PASSWORD

SHORT_QUEUE = 5
# Far above the 30 connections and 40 threads, plus a queue of SHORT_QUEUE.
OVER_CAPACITY = 100
# Above the connections and threads, but within what the queue accepts.
WITHIN_QUEUE = 150


def _serve() -> Iterator[str]:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="critical")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture
def live_server() -> Iterator[str]:
    yield from _serve()


@pytest.fixture
def short_queue_server(monkeypatch) -> Iterator[str]:
    # A short queue reaches overload with a burst small enough for the operating system's listen
    # queue (128 on macOS), so what is measured is the API's refusal, not a reset connection.
    monkeypatch.setattr(get_settings(), "max_queued_requests", SHORT_QUEUE)
    yield from _serve()


def _burst_client(base_url: str, cookies) -> httpx.AsyncClient:
    # No client-side connection limit, so every request reaches the server at once.
    return httpx.AsyncClient(
        base_url=base_url,
        cookies=cookies,
        timeout=20,
        limits=httpx.Limits(max_connections=None, max_keepalive_connections=None),
    )


def _login(base_url: str, user) -> httpx.Cookies:
    response = httpx.post(
        f"{base_url}{API}/auth/login", json={"email": user.email, "password": PASSWORD}
    )
    assert response.status_code == 200
    return response.cookies


async def _outcome(client: httpx.AsyncClient, path: str) -> int | str:
    try:
        return (await client.get(path)).status_code
    except httpx.TimeoutException:
        return "timeout"


def _burst(live_server, world, count: int) -> Counter:
    async def run() -> list[int | str]:
        async with _burst_client(live_server, _login(live_server, world.manager)) as client:
            return await asyncio.gather(
                *(_outcome(client, f"{API}/products") for _ in range(count))
            )

    return Counter(asyncio.run(run()))


def _assert_connections_return() -> None:
    # A request returns its connection just after its response is sent, so give that a moment.
    # A leak would never reach zero, and this fails.
    deadline = time.monotonic() + 5
    while engine.pool.checkedout() > 0:
        assert time.monotonic() < deadline, f"{engine.pool.checkedout()} connections not returned"
        time.sleep(0.01)


def test_burst_above_pool_capacity_does_not_stall_the_api(live_server, world):
    # Regression: each request held a connection while waiting for a worker thread, while the
    # threads waited for a connection. The whole API froze until the 30 second pool timeout.
    assert _burst(live_server, world, WITHIN_QUEUE) == {200: WITHIN_QUEUE}


def test_overload_is_refused_quickly_and_the_api_recovers_without_leaking(
    short_queue_server, world
):
    outcomes = _burst(short_queue_server, world, OVER_CAPACITY)
    # Every request gets a real answer: no timeouts, no pool errors, and some work still done.
    assert set(outcomes) == {200, 503}
    assert outcomes[200] >= MAX_CONNECTIONS
    assert sum(outcomes.values()) == OVER_CAPACITY

    _assert_connections_return()
    cookies = _login(short_queue_server, world.manager)
    client = httpx.Client(base_url=short_queue_server, cookies=cookies)
    assert client.get(f"{API}/products").status_code == 200
    _assert_connections_return()


def test_health_answers_even_when_request_slots_are_full(live_server, world):
    # Liveness must not queue behind business traffic, or a busy server looks dead.
    async def run() -> tuple[int, float, list[int | str]]:
        async with _burst_client(live_server, _login(live_server, world.manager)) as client:
            load = [
                asyncio.create_task(_outcome(client, f"{API}/products"))
                for _ in range(WITHIN_QUEUE)
            ]
            await asyncio.sleep(0)
            started = time.monotonic()
            health = await client.get(f"{API}/health")
            elapsed = time.monotonic() - started
            return health.status_code, elapsed, await asyncio.gather(*load)

    status, elapsed, outcomes = asyncio.run(run())
    assert status == 200
    assert elapsed < 2
    assert Counter(outcomes) == {200: WITHIN_QUEUE}


def test_the_api_admits_no_more_requests_than_it_has_database_connections():
    # The deadlock needs more admitted requests than connections, so this bound is the fix.
    limits = [
        (layer.kwargs["limit"], layer.kwargs["max_queued"])
        for layer in create_app().user_middleware
        if layer.cls is ConcurrencyLimitMiddleware
    ]
    assert limits == [(MAX_CONNECTIONS, get_settings().max_queued_requests)]
    assert engine.pool.size() + engine.pool._max_overflow == MAX_CONNECTIONS


def _http_scope(path: str) -> dict:
    return {"type": "http", "path": path}


async def _noop_receive() -> dict:
    # A real server's receive waits here until the client disconnects.
    await asyncio.Event().wait()
    return {"type": "http.disconnect"}


class _Response:
    """Collects what the middleware sends, so a refusal can be inspected."""

    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def __call__(self, message: dict) -> None:
        self.messages.append(message)

    @property
    def status(self) -> int | None:
        return self.messages[0]["status"] if self.messages else None

    @property
    def headers(self) -> dict[bytes, bytes]:
        return dict(self.messages[0]["headers"])

    @property
    def body(self) -> dict:
        return json.loads(self.messages[1]["body"])


class _BlockingApp:
    """Holds every request open until released, so what gets admitted can be counted exactly."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.admitted: list[str] = []
        self.finished = 0
        self.active = 0
        self.peak = 0

    async def __call__(self, scope, receive, send) -> None:
        self.admitted.append(scope.get("path", scope["type"]))
        self.active += 1
        self.peak = max(self.peak, self.active)
        await self.release.wait()
        self.active -= 1
        self.finished += 1


def _run(scenario) -> None:
    # A broken limit would leave requests waiting forever, which must fail, not hang the suite.
    asyncio.run(asyncio.wait_for(scenario, timeout=10))


async def _settle() -> None:
    # Each task only needs the event loop, so a few passes let all of them run as far as they can.
    for _ in range(50):
        await asyncio.sleep(0)


def _start(middleware, path: str = "/x") -> tuple[asyncio.Task, _Response]:
    response = _Response()
    return asyncio.create_task(middleware(_http_scope(path), _noop_receive, response)), response


def _limited(inner, limit: int = 3, max_queued: int = 2, exempt=frozenset(), max_wait: float = 60):
    return ConcurrencyLimitMiddleware(
        inner,
        limit=limit,
        max_queued=max_queued,
        exempt_paths=exempt,
        max_queue_wait_seconds=max_wait,
    )


def test_exactly_the_limit_is_admitted_exactly_the_queue_waits_and_the_rest_are_refused():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner)
        started = [_start(middleware) for _ in range(10)]
        await _settle()

        assert len(inner.admitted) == 3
        assert middleware.queued == 2
        refused = [response for task, response in started if task.done()]
        assert len(refused) == 5
        assert {response.status for response in refused} == {503}

        # What was admitted or queued all completes, and nothing refused ever ran.
        inner.release.set()
        await asyncio.gather(*(task for task, _ in started))
        assert inner.finished == 5
        assert inner.peak == 3

    _run(run())


def test_a_refusal_uses_the_standard_error_envelope_and_invites_a_retry():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=0)
        held, _ = _start(middleware)
        await _settle()
        task, response = _start(middleware)
        await task

        error = response.body["error"]
        assert response.status == 503
        assert set(error) == {"code", "message", "details", "request_id"}
        assert error["code"] == "OVERLOADED"
        assert response.headers[b"x-request-id"].decode() == error["request_id"]
        assert response.headers[b"retry-after"] == b"1"
        assert response.headers[b"x-content-type-options"] == b"nosniff"
        assert response.headers[b"content-type"] == b"application/json"
        inner.release.set()
        await held

    _run(run())


def test_queued_requests_run_in_arrival_order():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=5)
        tasks = [_start(middleware, f"/{index}")[0] for index in range(4)]
        await _settle()
        inner.release.set()
        await asyncio.gather(*tasks)
        assert inner.admitted == ["/0", "/1", "/2", "/3"]

    _run(run())


def test_the_api_recovers_completely_once_overload_ends():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=2, max_queued=1)
        started = [_start(middleware) for _ in range(8)]
        await _settle()
        assert sum(task.done() for task, _ in started) == 5

        inner.release.set()
        await asyncio.gather(*(task for task, _ in started))
        assert middleware.queued == 0
        assert not middleware.slots.locked()

        before = inner.finished
        after = [_start(middleware) for _ in range(3)]
        await asyncio.gather(*(task for task, _ in after))
        assert inner.finished == before + 3
        assert {response.status for _, response in after} == {None}

    _run(run())


def test_a_queued_client_that_disconnects_gives_up_its_place():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=1)
        held, _ = _start(middleware)
        await _settle()
        waiting, _ = _start(middleware)
        await _settle()
        assert middleware.queued == 1

        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        assert middleware.queued == 0

        replacement, response = _start(middleware)
        await _settle()
        assert middleware.queued == 1
        assert response.status is None
        inner.release.set()
        await asyncio.gather(held, replacement)
        assert inner.admitted == ["/x", "/x"]

    _run(run())


def test_exempt_paths_and_non_http_traffic_bypass_a_full_queue():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=0, exempt=frozenset({"/health"}))
        held, _ = _start(middleware)
        await _settle()
        refused, refused_response = _start(middleware, "/y")
        await refused
        assert refused_response.status == 503

        health, health_response = _start(middleware, "/health")
        lifespan = asyncio.create_task(middleware({"type": "lifespan"}, _noop_receive, _Response()))
        await _settle()
        assert health_response.status is None
        assert len(inner.admitted) == 2 + 1  # the held request, /health and the lifespan scope
        inner.release.set()
        await asyncio.gather(held, health, lifespan)

    _run(run())


def test_a_slot_is_released_when_a_request_fails_or_the_client_disconnects():
    async def run() -> None:
        async def failing(scope, receive, send) -> None:
            raise RuntimeError("boom")

        middleware = _limited(failing, limit=1, max_queued=0)
        for _ in range(3):
            with pytest.raises(RuntimeError):
                await middleware(_http_scope("/x"), _noop_receive, _Response())
        assert not middleware.slots.locked()

        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=0)
        held, _ = _start(middleware)
        await _settle()
        held.cancel()
        await asyncio.gather(held, return_exceptions=True)
        assert not middleware.slots.locked()

    _run(run())


def test_a_failed_request_lets_the_next_queued_one_run():
    async def run() -> None:
        calls = []
        gate = asyncio.Event()

        async def first_fails(scope, receive, send) -> None:
            calls.append(scope["path"])
            if len(calls) == 1:
                await gate.wait()
                raise RuntimeError("boom")

        middleware = _limited(first_fails, limit=1, max_queued=1)
        failing, _ = _start(middleware, "/fails")
        await _settle()
        queued, _ = _start(middleware, "/next")
        await _settle()
        gate.set()
        await asyncio.gather(failing, queued, return_exceptions=True)
        assert calls == ["/fails", "/next"]
        assert not middleware.slots.locked()

    _run(run())


def test_a_request_that_waits_too_long_is_refused_and_never_runs():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=5, max_wait=0.05)
        holder = _start(middleware, "/holder")
        await _settle()
        task, response = _start(middleware, "/queued")
        await asyncio.wait_for(task, timeout=2)

        assert response.status == 503
        assert response.body["error"]["code"] == "OVERLOADED"
        assert inner.admitted == ["/holder"]
        assert middleware.queued == 0

        # The refusal cost nothing: the slot still belongs to the holder, and then frees normally.
        inner.release.set()
        await holder[0]
        assert not middleware.slots.locked()

    _run(run())


def test_a_request_admitted_within_the_limit_runs():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=5, max_wait=5)
        holder = _start(middleware, "/holder")
        await _settle()
        task, response = _start(middleware, "/queued")
        await _settle()
        inner.release.set()
        await asyncio.gather(holder[0], task)

        assert response.status is None
        assert inner.admitted == ["/holder", "/queued"]
        assert not middleware.slots.locked()

    _run(run())


def test_a_queued_client_that_leaves_never_runs_and_gets_no_response():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=5)
        holder = _start(middleware, "/holder")
        await _settle()
        left = asyncio.Event()

        async def receive() -> dict:
            await left.wait()
            return {"type": "http.disconnect"}

        response = _Response()
        task = asyncio.create_task(middleware(_http_scope("/gone"), receive, response))
        await _settle()
        assert middleware.queued == 1

        left.set()
        await asyncio.wait_for(task, timeout=2)
        assert middleware.queued == 0
        assert response.messages == []

        inner.release.set()
        await holder[0]
        await _settle()
        assert inner.admitted == ["/holder"]
        assert not middleware.slots.locked()

    _run(run())


def test_a_queued_request_still_receives_its_whole_body_in_order():
    async def run() -> None:
        release = asyncio.Event()
        received: list[dict] = []
        running = 0

        async def inner(scope, receive, send) -> None:
            nonlocal running
            running += 1
            if scope["path"] == "/holder":
                await release.wait()
            else:
                received.append(await receive())
                received.append(await receive())

        middleware = ConcurrencyLimitMiddleware(
            inner, limit=1, max_queued=5, exempt_paths=frozenset(), max_queue_wait_seconds=60
        )
        holder = asyncio.create_task(middleware(_http_scope("/holder"), _noop_receive, _Response()))
        await _settle()
        messages = [
            {"type": "http.request", "body": b"one", "more_body": True},
            {"type": "http.request", "body": b"two", "more_body": False},
        ]

        async def receive() -> dict:
            if messages:
                return messages.pop(0)
            await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        task = asyncio.create_task(middleware(_http_scope("/body"), receive, _Response()))
        await _settle()
        assert messages == []
        release.set()
        await asyncio.gather(holder, task)

        assert [item["body"] for item in received] == [b"one", b"two"]
        assert running == 2

    _run(run())


def test_a_queued_body_too_large_to_hold_stops_being_read_until_admitted():
    async def run() -> None:
        release = asyncio.Event()
        reads = 0

        async def inner(scope, receive, send) -> None:
            if scope["path"] == "/holder":
                await release.wait()

        middleware = ConcurrencyLimitMiddleware(
            inner, limit=1, max_queued=5, exempt_paths=frozenset(), max_queue_wait_seconds=60
        )
        holder = asyncio.create_task(middleware(_http_scope("/holder"), _noop_receive, _Response()))
        await _settle()

        async def receive() -> dict:
            nonlocal reads
            reads += 1
            return {"type": "http.request", "body": b"x" * 600_000, "more_body": True}

        task = asyncio.create_task(middleware(_http_scope("/big"), receive, _Response()))
        await _settle()
        assert reads == 2
        release.set()
        await asyncio.gather(holder, task)

    _run(run())


def test_cancelling_a_queued_request_does_not_lose_a_slot():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = _limited(inner, limit=1, max_queued=5)
        holder = _start(middleware, "/holder")
        await _settle()
        task, _ = _start(middleware, "/queued")
        await _settle()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert middleware.queued == 0

        inner.release.set()
        await holder[0]
        assert not middleware.slots.locked()

    _run(run())


def test_a_slot_granted_at_the_moment_of_a_timeout_is_not_lost():
    async def run() -> None:
        # Release at offsets around the deadline, to land on both sides of the race.
        for offset in (0.0, 0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01, 0.012):
            inner = _BlockingApp()
            middleware = _limited(inner, limit=1, max_queued=5, max_wait=0.006)
            holder = _start(middleware, "/holder")
            await _settle()
            task, _ = _start(middleware, "/queued")
            await asyncio.sleep(offset)
            inner.release.set()
            await asyncio.gather(holder[0], task)
            await _settle()
            assert not middleware.slots.locked(), offset
            assert middleware.queued == 0

    _run(run())


def test_giving_up_on_a_slot_that_was_just_granted_hands_it_back():
    async def run() -> None:
        middleware = _limited(_BlockingApp(), limit=1)
        slot = asyncio.ensure_future(middleware.slots.acquire())
        await _settle()
        assert slot.done()
        assert middleware.slots.locked()

        await middleware._give_up(slot)
        assert not middleware.slots.locked()

    _run(run())


def test_a_real_server_reports_a_disconnect_while_a_request_is_queued():
    """Earlier this was only a documented limit, so it is proven against uvicorn itself."""
    inner_started = threading.Event()
    release = threading.Event()
    ran: list[str] = []

    async def inner(scope, receive, send) -> None:
        ran.append(scope["path"])
        inner_started.set()
        while not release.is_set():
            await asyncio.sleep(0.01)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware = ConcurrencyLimitMiddleware(
        inner, limit=1, max_queued=5, exempt_paths=frozenset(), max_queue_wait_seconds=30
    )
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(middleware, host="127.0.0.1", port=port, log_level="critical")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    def wait_until(condition, label: str) -> None:
        deadline = time.monotonic() + 5
        while not condition():
            assert time.monotonic() < deadline, label
            time.sleep(0.01)

    wait_until(lambda: server.started, "server did not start")
    request = "GET {} HTTP/1.1\r\nHost: x\r\n\r\n"
    holder = socket.create_connection(("127.0.0.1", port))
    queued = socket.create_connection(("127.0.0.1", port))
    try:
        holder.sendall(request.format("/holder").encode())
        assert inner_started.wait(5)
        queued.sendall(request.format("/queued").encode())
        wait_until(lambda: middleware.queued == 1, "request did not queue")

        queued.close()
        wait_until(lambda: middleware.queued == 0, "disconnect was not noticed")

        release.set()
        assert b"200" in holder.recv(1024)
        wait_until(lambda: not middleware.slots.locked(), "slot was not released")
        assert ran == ["/holder"]
    finally:
        release.set()
        holder.close()
        server.should_exit = True
        thread.join(timeout=10)
