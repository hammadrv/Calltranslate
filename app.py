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

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import db
import httpx
import websockets
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
GEMINI_BIDI_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
GEMINI_MODELS = {
    "gemini-2.5-flash-native-audio-latest": "models/gemini-2.5-flash-native-audio-latest",
    "gemini-3.5-live-translate-preview": "models/gemini-3.5-live-translate-preview",
}
DEFAULT_GEMINI_MODEL = "gemini-3.5-live-translate-preview"
ROOM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{12,80}$")
ACCESS_TOKEN_PATTERN = re.compile(r"^ct_[A-Za-z0-9_-]{32,100}$")
FIXED_LINK_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
VALID_ROLES = {"ar", "en"}
PEER_ROLE = {"ar": "en", "en": "ar"}
TARGET_LANGUAGE = {"ar": "ar", "en": "en"}
FORWARDED_SIGNAL_TYPES = {"offer", "answer", "ice-candidate", "hangup"}
DEFAULT_FIXED_ROOM_ID = "calltranslate-main"

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
        configured_fixed_room_id = os.getenv(
            "FIXED_ROOM_ID", DEFAULT_FIXED_ROOM_ID
        ).strip()
        if ROOM_ID_PATTERN.fullmatch(configured_fixed_room_id):
            self.fixed_room_id = configured_fixed_room_id
        else:
            logger.warning(
                "Invalid FIXED_ROOM_ID value; using %s", DEFAULT_FIXED_ROOM_ID
            )
            self.fixed_room_id = DEFAULT_FIXED_ROOM_ID
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

    def fixed_link_token(self, role: str) -> str:
        env_names = {
            "ar": "FIXED_AR_LINK_TOKEN",
            "en": "FIXED_EN_LINK_TOKEN",
        }
        env_name = env_names.get(role)
        if env_name is None:
            return ""
        value = os.getenv(env_name, "").strip()
        if not FIXED_LINK_TOKEN_PATTERN.fullmatch(value):
            return ""
        peer_value = os.getenv(env_names[PEER_ROLE[role]], "").strip()
        if value == peer_value:
            return ""
        return value

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

    def gemini_api_key(self) -> str:
        value = os.getenv("GEMINI_API_KEY", "").strip()
        key_file = os.getenv("GEMINI_API_KEY_FILE", "").strip()

        if not value and key_file:
            try:
                value = Path(key_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                logger.error("Unable to read GEMINI_API_KEY_FILE: %s", exc)
                return ""

        if not value:
            for candidate in ("gimini key.txt", "gemini_key.txt", "gemini key.txt"):
                candidate_path = BASE_DIR / candidate
                if candidate_path.is_file():
                    try:
                        value = candidate_path.read_text(encoding="utf-8").strip()
                        if value:
                            break
                    except OSError:
                        pass

        if value.startswith("GEMINI_API_KEY="):
            value = value.removeprefix("GEMINI_API_KEY=").strip()
        return value


settings = Settings()


class RoomAccessRequest(BaseModel):
    room_id: str = Field(min_length=12, max_length=80)
    role: str = Field(min_length=2, max_length=2)
    token: str = Field(min_length=20, max_length=256)


class FixedAccessRequest(BaseModel):
    token: str = Field(min_length=32, max_length=128)


class RegisterInput(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(default="", max_length=64)
    language: str = Field(default="ar", max_length=10)


class LoginInput(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)


class ContactInput(BaseModel):
    username: str = Field(min_length=3, max_length=32)


class LanguageInput(BaseModel):
    language: str = Field(min_length=2, max_length=10)


class AdminModelInput(BaseModel):
    model: str = Field(min_length=3, max_length=64)


class AdminPasswordInput(BaseModel):
    password: str = Field(min_length=6, max_length=128)


class MessageInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


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

    async def issue_fixed_access(
        self,
        room_id: str,
        role: str,
        *,
        now: float | None = None,
    ) -> tuple[str, AccessGrant]:
        """Issue a short-lived grant for a reusable, server-defined room route."""
        if role not in VALID_ROLES or not valid_room_id(room_id):
            raise ValueError("Invalid fixed-room access scope")

        current_time = time.time() if now is None else now
        access_token = "ct_" + secrets.token_urlsafe(32)
        grant = AccessGrant(
            room_id=room_id,
            role=role,
            expires_at=current_time + settings.access_ttl_seconds,
        )
        async with self._lock:
            self._prune(current_time)
            self._access[_token_digest(access_token)] = grant
        return access_token, replace(grant)

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


class UserHub:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._connections: dict[str, set[WebSocket]] = {}

    async def connect(self, username: str, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.setdefault(username.lower(), set()).add(ws)

    async def disconnect(self, username: str, ws: WebSocket) -> None:
        async with self._lock:
            user_set = self._connections.get(username.lower())
            if user_set:
                user_set.discard(ws)
                if not user_set:
                    self._connections.pop(username.lower(), None)

    async def send_to_user(self, username: str, message: dict[str, Any]) -> bool:
        async with self._lock:
            sockets = list(self._connections.get(username.lower(), set()))
        if not sockets:
            return False
        for s in sockets:
            await safe_send(s, message)
        return True

    def is_online(self, username: str) -> bool:
        return bool(self._connections.get(username.lower()))


user_hub = UserHub()
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


def get_current_user(request: Request) -> dict[str, Any]:
    auth = request.headers.get("Authorization")
    token = None
    if auth and auth.startswith("Bearer "):
        token = auth[len("Bearer ") :].strip()
    if not token and "usr_token" in request.cookies:
        token = request.cookies.get("usr_token")
    if not token:
        token = request.query_params.get("token")
    if not token or not token.startswith("usr_"):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = db.get_user_by_session(token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


def require_admin_user(request: Request) -> dict[str, Any]:
    user = get_current_user(request)
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_fixed_link(role: str, provided_token: str) -> None:
    if role not in VALID_ROLES:
        raise HTTPException(status_code=404, detail="Not found")
    configured_token = settings.fixed_link_token(role)
    if not configured_token:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "fixed_link_not_configured",
                "message": "Permanent participant links are not configured",
            },
        )
    if (
        not FIXED_LINK_TOKEN_PATTERN.fullmatch(provided_token)
        or not hmac.compare_digest(configured_token, provided_token)
    ):
        raise HTTPException(status_code=403, detail="Permanent link is invalid")


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


@app.get("/app", include_in_schema=False)
async def app_page() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "app.html",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.get("/admin", include_in_schema=False)
async def admin_page() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "admin.html",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.get("/docs-app", include_in_schema=False)
async def docs_app_page() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "docs.html",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@app.get("/healthz", include_in_schema=False)
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


# User Auth Endpoints
@app.post("/api/auth/register")
async def auth_register(data: RegisterInput) -> JSONResponse:
    try:
        user = db.create_user(
            username=data.username,
            password=data.password,
            display_name=data.display_name,
            language=data.language,
        )
        token = db.create_session(user["id"])
        return JSONResponse({"token": token, "user": user})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/auth/login")
async def auth_login(data: LoginInput) -> JSONResponse:
    user = db.authenticate_user(data.username, data.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = db.create_session(user["id"])
    return JSONResponse({"token": token, "user": user})


@app.get("/api/auth/me")
async def auth_me(request: Request) -> JSONResponse:
    user = get_current_user(request)
    return JSONResponse({"user": user})


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> JSONResponse:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer ") :].strip()
        db.delete_session(token)
    return JSONResponse({"status": "logged_out"})


@app.put("/api/user/language")
async def update_language(data: LanguageInput, request: Request) -> JSONResponse:
    user = get_current_user(request)
    db.update_user_language(user["id"], data.language)
    return JSONResponse({"status": "updated", "language": data.language})


# Contacts Endpoints
@app.get("/api/contacts")
async def get_contacts(request: Request) -> JSONResponse:
    user = get_current_user(request)
    contacts = db.list_contacts(user["id"])
    for c in contacts:
        c["is_online"] = user_hub.is_online(c["username"])
    return JSONResponse({"contacts": contacts})


@app.post("/api/contacts")
async def add_contact(data: ContactInput, request: Request) -> JSONResponse:
    user = get_current_user(request)
    try:
        contact = db.add_contact(user["id"], data.username)
        contact["is_online"] = user_hub.is_online(contact["username"])
        return JSONResponse({"contact": contact})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/contacts/{username}")
async def delete_contact(username: str, request: Request) -> JSONResponse:
    user = get_current_user(request)
    db.remove_contact(user["id"], username)
    await user_hub.send_to_user(
        username.lower(),
        {
            "type": "contact_removed",
            "by_username": user["username"],
        },
    )
    return JSONResponse({"status": "removed"})


# Friend Requests Endpoints
@app.get("/api/friend-requests")
async def get_friend_requests(request: Request) -> JSONResponse:
    user = get_current_user(request)
    incoming = db.list_incoming_friend_requests(user["id"])
    outgoing = db.list_outgoing_friend_requests(user["id"])
    return JSONResponse({"incoming": incoming, "outgoing": outgoing, "requests": incoming})


@app.post("/api/friend-requests")
async def send_friend_request(data: ContactInput, request: Request) -> JSONResponse:
    user = get_current_user(request)
    try:
        result = db.send_friend_request(user["id"], data.username)
        # Real-time notify recipient if online
        await user_hub.send_to_user(
            data.username.lower(),
            {
                "type": "friend_request_received",
                "from_username": user["username"],
                "from_name": user["display_name"],
            },
        )
        return JSONResponse(result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/friend-requests/{request_id}/accept")
async def accept_friend_request(request_id: int, request: Request) -> JSONResponse:
    user = get_current_user(request)
    try:
        result = db.accept_friend_request(request_id, user["id"])
        # Real-time notify the requester if online
        if result.get("from_username"):
            await user_hub.send_to_user(
                result["from_username"].lower(),
                {
                    "type": "friend_request_accepted",
                    "by_username": user["username"],
                    "by_name": user["display_name"],
                },
            )
        return JSONResponse({"status": "accepted", **result})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/friend-requests/{request_id}/reject")
async def reject_friend_request(request_id: int, request: Request) -> JSONResponse:
    user = get_current_user(request)
    db.reject_friend_request(request_id, user["id"])
    return JSONResponse({"status": "rejected"})


@app.post("/api/friend-requests/{request_id}/cancel")
async def cancel_friend_request(request_id: int, request: Request) -> JSONResponse:
    user = get_current_user(request)
    db.cancel_friend_request(request_id, user["id"])
    return JSONResponse({"status": "cancelled"})


# Real-time Translation Helper for Text Chat
async def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    if source_lang == target_lang or not text.strip():
        return ""
    target_name = "Arabic" if target_lang == "ar" else "English"
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    if gemini_key:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={gemini_key}"
            prompt = (
                f"You are an instant chat translator. Translate the following user message into natural, casual {target_name}. "
                f"Output ONLY the translated message, with no quotes, notes, explanations, or extra text:\n\n{text}"
            )
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.post(url, json={"contents": [{"parts": [{"text": prompt}]}]})
                if res.status_code == 200:
                    data = res.json()
                    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    if parts and parts[0].get("text"):
                        return parts[0]["text"].strip()
        except Exception as exc:
            logger.warning("Gemini text translation failed: %s", exc)
    return ""


# Chat Messages Endpoints
@app.get("/api/messages/{username}")
async def get_chat_messages(username: str, request: Request) -> JSONResponse:
    user = get_current_user(request)
    conn = db.get_connection()
    try:
        target_row = conn.execute(
            "SELECT id, username, display_name, language FROM users WHERE username = ?",
            (username.strip().lower(),)
        ).fetchone()
        if not target_row:
            raise HTTPException(status_code=404, detail="User not found")
        target_id = target_row["id"]
    finally:
        conn.close()

    msgs = db.list_conversation_messages(user["id"], target_id, limit=60)
    return JSONResponse({"messages": msgs})


@app.post("/api/messages/{username}")
async def send_chat_message(username: str, data: MessageInput, request: Request) -> JSONResponse:
    user = get_current_user(request)
    conn = db.get_connection()
    try:
        target_row = conn.execute(
            "SELECT id, username, display_name, language FROM users WHERE username = ?",
            (username.strip().lower(),)
        ).fetchone()
        if not target_row:
            raise HTTPException(status_code=404, detail="User not found")
        target_id = target_row["id"]
        target_lang = target_row["language"]
    finally:
        conn.close()

    text = data.text.strip()
    translated = await translate_text(text, user["language"], target_lang)

    msg_record = db.save_message(
        from_user_id=user["id"],
        to_user_id=target_id,
        original_text=text,
        translated_text=translated,
        from_lang=user["language"],
        to_lang=target_lang,
    )

    # Real-time WebSocket delivery to recipient
    await user_hub.send_to_user(
        username.lower(),
        {
            "type": "new_chat_message",
            "message": msg_record,
            "sender_username": user["username"],
            "sender_name": user["display_name"],
        },
    )

    return JSONResponse({"message": msg_record})


# Admin Dashboard Endpoints
@app.get("/api/admin/users")
async def admin_get_users(request: Request) -> JSONResponse:
    require_admin_user(request)
    users = db.list_all_users()
    for u in users:
        u["is_online"] = user_hub.is_online(u["username"])
    return JSONResponse({
        "users": users,
        "available_models": db.AVAILABLE_MODELS,
        "default_model": db.DEFAULT_MODEL,
    })


@app.put("/api/admin/users/{user_id}/model")
async def admin_set_model(user_id: int, data: AdminModelInput, request: Request) -> JSONResponse:
    require_admin_user(request)
    try:
        db.set_user_model(user_id, data.model)
        return JSONResponse({"status": "updated", "model": data.model})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.put("/api/admin/users/{user_id}/password")
async def admin_set_password(user_id: int, data: AdminPasswordInput, request: Request) -> JSONResponse:
    require_admin_user(request)
    try:
        db.set_user_password(user_id, data.password)
        return JSONResponse({"status": "updated"})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request) -> JSONResponse:
    admin = require_admin_user(request)
    if admin["id"] == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete your own admin account")
    db.delete_user(user_id)
    return JSONResponse({"status": "deleted"})


@app.get("/join/{role}/{link_token}", include_in_schema=False)
async def fixed_call_page(role: str, link_token: str) -> FileResponse:
    require_fixed_link(role, link_token)
    return FileResponse(
        STATIC_DIR / "call.html",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


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


@app.post("/api/fixed-access/{role}")
async def create_fixed_access(role: str, payload: FixedAccessRequest) -> JSONResponse:
    require_fixed_link(role, payload.token)
    access_token, grant = await room_store.issue_fixed_access(
        settings.fixed_room_id,
        role,
    )
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
    has_openai = bool(settings.openai_api_key())
    has_gemini = bool(settings.gemini_api_key())
    return JSONResponse(
        {
            "room_id": grant.room_id,
            "role": grant.role,
            "ice_servers": ice_servers(grant.room_id),
            "translation_configured": has_openai or has_gemini,
            "openai_configured": has_openai,
            "gemini_configured": has_gemini,
            "gemini_key": settings.gemini_api_key(),
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


@app.websocket("/ws/gemini-live/{room_id}/{role}")
async def gemini_live_socket(websocket: WebSocket, room_id: str, role: str) -> None:
    if not websocket_origin_allowed(websocket):
        await websocket.close(code=4403, reason="Origin is not allowed")
        return

    access_token = websocket.query_params.get("token") or websocket_access_token(websocket)
    if not access_token or not ACCESS_TOKEN_PATTERN.fullmatch(access_token):
        await websocket.close(code=4401, reason="Missing or invalid access token")
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

    gemini_key = settings.gemini_api_key()
    if not gemini_key:
        await websocket.close(code=4503, reason="Gemini API is not configured on server")
        return

    model_param = websocket.query_params.get("model", DEFAULT_GEMINI_MODEL)
    model_name = GEMINI_MODELS.get(model_param, GEMINI_MODELS[DEFAULT_GEMINI_MODEL])

    subprotocol = "calltranslate" if "calltranslate" in websocket.scope.get("subprotocols", []) else None
    await websocket.accept(subprotocol=subprotocol)

    gemini_url = f"{GEMINI_BIDI_WS_URL}?key={gemini_key}"

    if role == "ar":
        instruction = (
            "You are an instant speech-to-speech interpreter translating for a live phone call. "
            "Listen to incoming English speech and translate it immediately into natural, clear Arabic speech. "
            "Output ONLY the spoken Arabic translation. "
            "Do not answer the speaker, do not converse, and do not add commentary."
        )
        voice_name = "Aoede"
    else:
        instruction = (
            "You are an instant speech-to-speech interpreter translating for a live phone call. "
            "Listen to incoming Arabic speech and translate it immediately into natural, clear English speech. "
            "Output ONLY the spoken English translation. "
            "Do not answer the speaker, do not converse, and do not add commentary."
        )
        voice_name = "Puck"

    setup_payload = {
        "setup": {
            "model": model_name,
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": voice_name
                        }
                    }
                }
            },
            "systemInstruction": {
                "parts": [{"text": instruction}]
            }
        }
    }

    try:
        async with websockets.connect(
            gemini_url,
            open_timeout=15,
            close_timeout=5,
            ping_interval=20,
            ping_timeout=20,
            max_size=4 * 1024 * 1024,
        ) as gemini_ws:
            await gemini_ws.send(json.dumps(setup_payload))
            init_response = await gemini_ws.recv()
            if isinstance(init_response, bytes):
                init_response = init_response.decode("utf-8")
            init_data = json.loads(init_response)
            if "setupComplete" not in init_data:
                logger.warning("Gemini setup error: %s", init_response)
                await websocket.send_json({"type": "error", "message": "Gemini setup failed"})
                await websocket.close(code=1011, reason="Gemini setup failed")
                return

            await websocket.send_json({"type": "ready"})

            async def client_to_gemini() -> None:
                while True:
                    data = await websocket.receive_text()
                    msg = json.loads(data)
                    msg_type = msg.get("type", "audio")
                    if msg_type == "audio":
                        audio_b64 = msg.get("data")
                        rate = msg.get("rate", 16000)
                        if audio_b64:
                            gemini_msg = {
                                "realtimeInput": {
                                    "mediaChunks": [
                                        {
                                            "mimeType": f"audio/pcm;rate={rate}",
                                            "data": audio_b64,
                                        }
                                    ]
                                }
                            }
                            await gemini_ws.send(json.dumps(gemini_msg))

            async def gemini_to_client() -> None:
                async for raw_msg in gemini_ws:
                    if isinstance(raw_msg, bytes):
                        raw_msg = raw_msg.decode("utf-8")
                    resp = json.loads(raw_msg)
                    server_content = resp.get("serverContent")
                    if server_content:
                        model_turn = server_content.get("modelTurn")
                        if model_turn:
                            for part in model_turn.get("parts", []):
                                if "inlineData" in part:
                                    inline = part["inlineData"]
                                    await websocket.send_json({
                                        "type": "audio",
                                        "data": inline.get("data"),
                                        "mimeType": inline.get("mimeType", "audio/pcm;rate=24000"),
                                    })
                                if "text" in part:
                                    await websocket.send_json({
                                        "type": "transcript",
                                        "role": "translated",
                                        "text": part["text"],
                                    })
                        if server_content.get("interrupted"):
                            await websocket.send_json({"type": "interrupted"})
                        if server_content.get("turnComplete"):
                            await websocket.send_json({"type": "turnComplete"})

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_gemini()),
                    asyncio.create_task(gemini_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("Gemini Live session error: %s", exc)
        try:
            await websocket.close(code=1011, reason="Gemini connection error")
        except Exception:
            pass


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


@app.websocket("/ws/user-hub")
async def user_hub_ws(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not token:
        requested = websocket.headers.get("sec-websocket-protocol", "")
        for item in requested.split(","):
            val = item.strip()
            if val.startswith("usr_"):
                token = val
                break
    if not token or not token.startswith("usr_"):
        await websocket.close(code=4401, reason="Authentication required")
        return
    user = db.get_user_by_session(token)
    if not user:
        await websocket.close(code=4403, reason="Session invalid or expired")
        return

    subprotocol = token if token in websocket.headers.get("sec-websocket-protocol", "") else None
    await websocket.accept(subprotocol=subprotocol)
    username = user["username"]
    await user_hub.connect(username, websocket)

    try:
        await safe_send(
            websocket,
            {
                "type": "connected",
                "username": username,
                "display_name": user["display_name"],
                "language": user["language"],
                "model": user["effective_model"],
                "is_admin": user["is_admin"],
            },
        )
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            action = msg.get("type")
            if action == "call_user":
                target_username = msg.get("target", "").strip().lower()
                target_user = None
                conn = db.get_connection()
                try:
                    t_row = conn.execute(
                        "SELECT id, username, display_name, language, assigned_model FROM users WHERE username = ?",
                        (target_username,),
                    ).fetchone()
                    if t_row:
                        target_user = {
                            "id": t_row["id"],
                            "username": t_row["username"],
                            "display_name": t_row["display_name"],
                            "language": t_row["language"],
                            "effective_model": db.DEFAULT_MODEL
                            if t_row["assigned_model"] == "default"
                            else t_row["assigned_model"],
                        }
                finally:
                    conn.close()

                if not target_user:
                    await safe_send(
                        websocket, {"type": "call_error", "message": "User not found"}
                    )
                    continue
                if not user_hub.is_online(target_username):
                    await safe_send(
                        websocket,
                        {
                            "type": "call_error",
                            "message": f"{target_user['display_name']} is offline",
                        },
                    )
                    continue

                room_id = secrets.token_urlsafe(18)
                await room_store.create_room(
                    room_id, int(time.time()) + settings.room_ttl_seconds
                )

                caller_lang = user["language"]
                target_lang = target_user["language"]
                if caller_lang == "ar" and target_lang == "en":
                    caller_role, callee_role = "ar", "en"
                elif caller_lang == "en" and target_lang == "ar":
                    caller_role, callee_role = "en", "ar"
                else:
                    caller_role, callee_role = "ar", "en"

                caller_token, _ = await room_store.issue_fixed_access(room_id, caller_role)
                callee_token, _ = await room_store.issue_fixed_access(room_id, callee_role)

                await safe_send(
                    websocket,
                    {
                        "type": "call_initiating",
                        "room_id": room_id,
                        "role": caller_role,
                        "access_token": caller_token,
                        "target": target_user["username"],
                        "target_name": target_user["display_name"],
                        "target_language": target_user["language"],
                        "model": user["effective_model"],
                    },
                )

                await user_hub.send_to_user(
                    target_user["username"],
                    {
                        "type": "incoming_call",
                        "room_id": room_id,
                        "role": callee_role,
                        "access_token": callee_token,
                        "caller": user["username"],
                        "caller_name": user["display_name"],
                        "caller_language": user["language"],
                        "model": target_user["effective_model"],
                    },
                )

            elif action == "accept_call":
                caller = msg.get("caller")
                room_id = msg.get("room_id")
                if caller:
                    await user_hub.send_to_user(
                        caller,
                        {
                            "type": "call_accepted",
                            "room_id": room_id,
                            "callee": username,
                        },
                    )

            elif action == "reject_call":
                caller = msg.get("caller")
                room_id = msg.get("room_id")
                if caller:
                    await user_hub.send_to_user(
                        caller,
                        {
                            "type": "call_rejected",
                            "room_id": room_id,
                            "callee": username,
                        },
                    )

            elif action == "cancel_call":
                target = msg.get("target")
                room_id = msg.get("room_id")
                if target:
                    await user_hub.send_to_user(
                        target,
                        {
                            "type": "call_cancelled",
                            "room_id": room_id,
                            "caller": username,
                        },
                    )
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await user_hub.disconnect(username, websocket)

