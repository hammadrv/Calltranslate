import pytest
from fastapi.testclient import TestClient
import app
import db

ORIGIN = "http://testserver"


@pytest.fixture(autouse=True)
def clean_db():
    db.init_db()


def test_user_registration_and_login():
    with TestClient(app.app, base_url=ORIGIN) as client:
        # Register user
        reg_res = client.post("/api/auth/register", json={
            "username": "alice",
            "password": "password123",
            "display_name": "Alice Wonderland",
            "language": "ar",
        })
        assert reg_res.status_code == 200
        data = reg_res.json()
        assert "token" in data
        assert data["user"]["username"] == "alice"
        assert data["user"]["language"] == "ar"

        token = data["token"]

        # Duplicate registration should fail
        dup_res = client.post("/api/auth/register", json={
            "username": "alice",
            "password": "password123",
        })
        assert dup_res.status_code == 400

        # Login with wrong password
        wrong_res = client.post("/api/auth/login", json={
            "username": "alice",
            "password": "wrongpassword",
        })
        assert wrong_res.status_code == 401

        # Login with correct password
        login_res = client.post("/api/auth/login", json={
            "username": "alice",
            "password": "password123",
        })
        assert login_res.status_code == 200
        assert "token" in login_res.json()

        # Auth me
        me_res = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert me_res.status_code == 200
        assert me_res.json()["user"]["username"] == "alice"

        # Update language
        lang_res = client.put(
            "/api/user/language",
            headers={"Authorization": f"Bearer {token}"},
            json={"language": "en"},
        )
        assert lang_res.status_code == 200
        assert lang_res.json()["language"] == "en"


def test_contacts_management():
    with TestClient(app.app, base_url=ORIGIN) as client:
        # Register two users
        u1 = client.post("/api/auth/register", json={"username": "user1", "password": "password123", "display_name": "User One"}).json()
        u2 = client.post("/api/auth/register", json={"username": "user2", "password": "password123", "display_name": "User Two"}).json()

        t1 = u1["token"]

        # Add user2 to user1's contacts
        add_res = client.post("/api/contacts", headers={"Authorization": f"Bearer {t1}"}, json={"username": "user2"})
        assert add_res.status_code == 200
        assert add_res.json()["contact"]["username"] == "user2"

        # List contacts
        list_res = client.get("/api/contacts", headers={"Authorization": f"Bearer {t1}"})
        assert list_res.status_code == 200
        contacts = list_res.json()["contacts"]
        assert any(c["username"] == "user2" for c in contacts)

        # Delete contact
        del_res = client.delete("/api/contacts/user2", headers={"Authorization": f"Bearer {t1}"})
        assert del_res.status_code == 200

        # Verify removed
        list_res2 = client.get("/api/contacts", headers={"Authorization": f"Bearer {t1}"})
        assert not any(c["username"] == "user2" for c in list_res2.json()["contacts"])


def test_admin_dashboard_and_model_override():
    with TestClient(app.app, base_url=ORIGIN) as client:
        # Admin login
        admin_login = client.post("/api/auth/login", json={"username": "admin", "password": "AdminPassword123!"})
        assert admin_login.status_code == 200
        admin_token = admin_login.json()["token"]

        # Create normal user
        norm_user = client.post("/api/auth/register", json={"username": "charlie", "password": "password123"}).json()
        charlie_id = norm_user["user"]["id"]
        charlie_token = norm_user["token"]

        # Non-admin trying to access admin endpoint should get 403
        forbidden = client.get("/api/admin/users", headers={"Authorization": f"Bearer {charlie_token}"})
        assert forbidden.status_code == 403

        # Admin access
        users_res = client.get("/api/admin/users", headers={"Authorization": f"Bearer {admin_token}"})
        assert users_res.status_code == 200
        users_data = users_res.json()
        assert users_data["default_model"] == "gemini-3.5-live-translate-preview"
        assert any(u["username"] == "charlie" for u in users_data["users"])

        # Admin set model for Charlie
        set_model_res = client.put(
            f"/api/admin/users/{charlie_id}/model",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"model": "gemini-2.5-flash-native-audio-latest"},
        )
        assert set_model_res.status_code == 200
        assert set_model_res.json()["model"] == "gemini-2.5-flash-native-audio-latest"

        # Verify Charlie's effective model
        charlie_me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {charlie_token}"}).json()
        assert charlie_me["user"]["effective_model"] == "gemini-2.5-flash-native-audio-latest"

        # Admin reset Charlie's password
        reset_res = client.put(
            f"/api/admin/users/{charlie_id}/password",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"password": "newpassword456"},
        )
        assert reset_res.status_code == 200

        # Verify Charlie can login with new password
        login_new = client.post("/api/auth/login", json={"username": "charlie", "password": "newpassword456"})
        assert login_new.status_code == 200


def test_user_hub_websocket():
    with TestClient(app.app, base_url=ORIGIN) as client:
        u = client.post("/api/auth/register", json={"username": "wsuser", "password": "password123"}).json()
        token = u["token"]

        with client.websocket_connect(f"/ws/user-hub?token={token}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "connected"
            assert msg["username"] == "wsuser"
            assert msg["model"] == "gemini-3.5-live-translate-preview"
