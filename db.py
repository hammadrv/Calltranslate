import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

def get_db_path() -> Path:
    override = os.getenv("CALLTRANSLATE_DB_PATH") or os.getenv("DATABASE_PATH")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / "calltranslate.db"


DEFAULT_MODEL = "gemini-3.5-live-translate-preview"
AVAILABLE_MODELS = [
    {"id": "default", "name": "Default (Gemini 3.5 Live)"},
    {"id": "gemini-3.5-live-translate-preview", "name": "Gemini 3.5 Live"},
    {"id": "gemini-2.5-flash-native-audio-latest", "name": "Gemini 2.5 Flash"},
    {"id": "openai-realtime", "name": "OpenAI Realtime"},
]


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(get_db_path()), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_bytes(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100_000)
    return hashed.hex(), salt.hex()


def verify_password(password: str, password_hash: str, salt_hex: str) -> bool:
    salt = bytes.fromhex(salt_hex)
    hashed, _ = hash_password(password, salt)
    return hmac.compare_digest(hashed, password_hash)


def init_db() -> None:
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    language TEXT NOT NULL DEFAULT 'ar',
                    assigned_model TEXT NOT NULL DEFAULT 'default',
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    last_seen INTEGER NOT NULL DEFAULT 0
                )
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS contacts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    contact_user_id INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(contact_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(user_id, contact_user_id)
                )
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS friend_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_user_id INTEGER NOT NULL,
                    to_user_id INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(from_user_id, to_user_id)
                )
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_user_id INTEGER NOT NULL,
                    to_user_id INTEGER NOT NULL,
                    original_text TEXT NOT NULL,
                    translated_text TEXT NOT NULL DEFAULT '',
                    from_lang TEXT NOT NULL DEFAULT 'ar',
                    to_lang TEXT NOT NULL DEFAULT 'en',
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(from_user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(to_user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user_id, to_user_id);")

            # Seed default admin if not exists
            admin = conn.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
            if not admin:
                pwd_hash, salt = hash_password("AdminPassword123!")
                now = int(time.time())
                conn.execute("""
                    INSERT INTO users (username, password_hash, salt, display_name, language, assigned_model, is_admin, created_at, last_seen)
                    VALUES ('admin', ?, ?, 'Administrator', 'ar', 'default', 1, ?, ?)
                """, (pwd_hash, salt, now, now))
    finally:
        conn.close()


def create_user(username: str, password: str, display_name: str, language: str = "ar") -> dict[str, Any]:
    clean_username = username.strip().lower()
    if not clean_username or len(clean_username) < 3 or len(clean_username) > 32:
        raise ValueError("Username must be between 3 and 32 characters")
    if not password or len(password) < 6:
        raise ValueError("Password must be at least 6 characters")
    
    clean_display = display_name.strip() or clean_username
    clean_lang = "en" if language == "en" else "ar"
    
    pwd_hash, salt = hash_password(password)
    now = int(time.time())
    
    conn = get_connection()
    try:
        with conn:
            cursor = conn.execute("""
                INSERT INTO users (username, password_hash, salt, display_name, language, assigned_model, is_admin, created_at, last_seen)
                VALUES (?, ?, ?, ?, ?, 'default', 0, ?, ?)
            """, (clean_username, pwd_hash, salt, clean_display, clean_lang, now, now))
            user_id = cursor.lastrowid
            return {
                "id": user_id,
                "username": clean_username,
                "display_name": clean_display,
                "language": clean_lang,
                "assigned_model": "default",
                "is_admin": False,
            }
    except sqlite3.IntegrityError:
        raise ValueError("Username already taken")
    finally:
        conn.close()


def authenticate_user(username: str, password: str) -> dict[str, Any] | None:
    clean_username = username.strip().lower()
    conn = get_connection()
    try:
        row = conn.execute("""
            SELECT id, username, password_hash, salt, display_name, language, assigned_model, is_admin
            FROM users WHERE username = ?
        """, (clean_username,)).fetchone()
        if not row:
            return None
        if not verify_password(password, row["password_hash"], row["salt"]):
            return None
        
        now = int(time.time())
        with conn:
            conn.execute("UPDATE users SET last_seen = ? WHERE id = ?", (now, row["id"]))
            
        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "language": row["language"],
            "assigned_model": row["assigned_model"],
            "is_admin": bool(row["is_admin"]),
        }
    finally:
        conn.close()


