import asyncio
import json
import uuid

from starlette.types import ASGIApp, Receive, Scope, Send

RETRY_AFTER_SECONDS = 1


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
    """

    def __init__(
        self, app: ASGIApp, limit: int, max_queued: int, exempt_paths: frozenset[str]
    ) -> None:
        self.app = app
        self.slots = asyncio.Semaphore(limit)
        self.max_queued = max_queued
        self.queued = 0
        self.exempt_paths = exempt_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in self.exempt_paths:
            await self.app(scope, receive, send)
            return
        must_wait = self.slots.locked()
        if must_wait and self.queued >= self.max_queued:
            await _send_overloaded(send)
            return
        if must_wait:
            self.queued += 1
        try:
            await self.slots.acquire()
        finally:
            if must_wait:
                self.queued -= 1
        try:
            await self.app(scope, receive, send)
        finally:
            self.slots.release()


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
