"""Runs against a real server, because the in-process test client cannot reproduce this failure."""

import asyncio
import socket
import threading
import time
from collections import Counter

import httpx2 as httpx
import pytest
import uvicorn

from app.db import MAX_CONNECTIONS, engine
from app.main import create_app
from app.middleware import ConcurrencyLimitMiddleware
from tests.conftest import API, PASSWORD

CONCURRENT_REQUESTS = 300


@pytest.fixture
def live_server():
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


def test_burst_above_pool_capacity_does_not_stall_the_api(live_server, world):
    # Regression: each request held a connection while waiting for a worker thread, while the
    # threads waited for a connection. The whole API froze until the 30 second pool timeout.
    async def burst() -> list[int | str]:
        async with _burst_client(live_server, _login(live_server, world.manager)) as client:
            return await asyncio.gather(
                *(_outcome(client, f"{API}/products") for _ in range(CONCURRENT_REQUESTS))
            )

    assert Counter(asyncio.run(burst())) == {200: CONCURRENT_REQUESTS}


def test_health_answers_even_when_request_slots_are_full(live_server, world):
    # Liveness must not queue behind business traffic, or a busy server looks dead.
    async def run() -> tuple[int, float, list[int | str]]:
        async with _burst_client(live_server, _login(live_server, world.manager)) as client:
            load = [
                asyncio.create_task(_outcome(client, f"{API}/products"))
                for _ in range(CONCURRENT_REQUESTS)
            ]
            await asyncio.sleep(0)
            started = time.monotonic()
            health = await client.get(f"{API}/health")
            elapsed = time.monotonic() - started
            return health.status_code, elapsed, await asyncio.gather(*load)

    status, elapsed, outcomes = asyncio.run(run())
    assert status == 200
    assert elapsed < 2
    assert Counter(outcomes) == {200: CONCURRENT_REQUESTS}


def test_the_api_admits_no_more_requests_than_it_has_database_connections():
    # The deadlock needs more admitted requests than connections, so this bound is the fix.
    limits = [
        layer.kwargs["limit"]
        for layer in create_app().user_middleware
        if layer.cls is ConcurrencyLimitMiddleware
    ]
    assert limits == [MAX_CONNECTIONS]
    assert engine.pool.size() + engine.pool._max_overflow == MAX_CONNECTIONS


def _http_scope(path: str) -> dict:
    return {"type": "http", "path": path}


async def _noop_receive() -> dict:
    return {"type": "http.request"}


async def _noop_send(_: dict) -> None:
    return None


class _BlockingApp:
    """Holds every request open until released, so what gets admitted can be counted exactly."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.admitted = 0
        self.peak = 0
        self.active = 0

    async def __call__(self, scope, receive, send) -> None:
        self.admitted += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        await self.release.wait()
        self.active -= 1


async def _settle() -> None:
    # Each admitted task only needs the event loop, so a few passes let all of them run.
    for _ in range(50):
        await asyncio.sleep(0)


def test_exactly_the_limit_is_admitted_and_the_rest_queue_until_a_slot_frees():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = ConcurrencyLimitMiddleware(inner, limit=3, exempt_paths=frozenset())
        tasks = [
            asyncio.create_task(middleware(_http_scope("/x"), _noop_receive, _noop_send))
            for _ in range(10)
        ]
        await _settle()
        assert inner.admitted == 3
        assert inner.peak == 3

        inner.release.set()
        await asyncio.gather(*tasks)
        assert inner.admitted == 10
        assert inner.peak <= 3

    asyncio.run(run())


def test_exempt_paths_and_non_http_traffic_bypass_full_slots():
    async def run() -> None:
        inner = _BlockingApp()
        middleware = ConcurrencyLimitMiddleware(inner, limit=1, exempt_paths=frozenset({"/health"}))
        held = asyncio.create_task(middleware(_http_scope("/x"), _noop_receive, _noop_send))
        await _settle()
        queued = asyncio.create_task(middleware(_http_scope("/y"), _noop_receive, _noop_send))
        health = asyncio.create_task(middleware(_http_scope("/health"), _noop_receive, _noop_send))
        lifespan = asyncio.create_task(middleware({"type": "lifespan"}, _noop_receive, _noop_send))
        await _settle()
        # /x plus the two bypasses are inside; /y is still waiting for the only slot.
        assert inner.admitted == 3
        inner.release.set()
        await asyncio.gather(held, queued, health, lifespan)
        assert inner.admitted == 4

    asyncio.run(run())


def test_a_slot_is_released_when_a_request_fails_or_the_client_disconnects():
    async def run() -> None:
        async def failing(scope, receive, send) -> None:
            raise RuntimeError("boom")

        middleware = ConcurrencyLimitMiddleware(failing, limit=1, exempt_paths=frozenset())
        for _ in range(3):
            with pytest.raises(RuntimeError):
                await middleware(_http_scope("/x"), _noop_receive, _noop_send)
        assert not middleware.slots.locked()

        inner = _BlockingApp()
        middleware = ConcurrencyLimitMiddleware(inner, limit=1, exempt_paths=frozenset())
        held = asyncio.create_task(middleware(_http_scope("/x"), _noop_receive, _noop_send))
        await _settle()
        held.cancel()
        await asyncio.gather(held, return_exceptions=True)
        assert not middleware.slots.locked()

    asyncio.run(run())