def create_session(user_id: int, ttl_days: int = 30) -> str:
    token = "usr_" + secrets.token_urlsafe(32)
    now = int(time.time())
    expires_at = now + (ttl_days * 86400)
    conn = get_connection()
    try:
        with conn:
            conn.execute("""
                INSERT INTO sessions (token, user_id, created_at, expires_at)
                VALUES (?, ?, ?, ?)
            """, (token, user_id, now, expires_at))
        return token
    finally:
        conn.close()


def get_user_by_session(token: str) -> dict[str, Any] | None:
    if not token or not token.startswith("usr_"):
        return None
    now = int(time.time())
    conn = get_connection()
    try:
        row = conn.execute("""
            SELECT u.id, u.username, u.display_name, u.language, u.assigned_model, u.is_admin, s.expires_at
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token = ? AND s.expires_at > ?
        """, (token, now)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "language": row["language"],
            "assigned_model": row["assigned_model"],
            "effective_model": DEFAULT_MODEL if row["assigned_model"] == "default" else row["assigned_model"],
            "is_admin": bool(row["is_admin"]),
        }
    finally:
        conn.close()


def delete_session(token: str) -> None:
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    finally:
        conn.close()


def update_user_language(user_id: int, language: str) -> None:
    clean_lang = "en" if language == "en" else "ar"
    conn = get_connection()
    try:
        with conn:
            conn.execute("UPDATE users SET language = ? WHERE id = ?", (clean_lang, user_id))
    finally:
        conn.close()


def add_contact(user_id: int, contact_username: str) -> dict[str, Any]:
    clean_username = contact_username.strip().lower()
    conn = get_connection()
    try:
        contact_row = conn.execute("SELECT id, username, display_name, language FROM users WHERE username = ?", (clean_username,)).fetchone()
        if not contact_row:
            raise ValueError("User not found")
        if contact_row["id"] == user_id:
            raise ValueError("You cannot add yourself as a contact")
        
        now = int(time.time())
        with conn:
            conn.execute("""
                INSERT OR IGNORE INTO contacts (user_id, contact_user_id, created_at)
                VALUES (?, ?, ?)
            """, (user_id, contact_row["id"], now))
            
        return {
            "id": contact_row["id"],
            "username": contact_row["username"],
            "display_name": contact_row["display_name"],
            "language": contact_row["language"],
        }
    finally:
        conn.close()


