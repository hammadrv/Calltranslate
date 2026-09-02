from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

OPENAI_CLIENT_SECRET_URL = (
    "https://api.openai.com/v1/realtime/translations/client_secrets"
)
OPENAI_TRANSLATION_CALL_URL = "https://api.openai.com/v1/realtime/translations/calls"
ROOM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{12,80}$")
ACCESS_TOKEN_PATTERN = re.compile(r"^ct_[A-Za-z0-9_-]{32,100}$")
VALID_ROLES = {"ar", "en"}
PEER_ROLE = {"ar": "en", "en": "ar"}
TARGET_LANGUAGE = {"ar": "ar", "en": "en"}
FORWARDED_SIGNAL_TYPES = {"offer", "answer", "ice-candidate", "hangup"}

logger = logging.getLogger("calltranslate")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def _positive_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError:
        logger.warning("Invalid %s value; using %s", name, default)
        return default
    return max(minimum, min(value, maximum))


def _normalise_origin(value: str) -> str | None:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


class Settings:
    def __init__(self) -> None:
        configured_secret = os.getenv("ROOM_SIGNING_SECRET", "").strip()
        if configured_secret:
            self.room_signing_secret = configured_secret.encode("utf-8")
        else:
            self.room_signing_secret = secrets.token_bytes(32)
            logger.warning(
                "ROOM_SIGNING_SECRET is not set; in-memory room links will not "
                "survive a restart"
            )

        self.public_base_url = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
        configured_origins = os.getenv("ALLOWED_ORIGINS", "")
        self.allowed_origins = {
            origin
            for item in configured_origins.split(",")
            if (origin := _normalise_origin(item.strip())) is not None
        }
        public_origin = _normalise_origin(self.public_base_url)
        if public_origin:
            self.allowed_origins.add(public_origin)

        self.room_ttl_seconds = _positive_int(
            "ROOM_TTL_SECONDS", 6 * 60 * 60, 5 * 60, 24 * 60 * 60
        )
        self.access_ttl_seconds = _positive_int(
            "ROOM_ACCESS_TTL_SECONDS", 45 * 60, 5 * 60, 2 * 60 * 60
        )
        self.max_call_seconds = _positive_int(
            "MAX_CALL_SECONDS", 30 * 60, 60, 2 * 60 * 60
        )
        self.realtime_call_cooldown_seconds = _positive_int(
            "REALTIME_CALL_COOLDOWN_SECONDS", 5, 1, 60
        )
        self.realtime_call_max_grants = _positive_int(
            "REALTIME_CALL_MAX_GRANTS", 3, 1, 10
        )
        self.openai_secret_ttl_seconds = _positive_int(
            "OPENAI_CLIENT_SECRET_TTL_SECONDS", 120, 10, 300
        )
        self.max_sdp_bytes = _positive_int(
            "MAX_SDP_BYTES", 64 * 1024, 4 * 1024, 256 * 1024
        )
        self.max_signal_bytes = _positive_int(
            "MAX_SIGNAL_BYTES", 64 * 1024, 4 * 1024, 256 * 1024
        )
        self.signal_rate_max_messages = _positive_int(
            "SIGNAL_RATE_MAX_MESSAGES", 180, 10, 1000
        )
        self.signal_rate_window_seconds = _positive_int(
            "SIGNAL_RATE_WINDOW_SECONDS", 60, 10, 300
        )
        self.openai_model = os.getenv(
            "OPENAI_TRANSLATION_MODEL", "gpt-realtime-translate"
        ).strip()
        self.openai_transcription_model = os.getenv(
            "OPENAI_TRANSCRIPTION_MODEL", "gpt-realtime-whisper"
        ).strip()

        stun_urls = os.getenv("STUN_URLS", "stun:stun.l.google.com:19302")
        self.stun_urls = [url.strip() for url in stun_urls.split(",") if url.strip()]
        turn_urls = os.getenv("TURN_URLS", "")
        self.turn_urls = [url.strip() for url in turn_urls.split(",") if url.strip()]
        self.turn_username = os.getenv("TURN_USERNAME", "").strip()
        self.turn_credential = os.getenv("TURN_CREDENTIAL", "").strip()
        self.turn_shared_secret = os.getenv("TURN_SHARED_SECRET", "").strip()

    def room_admin_token(self) -> str:
        return os.getenv("ROOM_ADMIN_TOKEN", "").strip()

    def openai_api_key(self) -> str:
        value = os.getenv("OPENAI_API_KEY", "").strip()
        key_file = os.getenv("OPENAI_API_KEY_FILE", "").strip()

        if not value and key_file:
            try:
                value = Path(key_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                logger.error("Unable to read OPENAI_API_KEY_FILE: %s", exc)
                return ""

        if value.startswith("OPENAI_API_KEY="):
            value = value.removeprefix("OPENAI_API_KEY=").strip()
        return value


settings = Settings()


class RoomAccessRequest(BaseModel):
    room_id: str = Field(min_length=12, max_length=80)
    role: str = Field(min_length=2, max_length=2)
    token: str = Field(min_length=20, max_length=256)


@dataclass
class RoomRecord:
    expires_at: int
    consumed_roles: set[str] = field(default_factory=set)


@dataclass
class AccessGrant:
    room_id: str
    role: str
    expires_at: float
    realtime_grants: int = 0
    last_realtime_grant_at: float | None = None


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class RoomAccessStore:
    """Single-process room and access-token state.

    Deployment must use one application worker unless this store and RoomHub are
    replaced by shared state (for example Redis).
    """

    def __init__(self) -> None:
        self._rooms: dict[str, RoomRecord] = {}
        self._access: dict[str, AccessGrant] = {}
        self._lock = asyncio.Lock()

    def _prune(self, now: float) -> None:
        expired_rooms = {
            room_id
            for room_id, room in self._rooms.items()
            if room.expires_at < now
        }
        for room_id in expired_rooms:
            self._rooms.pop(room_id, None)

        expired_access = [
            digest
            for digest, grant in self._access.items()
            if grant.expires_at < now or grant.room_id in expired_rooms
        ]
        for digest in expired_access:
            self._access.pop(digest, None)

    async def create_room(self, room_id: str, expires_at: int) -> bool:
        async with self._lock:
            self._prune(time.time())
            if room_id in self._rooms:
                return False
            self._rooms[room_id] = RoomRecord(expires_at=expires_at)
            return True

    async def room_exists(self, room_id: str) -> bool:
        async with self._lock:
            now = time.time()
            self._prune(now)
            room = self._rooms.get(room_id)
            return room is not None and room.expires_at >= now

    async def exchange_invite(
        self,
        room_id: str,
        role: str,
        invite_token: str,
        *,
        now: float | None = None,
    ) -> tuple[str | None, AccessGrant | None, str | None]:
        current_time = time.time() if now is None else now
        if not verify_room_token(room_id, role, invite_token, now=current_time):
            return None, None, "invalid"

        async with self._lock:
            self._prune(current_time)
            room = self._rooms.get(room_id)
            if room is None or room.expires_at < current_time:
                return None, None, "invalid"
            if role in room.consumed_roles:
                return None, None, "consumed"

            room.consumed_roles.add(role)
            access_token = "ct_" + secrets.token_urlsafe(32)
            grant = AccessGrant(
                room_id=room_id,
                role=role,
                expires_at=min(
                    float(room.expires_at),
                    current_time + settings.access_ttl_seconds,
                ),
            )
            self._access[_token_digest(access_token)] = grant
            return access_token, replace(grant), None

    async def get_access(
        self, access_token: str, *, now: float | None = None
    ) -> AccessGrant | None:
        if not ACCESS_TOKEN_PATTERN.fullmatch(access_token):
            return None
        current_time = time.time() if now is None else now
        async with self._lock:
            self._prune(current_time)
            grant = self._access.get(_token_digest(access_token))
            if grant is None or grant.expires_at < current_time:
                return None
            return replace(grant)

    async def reserve_realtime_call(
        self, access_token: str, *, now: float | None = None
    ) -> tuple[AccessGrant | None, str | None, int | None]:
        if not ACCESS_TOKEN_PATTERN.fullmatch(access_token):
            return None, "invalid", None
        current_time = time.time() if now is None else now
        async with self._lock:
            self._prune(current_time)
            grant = self._access.get(_token_digest(access_token))
            if grant is None or grant.expires_at < current_time:
                return None, "invalid", None
            if grant.realtime_grants >= settings.realtime_call_max_grants:
                return None, "limit", None
            if grant.last_realtime_grant_at is not None:
                available_at = (
                    grant.last_realtime_grant_at
                    + settings.realtime_call_cooldown_seconds
                )
                if available_at > current_time:
                    return (
                        None,
                        "cooldown",
                        max(1, math.ceil(available_at - current_time)),
                    )

            grant.realtime_grants += 1
            grant.last_realtime_grant_at = current_time
            return replace(grant), None, None


@dataclass
class ActiveParticipant:
    websocket: WebSocket
    access_digest: str
    deadline: float


class RoomHub:
    """Single-process WebSocket hub; keep the ASGI deployment at one worker."""

    def __init__(self) -> None:
        self._rooms: dict[str, dict[str, ActiveParticipant]] = {}
        self._active_tokens: dict[str, ActiveParticipant] = {}
        self._lock = asyncio.Lock()

    async def connect(
        self,
        room_id: str,
        role: str,
        access_token: str,
        websocket: WebSocket,
        deadline: float,
    ) -> tuple[bool, WebSocket | None]:
        access_digest = _token_digest(access_token)
        async with self._lock:
            participants = self._rooms.setdefault(room_id, {})
            if role in participants or access_digest in self._active_tokens:
                return False, None
            participant = ActiveParticipant(
                websocket=websocket,
                access_digest=access_digest,
                deadline=deadline,
            )
            participants[role] = participant
            self._active_tokens[access_digest] = participant
            peer = participants.get(PEER_ROLE[role])
            return True, peer.websocket if peer else None

    async def peer(self, room_id: str, role: str) -> WebSocket | None:
        async with self._lock:
            peer = self._rooms.get(room_id, {}).get(PEER_ROLE[role])
            return peer.websocket if peer else None

    async def is_active(
        self, access_token: str, *, now: float | None = None
    ) -> bool:
        current_time = time.time() if now is None else now
        async with self._lock:
            participant = self._active_tokens.get(_token_digest(access_token))
            return participant is not None and participant.deadline >= current_time

    async def disconnect(
        self,
        room_id: str,
        role: str,
        access_token: str,
        websocket: WebSocket,
    ) -> WebSocket | None:
        access_digest = _token_digest(access_token)
        async with self._lock:
            participants = self._rooms.get(room_id)
            if not participants:
                self._active_tokens.pop(access_digest, None)
                return None

            participant = participants.get(role)
            if (
                participant is not None
                and participant.websocket is websocket
                and participant.access_digest == access_digest
            ):
                participants.pop(role, None)
                self._active_tokens.pop(access_digest, None)

            peer = participants.get(PEER_ROLE[role])
            if not participants:
                self._rooms.pop(room_id, None)
            return peer.websocket if peer else None


class SignalRateLimiter:
    def __init__(self, maximum: int, window_seconds: int) -> None:
        self.maximum = maximum
        self.window_seconds = window_seconds
        self.timestamps: deque[float] = deque()

    def allow(self, now: float | None = None) -> bool:
        current_time = time.monotonic() if now is None else now
        cutoff = current_time - self.window_seconds
        while self.timestamps and self.timestamps[0] <= cutoff:
            self.timestamps.popleft()
        if len(self.timestamps) >= self.maximum:
            return False
        self.timestamps.append(current_time)
        return True


room_store = RoomAccessStore()
hub = RoomHub()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.openai_client = httpx.AsyncClient(
        timeout=httpx.Timeout(15.0, connect=8.0),
        headers={"User-Agent": "calltranslate/0.2"},
    )
    yield
    await app.state.openai_client.aclose()


app = FastAPI(
    title="Calltranslate",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "microphone=(self), camera=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; "
        "img-src 'self' data:; style-src 'self'; script-src 'self'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    return response


def valid_room_id(room_id: str) -> bool:
    return bool(ROOM_ID_PATTERN.fullmatch(room_id))


def issue_room_token(room_id: str, role: str, expires_at: int) -> str:
    payload = f"{room_id}.{role}.{expires_at}".encode("utf-8")
    signature = hmac.new(
        settings.room_signing_secret, payload, hashlib.sha256
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
    return f"{expires_at}.{encoded_signature}"


def verify_room_token(
    room_id: str,
    role: str,
    token: str,
    *,
    now: float | None = None,
) -> bool:
    if role not in VALID_ROLES or not valid_room_id(room_id):
        return False

    try:
        expires_raw, provided_signature = token.split(".", 1)
        expires_at = int(expires_raw)
    except (ValueError, AttributeError):
        return False

    current_time = int(time.time() if now is None else now)
    if expires_at < current_time or expires_at > current_time + 25 * 60 * 60:
        return False

    expected = issue_room_token(room_id, role, expires_at).split(".", 1)[1]
    return hmac.compare_digest(expected, provided_signature)


def _bearer_token(request: Request) -> str | None:
    value = request.headers.get("authorization", "")
    scheme, separator, token = value.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _auth_error(detail: str = "Invalid or missing bearer token") -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_admin(request: Request) -> None:
    configured = settings.room_admin_token()
    if not configured:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "room_admin_not_configured",
                "message": "Room creation is not configured on the server",
            },
        )
    provided = _bearer_token(request)
    if provided is None or not hmac.compare_digest(configured, provided):
        raise _auth_error()


async def require_access(request: Request) -> tuple[str, AccessGrant]:
    access_token = _bearer_token(request)
    if access_token is None:
        raise _auth_error()
    grant = await room_store.get_access(access_token)
    if grant is None:
        raise _auth_error("Access token is invalid or expired")
    return access_token, grant


def public_base_url(request: Request) -> str:
    if settings.public_base_url:
        return settings.public_base_url
    return str(request.base_url).rstrip("/")


def room_url(base_url: str, room_id: str, role: str, token: str) -> str:
    fragment = urlencode({"token": token})
    return f"{base_url}/room/{room_id}/{role}#{fragment}"


def turn_credentials(room_id: str) -> tuple[str, str]:
    if settings.turn_shared_secret:
        expires_at = int(time.time()) + 60 * 60
        username = f"{expires_at}:{room_id}"
        digest = hmac.new(
            settings.turn_shared_secret.encode("utf-8"),
            username.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        return username, base64.b64encode(digest).decode("ascii")
    return settings.turn_username, settings.turn_credential


def ice_servers(room_id: str) -> list[dict[str, Any]]:
    servers: list[dict[str, Any]] = []
    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})

    username, credential = turn_credentials(room_id)
    if settings.turn_urls and username and credential:
        servers.append(
            {
                "urls": settings.turn_urls,
                "username": username,
                "credential": credential,
            }
        )
    return servers


