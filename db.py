import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

DB_PATH = Path(os.getenv("DATABASE_PATH", Path(__file__).resolve().parent / "calltranslate.db"))
DEFAULT_MODEL = "gemini-3.5-live-translate-preview"
AVAILABLE_MODELS = [
    {"id": "default", "name": "Default (Gemini 3.5 Live)"},
    {"id": "gemini-3.5-live-translate-preview", "name": "Gemini 3.5 Live"},
    {"id": "gemini-2.5-flash-native-audio-latest", "name": "Gemini 2.5 Flash"},
    {"id": "openai-realtime", "name": "OpenAI Realtime"},
]


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
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
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            """)

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


def remove_contact(user_id: int, contact_username: str) -> None:
    conn = get_connection()
    try:
        contact_row = conn.execute("SELECT id FROM users WHERE username = ?", (contact_username.strip().lower(),)).fetchone()
        if not contact_row:
            return
        with conn:
            conn.execute("DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?", (user_id, contact_row["id"]))
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


init_db()