def send_friend_request(from_user_id: int, to_username: str) -> dict[str, Any]:
    clean_username = to_username.strip().lower()
    conn = get_connection()
    try:
        to_row = conn.execute("SELECT id, username, display_name, language FROM users WHERE username = ?", (clean_username,)).fetchone()
        if not to_row:
            raise ValueError("المستخدم غير موجود")
        if to_row["id"] == from_user_id:
            raise ValueError("لا يمكنك إضافة نفسك كصديق")

        already_friends = conn.execute(
            "SELECT id FROM contacts WHERE user_id = ? AND contact_user_id = ?",
            (from_user_id, to_row["id"]),
        ).fetchone()
        if already_friends:
            raise ValueError("المستخدم موجود بالفعل في قائمة أصدقائك")

        existing_req = conn.execute(
            "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?",
            (from_user_id, to_row["id"]),
        ).fetchone()
        if existing_req:
            raise ValueError("تم إرسال طلب صداقة مسبقاً وبانتظار الموافقة")

        now = int(time.time())
        reverse_req = conn.execute(
            "SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?",
            (to_row["id"], from_user_id),
        ).fetchone()
        if reverse_req:
            with conn:
                conn.execute("DELETE FROM friend_requests WHERE id = ?", (reverse_req["id"],))
                conn.execute("INSERT OR IGNORE INTO contacts (user_id, contact_user_id, created_at) VALUES (?, ?, ?)", (from_user_id, to_row["id"], now))
                conn.execute("INSERT OR IGNORE INTO contacts (user_id, contact_user_id, created_at) VALUES (?, ?, ?)", (to_row["id"], from_user_id, now))
            return {
                "status": "accepted",
                "message": "أصبحتم أصدقاء الآن!",
                "target_username": to_row["username"],
                "target_name": to_row["display_name"],
            }

        with conn:
            cursor = conn.execute(
                "INSERT INTO friend_requests (from_user_id, to_user_id, created_at) VALUES (?, ?, ?)",
                (from_user_id, to_row["id"], now),
            )
            return {
                "status": "pending",
                "request_id": cursor.lastrowid,
                "message": "تم إرسال طلب الصداقة بنجاح!",
                "target_username": to_row["username"],
                "target_name": to_row["display_name"],
            }
    finally:
        conn.close()


