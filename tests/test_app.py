from __future__ import annotations

import asyncio
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app as calltranslate


ADMIN_TOKEN = "test-room-admin-token-with-enough-entropy"
ORIGIN = "https://calls.example.test"
SDP_OFFER = (
    "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=test\r\nt=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
)
SDP_ANSWER = (
    "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=answer\r\nt=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
)


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch):
    monkeypatch.setenv("ROOM_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setattr(calltranslate, "room_store", calltranslate.RoomAccessStore())
    monkeypatch.setattr(calltranslate, "hub", calltranslate.RoomHub())
    monkeypatch.setattr(calltranslate.settings, "allowed_origins", {ORIGIN})


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def create_room(client: TestClient) -> dict:
    response = client.post("/api/rooms", headers=bearer(ADMIN_TOKEN))
    assert response.status_code == 200
    return response.json()


def invite_from_url(url: str) -> tuple[str, str, str]:
    parsed = urlparse(url)
    parts = parsed.path.strip("/").split("/")
    assert parts[0] == "room"
    return parts[1], parts[2], parse_qs(parsed.fragment)["token"][0]


def exchange_invite(client: TestClient, url: str) -> dict:
    room_id, role, invite_token = invite_from_url(url)
    response = client.post(
        "/api/room-access",
        json={
            "room_id": room_id,
            "role": role,
            "token": invite_token,
        },
    )
    assert response.status_code == 200
    return response.json()


def websocket_path(access: dict) -> str:
    return f"/ws/{access['room_id']}/{access['role']}"


def websocket_options(access: dict, *, origin: str = ORIGIN) -> dict:
    return {
        "subprotocols": ["calltranslate", access["access_token"]],
        "headers": {"origin": origin},
    }


def test_home_and_security_headers() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "مكالمة واحدة" in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "microphone=(self)" in response.headers["permissions-policy"]
    assert response.headers["content-security-policy"].count("api.openai.com") == 0
    assert "wss:" in response.headers["content-security-policy"]
    assert "max-age=31536000" in response.headers["strict-transport-security"]


def test_room_creation_requires_configured_admin_bearer(monkeypatch) -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        missing = client.post("/api/rooms")
        wrong = client.post("/api/rooms", headers=bearer("wrong-token"))
        monkeypatch.delenv("ROOM_ADMIN_TOKEN")
        unconfigured = client.post("/api/rooms", headers=bearer(ADMIN_TOKEN))

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert unconfigured.status_code == 503
    assert unconfigured.json()["detail"]["code"] == "room_admin_not_configured"


def test_room_links_keep_invite_in_fragment_and_page_has_no_secret() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        arabic = urlparse(room["links"]["ar"])
        english = urlparse(room["links"]["en"])

        arabic_page = client.get(arabic.path)
        english_page = client.get(english.path)

    assert room["links"]["ar"] != room["links"]["en"]
    assert arabic.query == english.query == ""
    assert parse_qs(arabic.fragment)["token"][0]
    assert parse_qs(english.fragment)["token"][0]
    assert arabic_page.status_code == english_page.status_code == 200
    assert arabic_page.headers["cache-control"] == "no-store"
    assert "token" not in arabic_page.text


def test_invite_exchange_is_role_scoped_and_one_time() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        room_id, _, invite_token = invite_from_url(room["links"]["ar"])

        wrong_role = client.post(
            "/api/room-access",
            json={"room_id": room_id, "role": "en", "token": invite_token},
        )
        valid = client.post(
            "/api/room-access",
            json={"room_id": room_id, "role": "ar", "token": invite_token},
        )
        replay = client.post(
            "/api/room-access",
            json={"room_id": room_id, "role": "ar", "token": invite_token},
        )

    assert wrong_role.status_code == 403
    assert valid.status_code == 200
    assert valid.json()["access_token"].startswith("ct_")
    assert valid.json()["role"] == "ar"
    assert valid.headers["cache-control"] == "no-store"
    assert replay.status_code == 409


def test_client_config_requires_access_bearer(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-secret")
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["en"])
        missing = client.get("/api/client-config")
        invalid = client.get("/api/client-config", headers=bearer("ct_invalid"))
        valid = client.get(
            "/api/client-config",
            headers=bearer(access["access_token"]),
        )

    assert missing.status_code == invalid.status_code == 401
    assert valid.status_code == 200
    assert valid.json()["room_id"] == room["room_id"]
    assert valid.json()["role"] == "en"
    assert valid.json()["translation_configured"] is True
    assert valid.json()["ice_servers"]


def test_websocket_requires_same_origin_and_token_subprotocol() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["ar"])
        path = websocket_path(access)

        with pytest.raises(WebSocketDisconnect) as wrong_origin:
            with client.websocket_connect(
                path,
                **websocket_options(access, origin="https://evil.example"),
            ):
                pass
        with pytest.raises(WebSocketDisconnect) as missing_protocol:
            with client.websocket_connect(path, headers={"origin": ORIGIN}):
                pass

    assert wrong_origin.value.code == 4403
    assert missing_protocol.value.code == 4401


