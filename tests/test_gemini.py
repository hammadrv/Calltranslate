from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as calltranslate

ADMIN_TOKEN = "test-room-admin-token-with-enough-entropy"
AR_LINK_TOKEN = "ar_" + "a" * 40
ORIGIN = "https://calls.example.test"


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch):
    monkeypatch.setenv("ROOM_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("FIXED_AR_LINK_TOKEN", AR_LINK_TOKEN)
    monkeypatch.setattr(calltranslate, "room_store", calltranslate.RoomAccessStore())
    monkeypatch.setattr(calltranslate, "hub", calltranslate.RoomHub())
    monkeypatch.setattr(calltranslate.settings, "allowed_origins", {ORIGIN})


def test_gemini_socket_rejects_disallowed_origin() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                "/ws/gemini-live/calltranslate-main/ar",
                headers={"origin": "https://evil.test"},
            ):
                pass
        assert exc.value.code == 4403


def test_gemini_socket_rejects_missing_access_token() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                "/ws/gemini-live/calltranslate-main/ar",
                headers={"origin": ORIGIN},
            ):
                pass
        assert exc.value.code == 4401


def test_gemini_socket_rejects_invalid_access_token() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(
                "/ws/gemini-live/calltranslate-main/ar?token=ct_" + "x" * 40,
                headers={"origin": ORIGIN},
            ):
                pass
        assert exc.value.code == 4403