def list_incoming_friend_requests(user_id: int) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT r.id AS request_id, u.id AS from_user_id, u.username, u.display_name, u.language, r.created_at
            FROM friend_requests r
            JOIN users u ON r.from_user_id = u.id
            WHERE r.to_user_id = ?
            ORDER BY r.created_at DESC
        """, (user_id,)).fetchall()
        return [
            {
                "request_id": r["request_id"],
                "from_user_id": r["from_user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "language": r["language"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def accept_friend_request(request_id: int, user_id: int) -> dict[str, Any]:
    conn = get_connection()
    try:
        req = conn.execute("SELECT from_user_id, to_user_id FROM friend_requests WHERE id = ?", (request_id,)).fetchone()
        if not req or req["to_user_id"] != user_id:
            raise ValueError("طلب الصداقة غير موجود أو تم إلغاؤه")
        from_id = req["from_user_id"]
        from_user = conn.execute("SELECT username, display_name, language FROM users WHERE id = ?", (from_id,)).fetchone()
        now = int(time.time())
        with conn:
            conn.execute("DELETE FROM friend_requests WHERE id = ?", (request_id,))
            conn.execute("INSERT OR IGNORE INTO contacts (user_id, contact_user_id, created_at) VALUES (?, ?, ?)", (user_id, from_id, now))
            conn.execute("INSERT OR IGNORE INTO contacts (user_id, contact_user_id, created_at) VALUES (?, ?, ?)", (from_id, user_id, now))
        return {
            "from_username": from_user["username"] if from_user else "",
            "from_name": from_user["display_name"] if from_user else "",
        }
    finally:
        conn.close()


def reject_friend_request(request_id: int, user_id: int) -> None:
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM friend_requests WHERE id = ? AND to_user_id = ?", (request_id, user_id))
    finally:
        conn.close()


def list_outgoing_friend_requests(user_id: int) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT r.id AS request_id, u.id AS to_user_id, u.username, u.display_name, u.language, r.created_at
            FROM friend_requests r
            JOIN users u ON r.to_user_id = u.id
            WHERE r.from_user_id = ?
            ORDER BY r.created_at DESC
        """, (user_id,)).fetchall()
        return [
            {
                "request_id": r["request_id"],
                "to_user_id": r["to_user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "language": r["language"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def cancel_friend_request(request_id: int, user_id: int) -> None:
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM friend_requests WHERE id = ? AND from_user_id = ?", (request_id, user_id))
    finally:
        conn.close()


def remove_contact(user_id: int, contact_username: str) -> None:
    conn = get_connection()
    try:
        contact_row = conn.execute("SELECT id FROM users WHERE username = ?", (contact_username.strip().lower(),)).fetchone()
        if not contact_row:
            return
        with conn:
            conn.execute("""
                DELETE FROM contacts 
                WHERE (user_id = ? AND contact_user_id = ?) 
                   OR (user_id = ? AND contact_user_id = ?)
            """, (user_id, contact_row["id"], contact_row["id"], user_id))
    finally:
        conn.close()


def list_contacts(user_id: int) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT u.id, u.username, u.display_name, u.language, u.last_seen
            FROM contacts c
            JOIN users u ON c.contact_user_id = u.id
            WHERE c.user_id = ?
            ORDER BY u.display_name ASC
        """, (user_id,)).fetchall()
        return [
            {
                "id": r["id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "language": r["language"],
                "last_seen": r["last_seen"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def list_all_users() -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT id, username, display_name, language, assigned_model, is_admin, created_at, last_seen
            FROM users
            ORDER BY id ASC
        """).fetchall()
        return [
            {
                "id": r["id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "language": r["language"],
                "assigned_model": r["assigned_model"],
                "effective_model": DEFAULT_MODEL if r["assigned_model"] == "default" else r["assigned_model"],
                "is_admin": bool(r["is_admin"]),
                "created_at": r["created_at"],
                "last_seen": r["last_seen"],
            }
            for r in rows
        ]
    finally:
        conn.close()


def set_user_model(user_id: int, model: str) -> None:
    allowed = {"default", "gemini-3.5-live-translate-preview", "gemini-2.5-flash-native-audio-latest", "openai-realtime"}
    if model not in allowed:
        raise ValueError(f"Invalid model. Must be one of {allowed}")
    conn = get_connection()
    try:
        with conn:
            conn.execute("UPDATE users SET assigned_model = ? WHERE id = ?", (model, user_id))
    finally:
        conn.close()


def set_user_password(user_id: int, new_password: str) -> None:
    if len(new_password) < 6:
        raise ValueError("Password must be at least 6 characters")
    pwd_hash, salt = hash_password(new_password)
    conn = get_connection()
    try:
        with conn:
            conn.execute("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?", (pwd_hash, salt, user_id))
    finally:
        conn.close()


def delete_user(user_id: int) -> None:
    conn = get_connection()
    try:
        with conn:
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    finally:
        conn.close()


def save_message(
    from_user_id: int,
    to_user_id: int,
    original_text: str,
    translated_text: str,
    from_lang: str,
    to_lang: str,
) -> dict[str, Any]:
    conn = get_connection()
    try:
        now = int(time.time())
        with conn:
            cursor = conn.execute(
                """
                INSERT INTO messages (from_user_id, to_user_id, original_text, translated_text, from_lang, to_lang, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (from_user_id, to_user_id, original_text, translated_text, from_lang, to_lang, now),
            )
            msg_id = cursor.lastrowid
        return {
            "id": msg_id,
            "from_user_id": from_user_id,
            "to_user_id": to_user_id,
            "original_text": original_text,
            "translated_text": translated_text,
            "from_lang": from_lang,
            "to_lang": to_lang,
            "created_at": now,
        }
    finally:
        conn.close()


def list_conversation_messages(user_id1: int, user_id2: int, limit: int = 60) -> list[dict[str, Any]]:
    conn = get_connection()
    try:
        rows = conn.execute(
            """
            SELECT id, from_user_id, to_user_id, original_text, translated_text, from_lang, to_lang, created_at
            FROM messages
            WHERE (from_user_id = ? AND to_user_id = ?)
               OR (from_user_id = ? AND to_user_id = ?)
            ORDER BY created_at ASC, id ASC
            LIMIT ?
            """,
            (user_id1, user_id2, user_id2, user_id1, limit),
        ).fetchall()
        return [
            {
                "id": r["id"],
                "from_user_id": r["from_user_id"],
                "to_user_id": r["to_user_id"],
                "original_text": r["original_text"],
                "translated_text": r["translated_text"],
                "from_lang": r["from_lang"],
                "to_lang": r["to_lang"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        conn.close()


init_db()
