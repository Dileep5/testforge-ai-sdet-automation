import asyncio

from starlette.types import ASGIApp, Receive, Scope, Send


class ConcurrencyLimitMiddleware:
    """Queue requests beyond what the connection pool can serve, before they acquire anything.

    Without this, the API can deadlock under load. A request holds a database connection while it
    waits for a worker thread, and the worker threads wait for a connection. Admitting at most one
    request per connection means every admitted request can always get both.

    This wraps the whole request, including FastAPI's dependency cleanup, which is what returns the
    connection. That is why it is plain ASGI and not an @app.middleware function, which would
    release its slot as soon as the response starts.
    """

    def __init__(self, app: ASGIApp, limit: int, exempt_paths: frozenset[str]) -> None:
        self.app = app
        self.slots = asyncio.Semaphore(limit)
        self.exempt_paths = exempt_paths

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in self.exempt_paths:
            await self.app(scope, receive, send)
            return
        async with self.slots:
            await self.app(scope, receive, send)