def test_websocket_relay_is_bound_to_access_tokens() -> None:
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        ar = exchange_invite(client, room["links"]["ar"])
        en = exchange_invite(client, room["links"]["en"])

        with client.websocket_connect(
            websocket_path(ar), **websocket_options(ar)
        ) as arabic:
            ar_welcome = arabic.receive_json()
            assert ar_welcome["type"] == "welcome"
            assert ar_welcome["peer_connected"] is False
            assert arabic.accepted_subprotocol == "calltranslate"

            with client.websocket_connect(
                websocket_path(en), **websocket_options(en)
            ) as english:
                en_welcome = english.receive_json()
                assert en_welcome["type"] == "welcome"
                assert en_welcome["peer_connected"] is True
                assert arabic.receive_json() == {"type": "peer-joined"}

                arabic.send_json({"type": "offer", "sdp": SDP_OFFER})
                assert english.receive_json() == {
                    "type": "offer",
                    "sdp": SDP_OFFER,
                }


def test_realtime_call_requires_an_active_signaling_socket(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-secret")
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["en"])
        response = client.post(
            "/api/realtime/call",
            headers={**bearer(access["access_token"]), "Content-Type": "application/sdp"},
            content=SDP_OFFER,
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "participant_not_connected"


def test_realtime_call_rejects_sdp_without_audio_and_data_channel(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-secret")
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["en"])
        with client.websocket_connect(
            websocket_path(access), **websocket_options(access)
        ) as websocket:
            assert websocket.receive_json()["type"] == "welcome"
            response = client.post(
                "/api/realtime/call",
                headers={
                    **bearer(access["access_token"]),
                    "Content-Type": "application/sdp",
                },
                content="v=0\r\ns=incomplete\r\n",
            )

    assert response.status_code == 422


def test_realtime_call_proxies_sdp_without_exposing_ephemeral_secret(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-server-key")
    captured: list[dict] = []

    class FakeOpenAIClient:
        async def post(self, url, *, headers, json=None, content=None):
            captured.append(
                {"url": url, "headers": headers, "json": json, "content": content}
            )
            request = httpx.Request("POST", url)
            if url.endswith("/client_secrets"):
                return httpx.Response(
                    200,
                    request=request,
                    json={"value": "ek_test_ephemeral", "expires_at": 1234567890},
                )
            return httpx.Response(
                200,
                request=request,
                content=SDP_ANSWER.encode("utf-8"),
                headers={"Content-Type": "application/sdp"},
            )

    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        original_client = client.app.state.openai_client
        client.app.state.openai_client = FakeOpenAIClient()
        try:
            room = create_room(client)
            access = exchange_invite(client, room["links"]["en"])
            headers = {
                **bearer(access["access_token"]),
                "Content-Type": "application/sdp",
            }
            with client.websocket_connect(
                websocket_path(access), **websocket_options(access)
            ) as websocket:
                assert websocket.receive_json()["type"] == "welcome"
                response = client.post(
                    "/api/realtime/call",
                    headers=headers,
                    content=SDP_OFFER,
                )
                cooldown = client.post(
                    "/api/realtime/call",
                    headers=headers,
                    content=SDP_OFFER,
                )
        finally:
            client.app.state.openai_client = original_client

    assert response.status_code == 200
    assert response.text == SDP_ANSWER
    assert response.headers["content-type"].startswith("application/sdp")
    assert "ek_test_ephemeral" not in response.text
    assert len(captured) == 2
    assert captured[0]["url"].endswith("/realtime/translations/client_secrets")
    assert captured[0]["headers"]["Authorization"] == "Bearer sk-test-server-key"
    assert captured[0]["json"]["session"]["audio"]["output"]["language"] == "en"
    assert captured[1]["url"].endswith("/realtime/translations/calls")
    assert captured[1]["headers"]["Authorization"] == "Bearer ek_test_ephemeral"
    assert captured[1]["headers"]["Accept"] == "application/sdp"
    assert captured[1]["content"] == SDP_OFFER.encode("utf-8")
    assert cooldown.status_code == 429
    assert int(cooldown.headers["retry-after"]) >= 1


def test_missing_openai_key_fails_safely_while_socket_is_active(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_FILE", raising=False)
    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["ar"])
        with client.websocket_connect(
            websocket_path(access), **websocket_options(access)
        ) as websocket:
            assert websocket.receive_json()["type"] == "welcome"
            response = client.post(
                "/api/realtime/call",
                headers={
                    **bearer(access["access_token"]),
                    "Content-Type": "application/sdp",
                },
                content=SDP_OFFER,
            )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "translation_not_configured"


def test_signal_size_and_rate_limits(monkeypatch) -> None:
    monkeypatch.setattr(calltranslate.settings, "max_signal_bytes", 64)
    limiter = calltranslate.SignalRateLimiter(maximum=2, window_seconds=10)
    assert limiter.allow(now=0.0)
    assert limiter.allow(now=1.0)
    assert not limiter.allow(now=2.0)
    assert limiter.allow(now=11.0)

    with TestClient(calltranslate.app, base_url=ORIGIN) as client:
        room = create_room(client)
        access = exchange_invite(client, room["links"]["ar"])
        with client.websocket_connect(
            websocket_path(access), **websocket_options(access)
        ) as websocket:
            assert websocket.receive_json()["type"] == "welcome"
            websocket.send_text("x" * 65)
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()

    assert closed.value.code == 1009


def test_access_grant_cooldown_limit_and_expiry(monkeypatch) -> None:
    monkeypatch.setattr(calltranslate.settings, "realtime_call_cooldown_seconds", 10)
    monkeypatch.setattr(calltranslate.settings, "realtime_call_max_grants", 2)
    base_time = time.time()
    expires_at = int(base_time) + 600
    room_id = "room_for_unit_test"
    invite = calltranslate.issue_room_token(room_id, "ar", expires_at)
    store = calltranslate.RoomAccessStore()

    async def scenario() -> None:
        assert await store.create_room(room_id, expires_at)
        token, grant, error = await store.exchange_invite(
            room_id, "ar", invite, now=base_time
        )
        assert error is None and grant is not None and token is not None

        first, first_error, _ = await store.reserve_realtime_call(
            token, now=base_time + 1
        )
        assert first is not None and first_error is None
        _, cooldown_error, retry_after = await store.reserve_realtime_call(
            token, now=base_time + 2
        )
        assert cooldown_error == "cooldown" and retry_after == 9
        second, second_error, _ = await store.reserve_realtime_call(
            token, now=base_time + 11
        )
        assert second is not None and second_error is None
        _, limit_error, _ = await store.reserve_realtime_call(
            token, now=base_time + 22
        )
        assert limit_error == "limit"
        assert await store.get_access(token, now=grant.expires_at + 1) is None

    asyncio.run(scenario())


def test_room_hub_activity_ends_at_call_deadline() -> None:
    hub = calltranslate.RoomHub()
    access_token = "ct_" + "a" * 43
    base_time = time.time()

    async def scenario() -> None:
        connected, peer = await hub.connect(
            "room_for_hub_test",
            "ar",
            access_token,
            object(),  # type: ignore[arg-type]
            base_time + 10,
        )
        assert connected and peer is None
        assert await hub.is_active(access_token, now=base_time + 9)
        assert not await hub.is_active(access_token, now=base_time + 11)

    asyncio.run(scenario())
