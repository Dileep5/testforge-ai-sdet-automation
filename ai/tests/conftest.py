import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def _offline(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No test may use a real key or reach anything but this machine, whatever the shell has set."""
    for name in (
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "OPENAI_BASE_URL",
        "TESTFORGE_ALLOW_LIVE_LLM",
        "TESTFORGE_INPUT_USD_PER_MTOK",
        "TESTFORGE_OUTPUT_USD_PER_MTOK",
    ):
        monkeypatch.delenv(name, raising=False)
    real_connect = socket.socket.connect

    def local_only(self: socket.socket, address: Any) -> Any:
        if self.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in (
            "127.0.0.1",
            "::1",
            "localhost",
        ):
            raise AssertionError(f"Test tried to reach {address[0]}")
        return real_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", local_only)
    yield


class FakeOpenAI:
    """A local stand-in for the Responses API, so the real SDK runs over real HTTP."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.reply_text = "{}"
        self.status = 200
        self.base_url = ""

    def response_body(self, request: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": "resp_fake",
            "object": "response",
            "created_at": 0,
            "status": "completed",
            "model": request.get("model", "fake"),
            "output": [
                {
                    "id": "msg_fake",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {"type": "output_text", "text": self.reply_text, "annotations": []}
                    ],
                }
            ],
            "parallel_tool_calls": False,
            "tool_choice": "none",
            "tools": [],
            "usage": {
                "input_tokens": 120,
                "output_tokens": 30,
                "total_tokens": 150,
                "input_tokens_details": {"cached_tokens": 0},
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        }


@pytest.fixture
def fake_openai() -> Iterator[FakeOpenAI]:
    fake = FakeOpenAI()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length))
            fake.requests.append(
                {"path": self.path, "auth": self.headers.get("authorization"), "body": body}
            )
            payload = (
                fake.response_body(body)
                if fake.status == 200
                else {"error": {"message": "secret detail from server", "type": "server_error"}}
            )
            encoded = json.dumps(payload).encode()
            self.send_response(fake.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.base_url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    yield fake
    server.shutdown()
    server.server_close()
