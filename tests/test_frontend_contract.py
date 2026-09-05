from __future__ import annotations

import re
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CALL_HTML = PROJECT_ROOT / "static" / "call.html"
CALL_JS = PROJECT_ROOT / "static" / "call.js"
STYLES_CSS = PROJECT_ROOT / "static" / "styles.css"
APP_HTML = PROJECT_ROOT / "static" / "app.html"
APP_JS = PROJECT_ROOT / "static" / "app.js"
APP_CSS = PROJECT_ROOT / "static" / "app.css"


class CallPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.elements.append((tag, dict(attrs)))

    def find_by_id(self, element_id: str) -> tuple[str, dict[str, str | None]]:
        matches = [
            element
            for element in self.elements
            if element[1].get("id") == element_id
        ]
        assert len(matches) == 1, f"Expected exactly one #{element_id}, found {len(matches)}"
        return matches[0]


def parse_call_page() -> CallPageParser:
    parser = CallPageParser()
    parser.feed(CALL_HTML.read_text(encoding="utf-8"))
    return parser


def test_call_page_dom_matches_javascript_bindings() -> None:
    parser = parse_call_page()
    javascript = CALL_JS.read_text(encoding="utf-8")
    html_ids = [attrs["id"] for _, attrs in parser.elements if attrs.get("id")]

    duplicates = sorted(
        element_id for element_id, count in Counter(html_ids).items() if count > 1
    )
    assert duplicates == [], f"Duplicate DOM ids: {duplicates}"

    bound_ids = set(
        re.findall(r'document\.getElementById\(["\']([^"\']+)["\']\)', javascript)
    )
    missing_ids = sorted(bound_ids - set(html_ids))
    assert bound_ids, "call.js should bind its interactive elements by id"
    assert missing_ids == [], f"JavaScript references missing DOM ids: {missing_ids}"
    assert {"errorText", "audioUnlockButton", "audioUnlockLabel"} <= bound_ids


def test_call_controls_keep_accessible_state_contracts() -> None:
    parser = parse_call_page()

    for button_id in ("joinButton", "muteButton", "leaveButton"):
        tag, attrs = parser.find_by_id(button_id)
        assert tag == "button"
        assert attrs.get("type") == "button"

    _, mute = parser.find_by_id("muteButton")
    assert mute.get("aria-pressed") == "false"

    _, status = parser.find_by_id("statusLine")
    assert status.get("role") == "status"
    assert status.get("aria-live") == "polite"

    _, error = parser.find_by_id("errorBanner")
    assert error.get("role") == "alert"

    _, controls = parser.find_by_id("callControls")
    assert controls.get("role") == "group"

    audio_button_tag, audio_button = parser.find_by_id("audioUnlockButton")
    assert audio_button_tag == "button"
    assert audio_button.get("type") == "button"

    audio_tag, audio = parser.find_by_id("translatedAudio")
    assert audio_tag == "audio"
    assert "autoplay" in audio
    assert "playsinline" in audio


def test_call_page_is_mobile_safe_and_motion_respectful() -> None:
    parser = parse_call_page()
    styles = STYLES_CSS.read_text(encoding="utf-8")
    meta = [attrs for tag, attrs in parser.elements if tag == "meta"]
    viewport = next(
        attrs.get("content", "")
        for attrs in meta
        if attrs.get("name") == "viewport"
    )

    assert "width=device-width" in viewport
    assert "initial-scale=1" in viewport
    assert "viewport-fit=cover" in viewport
    for edge in ("top", "right", "bottom", "left"):
        assert f"env(safe-area-inset-{edge})" in styles

    mobile_breakpoints = [
        int(width)
        for width in re.findall(r"@media\s*\(max-width:\s*(\d+)px\)", styles)
    ]
    assert mobile_breakpoints and min(mobile_breakpoints) <= 600
    assert re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)", styles)


def test_visual_call_states_are_kept_in_sync_by_javascript() -> None:
    parser = parse_call_page()
    javascript = CALL_JS.read_text(encoding="utf-8")
    body = next(attrs for tag, attrs in parser.elements if tag == "body")

    assert body.get("data-call-state") == "loading"
    assert "document.body.dataset.callState" in javascript
    for state in (
        "loading",
        "ready",
        "permission",
        "waiting",
        "connecting",
        "live",
        "reconnecting",
        "ended",
        "error",
    ):
        assert f'"{state}"' in javascript


def test_audio_unlock_error_ui_is_not_destroyed_when_message_changes() -> None:
    javascript = CALL_JS.read_text(encoding="utf-8")

    assert 'document.getElementById("errorText")' in javascript
    assert 'document.getElementById("audioUnlockButton")' in javascript
    assert 'document.getElementById("audioUnlockLabel")' in javascript
    assert "el.error.textContent" not in javascript


