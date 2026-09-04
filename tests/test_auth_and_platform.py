import os
import pytest
from fastapi.testclient import TestClient
import app
import db

ORIGIN = "http://testserver"


@pytest.fixture(autouse=True)
def clean_db(tmp_path):
    test_db = str(tmp_path / "test_isolated.db")
    os.environ["CALLTRANSLATE_DB_PATH"] = test_db
    db.init_db()
    yield
    try:
        if os.path.exists(test_db):
            os.remove(test_db)
    except OSError:
        pass


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


def test_contacts_and_friend_requests():
    with TestClient(app.app, base_url=ORIGIN) as client:
        # Register two users
        u1 = client.post("/api/auth/register", json={"username": "user1", "password": "password123", "display_name": "User One"}).json()
        u2 = client.post("/api/auth/register", json={"username": "user2", "password": "password123", "display_name": "User Two"}).json()

        t1 = u1["token"]
        t2 = u2["token"]

        # user1 sends friend request to user2
        req_res = client.post("/api/friend-requests", headers={"Authorization": f"Bearer {t1}"}, json={"username": "user2"})
        assert req_res.status_code == 200
        assert req_res.json()["status"] == "pending"

        # user2 checks incoming requests
        inc_res = client.get("/api/friend-requests", headers={"Authorization": f"Bearer {t2}"})
        assert inc_res.status_code == 200
        requests = inc_res.json()["requests"]
        assert len(requests) == 1
        assert requests[0]["username"] == "user1"
        req_id = requests[0]["request_id"]

        # user2 accepts request
        acc_res = client.post(f"/api/friend-requests/{req_id}/accept", headers={"Authorization": f"Bearer {t2}"})
        assert acc_res.status_code == 200
        assert acc_res.json()["status"] == "accepted"

        # Both user1 and user2 should now have each other in contacts
        c1 = client.get("/api/contacts", headers={"Authorization": f"Bearer {t1}"}).json()["contacts"]
        c2 = client.get("/api/contacts", headers={"Authorization": f"Bearer {t2}"}).json()["contacts"]
        assert any(c["username"] == "user2" for c in c1)
        assert any(c["username"] == "user1" for c in c2)

        # user1 deletes user2 from contacts
        del_res = client.delete("/api/contacts/user2", headers={"Authorization": f"Bearer {t1}"})
        assert del_res.status_code == 200

        # Verify removed for user1
        c1_after = client.get("/api/contacts", headers={"Authorization": f"Bearer {t1}"}).json()["contacts"]
        assert not any(c["username"] == "user2" for c in c1_after)


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
        u1 = client.post("/api/auth/register", json={"username": "wsuser1", "password": "password123", "language": "ar"}).json()
        u2 = client.post("/api/auth/register", json={"username": "wsuser2", "password": "password123", "language": "en"}).json()
        token1 = u1["token"]
        token2 = u2["token"]

        with client.websocket_connect(f"/ws/user-hub?token={token1}") as ws1:
            msg1 = ws1.receive_json()
            assert msg1["type"] == "connected"

            with client.websocket_connect(f"/ws/user-hub?token={token2}") as ws2:
                msg2 = ws2.receive_json()
                assert msg2["type"] == "connected"

                # wsuser1 calls wsuser2
                ws1.send_json({"type": "call_user", "target": "wsuser2"})

                init_msg = ws1.receive_json()
                assert init_msg["type"] == "call_initiating"
                assert "access_token" in init_msg
                assert init_msg["access_token"].startswith("ct_")

                inc_msg = ws2.receive_json()
                assert inc_msg["type"] == "incoming_call"
                assert inc_msg["caller"] == "wsuser1"
                assert "access_token" in inc_msg
                assert inc_msg["access_token"].startswith("ct_")


def test_chat_messaging_and_outgoing_friend_requests():
    with TestClient(app.app, base_url=ORIGIN) as client:
        u1 = client.post("/api/auth/register", json={"username": "chat1", "password": "password123", "language": "ar"}).json()
        u2 = client.post("/api/auth/register", json={"username": "chat2", "password": "password123", "language": "en"}).json()
        h1 = {"Authorization": f"Bearer {u1['token']}"}
        h2 = {"Authorization": f"Bearer {u2['token']}"}

        # chat1 sends friend request to chat2
        req_res = client.post("/api/friend-requests", headers=h1, json={"username": "chat2"})
        assert req_res.status_code == 200

        # chat1 checks outgoing requests
        fr1 = client.get("/api/friend-requests", headers=h1).json()
        assert len(fr1["outgoing"]) == 1
        assert fr1["outgoing"][0]["username"] == "chat2"
        req_id = fr1["outgoing"][0]["request_id"]

        # chat2 checks incoming requests
        fr2 = client.get("/api/friend-requests", headers=h2).json()
        assert len(fr2["incoming"]) == 1
        assert fr2["incoming"][0]["username"] == "chat1"

        # chat2 accepts
        acc_res = client.post(f"/api/friend-requests/{req_id}/accept", headers=h2)
        assert acc_res.status_code == 200

        # chat1 sends chat message to chat2
        msg_res = client.post("/api/messages/chat2", headers=h1, json={"text": "مرحبا بك"})
        assert msg_res.status_code == 200
        saved = msg_res.json()["message"]
        assert saved["original_text"] == "مرحبا بك"
        assert saved["from_lang"] == "ar"

        # chat1 sends a second message to chat2
        client.post("/api/messages/chat2", headers=h1, json={"text": "الرسالة الثانية"})

        # chat2 checks contacts: should see unread_count == 2
        c_res = client.get("/api/contacts", headers=h2)
        assert c_res.status_code == 200
        contacts = c_res.json()["contacts"]
        assert len(contacts) == 1
        assert contacts[0]["username"] == "chat1"
        assert contacts[0]["unread_count"] == 2
        assert contacts[0]["last_message"] == "الرسالة الثانية"

        # chat2 retrieves conversation (which marks messages as read)
        hist_res = client.get("/api/messages/chat1", headers=h2)
        assert hist_res.status_code == 200
        msgs = hist_res.json()["messages"]
        assert len(msgs) == 2
        assert msgs[0]["original_text"] == "مرحبا بك"
        assert msgs[1]["original_text"] == "الرسالة الثانية"

        # chat2 checks contacts again: unread_count should now be 0
        c_res2 = client.get("/api/contacts", headers=h2)
        contacts2 = c_res2.json()["contacts"]
        assert contacts2[0]["unread_count"] == 0