def safety_identifier(room_id: str, role: str) -> str:
    digest = hashlib.sha256(f"{room_id}:{role}".encode("utf-8")).hexdigest()
    return f"calltranslate-{digest[:32]}"


def websocket_origin_allowed(websocket: WebSocket) -> bool:
    origin = _normalise_origin(websocket.headers.get("origin", ""))
    if origin is None:
        return False
    if settings.allowed_origins:
        return origin in settings.allowed_origins
    host = websocket.headers.get("host", "").lower()
    return bool(host) and urlsplit(origin).netloc.lower() == host


def websocket_access_token(websocket: WebSocket) -> str | None:
    protocols = websocket.scope.get("subprotocols", [])
    if (
        not isinstance(protocols, list)
        or len(protocols) != 2
        or protocols[0] != "calltranslate"
        or not isinstance(protocols[1], str)
        or not ACCESS_TOKEN_PATTERN.fullmatch(protocols[1])
    ):
        return None
    return protocols[1]


def validated_signal(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return None
    message_type = message.get("type")
    if message_type not in FORWARDED_SIGNAL_TYPES:
        return None

    if message_type in {"offer", "answer"}:
        sdp = message.get("sdp")
        if (
            not isinstance(sdp, str)
            or not sdp.startswith("v=0")
            or len(sdp.encode("utf-8")) > settings.max_sdp_bytes
        ):
            return None
        return {"type": message_type, "sdp": sdp}

    if message_type == "ice-candidate":
        candidate = message.get("candidate")
        if not isinstance(candidate, dict):
            return None
        candidate_text = candidate.get("candidate")
        if not isinstance(candidate_text, str) or len(candidate_text) > 4096:
            return None
        cleaned: dict[str, Any] = {"candidate": candidate_text}
        for key in ("sdpMid", "usernameFragment"):
            value = candidate.get(key)
            if value is not None:
                if not isinstance(value, str) or len(value) > 256:
                    return None
                cleaned[key] = value
        line_index = candidate.get("sdpMLineIndex")
        if line_index is not None:
            if not isinstance(line_index, int) or isinstance(line_index, bool):
                return None
            if line_index < 0 or line_index > 65535:
                return None
            cleaned["sdpMLineIndex"] = line_index
        return {"type": message_type, "candidate": cleaned}

    return {"type": "hangup"}


async def safe_send(websocket: WebSocket | None, payload: dict[str, Any]) -> None:
    if websocket is None:
        return
    try:
        await websocket.send_json(payload)
    except (RuntimeError, WebSocketDisconnect):
        pass


async def _limited_request_body(request: Request, maximum: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > maximum:
            raise HTTPException(status_code=413, detail="SDP offer is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _translation_session_payload(role: str) -> dict[str, Any]:
    return {
        "expires_after": {
            "anchor": "created_at",
            "seconds": settings.openai_secret_ttl_seconds,
        },
        "session": {
            "model": settings.openai_model,
            "audio": {
                "input": {
                    "transcription": {
                        "model": settings.openai_transcription_model,
                    },
                    "noise_reduction": {"type": "near_field"},
                },
                "output": {"language": TARGET_LANGUAGE[role]},
            },
        },
    }


@app.get("/", include_in_schema=False)
async def home() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz", include_in_schema=False)
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/room/{room_id}/{role}", include_in_schema=False)
async def call_page(room_id: str, role: str) -> FileResponse:
    if (
        role not in VALID_ROLES
        or not valid_room_id(room_id)
        or not await room_store.room_exists(room_id)
    ):
        raise HTTPException(status_code=403, detail="Room is invalid or expired")
    return FileResponse(
        STATIC_DIR / "call.html",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.post("/api/rooms")
async def create_room(request: Request) -> JSONResponse:
    require_admin(request)
    expires_at = int(time.time()) + settings.room_ttl_seconds
    while True:
        room_id = secrets.token_urlsafe(18)
        if await room_store.create_room(room_id, expires_at):
            break

    base_url = public_base_url(request)
    links: dict[str, str] = {}
    for role in sorted(VALID_ROLES):
        token = issue_room_token(room_id, role, expires_at)
        links[role] = room_url(base_url, room_id, role, token)

    return JSONResponse(
        {"room_id": room_id, "expires_at": expires_at, "links": links},
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.post("/api/room-access")
async def create_room_access(payload: RoomAccessRequest) -> JSONResponse:
    access_token, grant, error = await room_store.exchange_invite(
        payload.room_id,
        payload.role,
        payload.token,
    )
    if error == "consumed":
        raise HTTPException(status_code=409, detail="Invite link has already been used")
    if error or access_token is None or grant is None:
        raise HTTPException(status_code=403, detail="Invite link is invalid or expired")

    return JSONResponse(
        {
            "access_token": access_token,
            "expires_at": int(grant.expires_at),
            "room_id": grant.room_id,
            "role": grant.role,
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.get("/api/client-config")
async def client_config(request: Request) -> JSONResponse:
    _, grant = await require_access(request)
    return JSONResponse(
        {
            "room_id": grant.room_id,
            "role": grant.role,
            "ice_servers": ice_servers(grant.room_id),
            "translation_configured": bool(settings.openai_api_key()),
            "access_expires_at": int(grant.expires_at),
            "max_call_seconds": settings.max_call_seconds,
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.post("/api/realtime/call")
async def create_translation_call(request: Request) -> Response:
    access_token, access = await require_access(request)
    if not await hub.is_active(access_token):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "participant_not_connected",
                "message": "An authenticated signaling connection is required",
            },
        )

    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type != "application/sdp":
        raise HTTPException(status_code=415, detail="Content-Type must be application/sdp")
    body = await _limited_request_body(request, settings.max_sdp_bytes)
    try:
        offer_sdp = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="SDP offer must be UTF-8") from exc
    if not offer_sdp.startswith("v=0"):
        raise HTTPException(status_code=422, detail="Invalid SDP offer")
    if "\nm=audio " not in offer_sdp or "\nm=application " not in offer_sdp:
        raise HTTPException(
            status_code=422,
            detail="SDP offer must include audio and data-channel media sections",
        )

    api_key = settings.openai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "translation_not_configured",
                "message": "OpenAI translation is not configured on the server",
            },
        )

    _, reservation_error, retry_after = await room_store.reserve_realtime_call(
        access_token
    )
    if reservation_error == "cooldown":
        raise HTTPException(
            status_code=429,
            detail="Translation reconnect cooldown is active",
            headers={"Retry-After": str(retry_after or 1)},
        )
    if reservation_error == "limit":
        raise HTTPException(
            status_code=429,
            detail="Translation call grant limit reached",
        )
    if reservation_error:
        raise _auth_error("Access token is invalid or expired")

    safety_id = safety_identifier(access.room_id, access.role)
    try:
        secret_response = await request.app.state.openai_client.post(
            OPENAI_CLIENT_SECRET_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "OpenAI-Safety-Identifier": safety_id,
            },
            json=_translation_session_payload(access.role),
        )
    except httpx.TimeoutException as exc:
        logger.warning("OpenAI client-secret request timed out: %s", type(exc).__name__)
        raise HTTPException(status_code=504, detail="Translation service timed out") from exc
    except httpx.HTTPError as exc:
        logger.warning("OpenAI client-secret request failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail="Translation service is unavailable"
        ) from exc

    if secret_response.status_code >= 400:
        logger.warning(
            "OpenAI client-secret request returned HTTP %s",
            secret_response.status_code,
        )
        if secret_response.status_code == 429:
            raise HTTPException(
                status_code=429, detail="Translation service rate limit reached"
            )
        raise HTTPException(
            status_code=502, detail="Translation service rejected the session"
        )

    try:
        ephemeral_secret = secret_response.json()["value"]
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(
            status_code=502, detail="Translation service returned an invalid session"
        ) from exc
    if not isinstance(ephemeral_secret, str) or not ephemeral_secret:
        raise HTTPException(
            status_code=502, detail="Translation service returned an invalid session"
        )

    if not await hub.is_active(access_token):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "participant_disconnected",
                "message": "The signaling connection closed during setup",
            },
        )

    try:
        call_response = await request.app.state.openai_client.post(
            OPENAI_TRANSLATION_CALL_URL,
            headers={
                "Authorization": f"Bearer {ephemeral_secret}",
                "Content-Type": "application/sdp",
                "Accept": "application/sdp",
                "OpenAI-Safety-Identifier": safety_id,
            },
            content=offer_sdp.encode("utf-8"),
        )
    except httpx.TimeoutException as exc:
        logger.warning("OpenAI translation-call request timed out: %s", type(exc).__name__)
        raise HTTPException(status_code=504, detail="Translation service timed out") from exc
    except httpx.HTTPError as exc:
        logger.warning("OpenAI translation-call request failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail="Translation service is unavailable"
        ) from exc

    if call_response.status_code >= 400:
        logger.warning(
            "OpenAI translation-call request returned HTTP %s",
            call_response.status_code,
        )
        if call_response.status_code == 429:
            raise HTTPException(
                status_code=429, detail="Translation service rate limit reached"
            )
        raise HTTPException(
            status_code=502, detail="Translation service rejected the call"
        )
    if len(call_response.content) > settings.max_sdp_bytes:
        raise HTTPException(
            status_code=502, detail="Translation service returned an invalid answer"
        )
    try:
        answer_sdp = call_response.content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=502, detail="Translation service returned an invalid answer"
        ) from exc
    if not answer_sdp.startswith("v=0"):
        raise HTTPException(
            status_code=502, detail="Translation service returned an invalid answer"
        )

    return Response(
        content=answer_sdp,
        media_type="application/sdp",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.websocket("/ws/{room_id}/{role}")
async def signaling_socket(websocket: WebSocket, room_id: str, role: str) -> None:
    if not websocket_origin_allowed(websocket):
        await websocket.close(code=4403, reason="Origin is not allowed")
        return

    access_token = websocket_access_token(websocket)
    if access_token is None:
        await websocket.close(code=4401, reason="Missing access token subprotocol")
        return
    access = await room_store.get_access(access_token)
    if (
        access is None
        or access.room_id != room_id
        or access.role != role
        or role not in VALID_ROLES
        or not valid_room_id(room_id)
    ):
        await websocket.close(code=4403, reason="Access token is invalid or expired")
        return

    await websocket.accept(subprotocol="calltranslate")
    deadline = min(access.expires_at, time.time() + settings.max_call_seconds)
    connected, peer = await hub.connect(
        room_id,
        role,
        access_token,
        websocket,
        deadline,
    )
    if not connected:
        await websocket.close(code=4409, reason="This side of the room is already in use")
        return

    logger.info("Participant %s joined room %s", role, room_id[:8])
    await safe_send(
        websocket,
        {
            "type": "welcome",
            "role": role,
            "peer_connected": peer is not None,
            "expires_at": int(deadline),
        },
    )
    if peer is not None:
        await safe_send(peer, {"type": "peer-joined"})

    limiter = SignalRateLimiter(
        settings.signal_rate_max_messages,
        settings.signal_rate_window_seconds,
    )
    try:
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                await websocket.close(code=4408, reason="Call session expired")
                break
            try:
                event = await asyncio.wait_for(websocket.receive(), timeout=remaining)
            except TimeoutError:
                await websocket.close(code=4408, reason="Call session expired")
                break

            if event.get("type") == "websocket.disconnect":
                break
            if event.get("bytes") is not None:
                await websocket.close(code=1003, reason="Text messages are required")
                break

            raw_message = event.get("text")
            if not isinstance(raw_message, str):
                await websocket.close(code=1003, reason="Text messages are required")
                break
            if len(raw_message.encode("utf-8")) > settings.max_signal_bytes:
                await websocket.close(code=1009, reason="Signal message is too large")
                break
            if not limiter.allow():
                await websocket.close(code=4429, reason="Signal rate limit exceeded")
                break

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.close(code=1007, reason="Invalid JSON")
                break
            forwarded = validated_signal(message)
            if forwarded is None:
                await safe_send(
                    websocket,
                    {"type": "signal-error", "message": "Invalid signal payload"},
                )
                continue

            peer = await hub.peer(room_id, role)
            if peer is None:
                await safe_send(websocket, {"type": "peer-unavailable"})
                continue
            await safe_send(peer, forwarded)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        peer = await hub.disconnect(
            room_id,
            role,
            access_token,
            websocket,
        )
        await safe_send(peer, {"type": "peer-left"})
        logger.info("Participant %s left room %s", role, room_id[:8])