def test_both_languages_have_the_same_ui_message_keys() -> None:
    javascript = CALL_JS.read_text(encoding="utf-8")
    match = re.search(
        r"const messages\s*=\s*\{\s*ar:\s*\{(?P<ar>.*?)\n\s*\},\s*en:\s*\{(?P<en>.*?)\n\s*\},\s*\};",
        javascript,
        flags=re.DOTALL,
    )
    assert match is not None, "Unable to find the bilingual UI messages"

    def keys(block: str) -> set[str]:
        return set(re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*):", block, flags=re.MULTILINE))

    arabic_keys = keys(match.group("ar"))
    english_keys = keys(match.group("en"))
    assert arabic_keys == english_keys
    assert {
        "join",
        "mute",
        "unmute",
        "leave",
        "waiting",
        "live",
        "captions",
        "generic",
    } <= arabic_keys

    assert "document.documentElement.lang = language" in javascript
    assert 'document.documentElement.dir = language === "ar" ? "rtl" : "ltr"' in javascript


def test_call_page_loads_only_local_frontend_assets() -> None:
    parser = parse_call_page()
    asset_urls = [
        value
        for tag, attrs in parser.elements
        for attribute in (
            ("src",) if tag == "script" else (("href",) if tag == "link" else ())
        )
        if (value := attrs.get(attribute))
    ]

    assert "/static/call.js" in asset_urls
    assert "/static/styles.css" in asset_urls
    assert all(url.startswith("/static/") for url in asset_urls)


def test_app_shell_tracks_the_visible_mobile_viewport() -> None:
    html = APP_HTML.read_text(encoding="utf-8")
    javascript = APP_JS.read_text(encoding="utf-8")
    styles = APP_CSS.read_text(encoding="utf-8")

    assert "viewport-fit=cover" in html
    assert "window.visualViewport?.height" in javascript
    assert '--app-height' in javascript
    assert "height: var(--app-height, 100dvh)" in styles
    assert "env(safe-area-inset-bottom)" in styles


def test_app_mobile_navigation_and_header_keep_safe_spacing() -> None:
    html = APP_HTML.read_text(encoding="utf-8")
    javascript = APP_JS.read_text(encoding="utf-8")
    styles = APP_CSS.read_text(encoding="utf-8")

    assert 'class="tg-bottom-nav" aria-label=' in html
    for tab_id in ("navTabChats", "navTabRequests", "navTabSettings"):
        assert re.search(rf'id="{tab_id}"[^>]*type="button"', html)
    for edge in ("right", "bottom", "left"):
        assert f"env(safe-area-inset-{edge})" in styles
    assert 'id="btnHeaderProfile" class="tg-header-profile" type="button"' in html
    assert 'id="headerUserAvatar"' in html
    assert 'class="tg-header-brand"' in html
    assert 'class="tg-brand-mark"' in html
    assert "headerUserAvatar: document.getElementById" in javascript
    assert "text-overflow: ellipsis" in styles
    assert re.search(r"\.tg-fab-button\s*\{[^}]*bottom:\s*18px", styles, re.DOTALL)


def test_app_has_refined_contact_and_empty_states_without_plan_badges() -> None:
    html = APP_HTML.read_text(encoding="utf-8")
    javascript = APP_JS.read_text(encoding="utf-8")
    styles = APP_CSS.read_text(encoding="utf-8")

    assert 'app.css?v=5.1' in html
    assert 'app.js?v=5.1' in html
    assert 'row.className = "tg-chat-row"' in javascript
    assert 'document.createElement("button")' in javascript
    assert 'class="tg-empty-action"' in javascript
    assert 'welcomeCard.className = "tg-welcome-card"' in javascript
    assert "openAddFriendModal" in javascript
    assert "#contactsContainer" in styles
    assert "backdrop-filter: blur(20px)" in styles
    assert re.search(r"@media\s*\(prefers-reduced-motion:\s*reduce\)", styles)
    assert "Premium" not in html
    assert "الدقائق المتبقية" not in html


def test_app_login_and_chat_rendering_keep_user_state_initialized() -> None:
    html = APP_HTML.read_text(encoding="utf-8")
    javascript = APP_JS.read_text(encoding="utf-8")
    styles = APP_CSS.read_text(encoding="utf-8")

    assert javascript.count("currentUser = data.user;") >= 3
    assert "stripSensitiveAuthParams" in javascript
    assert '["username", "password"]' in javascript
    assert re.search(r'id="loginForm"[^>]*method="post"', html)
    assert re.search(r'id="registerForm"[^>]*method="post"', html)
    assert "showChatMessageState" in javascript
    assert "tg-chat-message-state" in styles


def test_app_mute_control_matches_the_real_audio_track_state() -> None:
    parser = CallPageParser()
    parser.feed(APP_HTML.read_text(encoding="utf-8"))
    javascript = APP_JS.read_text(encoding="utf-8")
    styles = APP_CSS.read_text(encoding="utf-8")

    tag, mute = parser.find_by_id("btnCallMute")
    assert tag == "button"
    assert mute.get("type") == "button"
    assert mute.get("aria-pressed") == "false"
    assert 'class="tg-mic-muted-slash"' in APP_HTML.read_text(encoding="utf-8")
    assert "track.enabled = !isMuted" in javascript
    assert 'classList.toggle("active-mute", isMuted)' in javascript
    assert 'setAttribute("aria-pressed", String(isMuted))' in javascript
    assert "setCallMuted(tracks.some((track) => track.enabled))" in javascript
    assert ".tg-btn-mute.active-mute .tg-mic-muted-slash" in styles
