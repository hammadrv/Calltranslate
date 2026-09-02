# Calltranslate

A two-person WebRTC call that translates Arabic and English speech in realtime.
Each participant receives a signed link that fixes their listening language:

- Arabic link: speak Arabic and hear the other participant translated to Arabic.
- English link: speak English and hear the other participant translated to English.

The original remote track is used only as translation input and is never attached
to an audible element. Only the translated OpenAI audio track is played.

## Architecture

1. FastAPI serves the mobile web interface and relays WebRTC signaling.
2. The browsers establish a private peer WebRTC connection with separate audio
   tracks.
3. Each listener sends the incoming remote track to a separate
   **gpt-realtime-translate** WebRTC connection.
4. The app server exchanges the browser's SDP with OpenAI. Neither the permanent
   API key nor the short-lived OpenAI client secret is returned to the browser.
5. OpenAI returns translated speech as a remote media track and source/translated
   captions over a data channel. The original remote track is never played.

## Local setup

~~~bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
export ROOM_SIGNING_SECRET="$(openssl rand -hex 32)"
export ROOM_ADMIN_TOKEN="$(openssl rand -hex 24)"
export OPENAI_API_KEY_FILE="/absolute/path/to/openai_api_key"
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
~~~

Open http://127.0.0.1:8000, enter `ROOM_ADMIN_TOKEN`, create a room, and use
the two generated links. Each invitation is single-use; reloading the same tab is
supported through its short-lived session storage.
Microphone access on remote phones requires a trusted HTTPS URL.

Never put a real API key in this repository. In production, the included systemd
unit loads **/etc/calltranslate/openai_api_key** as a protected service credential.
The source file is root-only and never belongs in Git.

## Test

~~~bash
.venv/bin/pytest
node --check static/lobby.js
node --check static/call.js
~~~

## Main environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| OPENAI_API_KEY_FILE | empty | Path to the API key file |
| ROOM_SIGNING_SECRET | random per boot | Signs expiring participant links |
| ROOM_ADMIN_TOKEN | empty (room creation disabled) | Protects room creation |
| PUBLIC_BASE_URL | request origin | Public HTTPS origin used in room links |
| ROOM_TTL_SECONDS | 21600 | Room-link lifetime |
| ROOM_ACCESS_TTL_SECONDS | 2700 | Browser access-session lifetime |
| MAX_CALL_SECONDS | 1800 | Signaling call limit for this test build |
| REALTIME_CALL_MAX_GRANTS | 3 | Translation setup attempts per invitation |
| STUN_URLS | Google public STUN | Comma-separated STUN URLs |
| TURN_URLS | empty | Comma-separated TURN URLs |
| TURN_SHARED_SECRET | empty | Creates one-hour TURN REST credentials |

The current room/signaling state is in memory, so run exactly one Uvicorn worker.
For reliable calls across restrictive mobile networks, configure Coturn and the
relay port range; STUN-only operation is suitable for the first test but cannot
traverse every NAT.

OpenAI reference:
[Realtime translation](https://developers.openai.com/api/docs/guides/realtime-translation).
