import asyncio
import contextlib
import json
import uuid
from collections import deque
from typing import Literal

from starlette.types import ASGIApp, Message, Receive, Scope, Send

RETRY_AFTER_SECONDS = 1
# A queued request's body is held in memory. Past this, the wait stops watching for a disconnect.
MAX_BUFFERED_BODY_BYTES = 1024 * 1024
MAX_BUFFERED_MESSAGES = 1024


class ConcurrencyLimitMiddleware:
    """Admit what the connection pool can serve, queue a bounded number, and refuse the rest.

    Without a limit, the API can deadlock under load. A request holds a database connection while
    it waits for a worker thread, and the worker threads wait for a connection. Admitting at most
    one request per connection means every admitted request can always get both.

    Without a bound on the queue, sustained overload makes every request wait until its client
    gives up, and the server still does the work for clients that have left. Refusing the excess
    immediately keeps queue time short and tells clients plainly to come back.

    This wraps the whole request, including FastAPI's dependency cleanup, which is what returns the
    connection. That is why it is plain ASGI and not an @app.middleware function, which would
    release its slot as soon as the response starts.

    A queued request also leaves the queue if it waits longer than max_queue_wait_seconds, and gets
    the same refusal, or if its client disconnects, in which case nothing runs. Neither has done
    any work yet, so both are safe to retry. A request that has been admitted is never interrupted.
    """

    def __init__(
        self,
        app: ASGIApp,
        limit: int,
        max_queued: int,
        exempt_paths: frozenset[str],
        max_queue_wait_seconds: float,
    ) -> None:
        self.app = app
        self.slots = asyncio.Semaphore(limit)
        self.max_queued = max_queued
        self.max_queue_wait_seconds = max_queue_wait_seconds
        self.queued = 0
        self.exempt_paths = exempt_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in self.exempt_paths:
            await self.app(scope, receive, send)
            return
        if not self.slots.locked():
            await self.slots.acquire()
            await self._run(scope, receive, send)
            return
        if self.queued >= self.max_queued:
            await _send_overloaded(send)
            return
        watched = _WatchedReceive(receive)
        try:
            self.queued += 1
            try:
                outcome = await self._wait_for_slot(watched)
            finally:
                self.queued -= 1
            if outcome == "admitted":
                await self._run(scope, watched, send)
            elif outcome == "timed_out":
                await _send_overloaded(send)
        finally:
            watched.close()

    async def _run(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self.app(scope, receive, send)
        finally:
            self.slots.release()

    async def _wait_for_slot(
        self, receive: "_WatchedReceive"
    ) -> Literal["admitted", "timed_out", "disconnected"]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.max_queue_wait_seconds
        slot = asyncio.ensure_future(self.slots.acquire())
        admitted = False
        try:
            while True:
                done, _ = await asyncio.wait(
                    {slot, *receive.watch()},
                    timeout=max(deadline - loop.time(), 0),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if slot in done:
                    admitted = True
                    return "admitted"
                receive.collect()
                if receive.disconnected:
                    return "disconnected"
                if not done:
                    return "timed_out"
        finally:
            if not admitted:
                await self._give_up(slot)

    async def _give_up(self, slot: asyncio.Future[bool]) -> None:
        slot.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await slot
        # Granted at the moment it was cancelled: hand it back, or the slot is lost for good.
        if not slot.cancelled():
            self.slots.release()


class _WatchedReceive:
    """Listen for a disconnect while queued, keeping any body so the application still gets it."""

    def __init__(self, receive: Receive) -> None:
        self._receive = receive
        self._buffer: deque[Message] = deque()
        self._buffered_bytes = 0
        self._listener: asyncio.Future[Message] | None = None
        self.disconnected = False

    def collect(self) -> None:
        if self._listener is None or not self._listener.done():
            return
        message = self._listener.result()
        self._listener = None
        self._buffer.append(message)
        self._buffered_bytes += len(message.get("body", b""))
        self.disconnected = message["type"] == "http.disconnect"

    def watch(self) -> set[asyncio.Future[Message]]:
        """The read in progress, starting one if there is room. Empty when there is no room."""
        self.collect()
        if (
            self.disconnected
            or self._buffered_bytes > MAX_BUFFERED_BODY_BYTES
            or len(self._buffer) >= MAX_BUFFERED_MESSAGES
        ):
            return set()
        if self._listener is None:
            self._listener = asyncio.ensure_future(self._receive())
        return {self._listener}

    async def __call__(self) -> Message:
        self.collect()
        if self._buffer:
            return self._buffer.popleft()
        if self._listener is None:
            return await self._receive()
        # Shielded: a caller that stops waiting must not cancel the read and lose its message.
        message = await asyncio.shield(self._listener)
        self._listener = None
        return message

    def close(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            self._listener = None


async def _send_overloaded(send: Send) -> None:
    # Refused before anything runs, so a client can safely retry a write, including a payment.
    request_id = str(uuid.uuid4())
    body = json.dumps(
        {
            "error": {
                "code": "OVERLOADED",
                "message": "The service is busy. Please try again shortly.",
                "details": [],
                "request_id": request_id,
            }
        }
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 503,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"retry-after", str(RETRY_AFTER_SECONDS).encode()),
                (b"x-request-id", request_id.encode()),
                (b"x-content-type-options", b"nosniff"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
