from app.db import DeviceToken, User
from app.security import token_hash

from .conftest import signup


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_signup_stores_scrypt_hash_and_token_hash(client, app):
    token = signup(client, "A@Example.edu", "longpassword")
    db = app.state.sessionmaker()
    user = db.query(User).one()
    assert user.email == "a@example.edu"
    assert user.password_hash != "longpassword" and len(user.password_salt) == 32
    row = db.query(DeviceToken).one()
    assert row.token_hash == token_hash(token) and token not in row.token_hash
    db.close()


def test_signup_validation_and_duplicate(client):
    assert client.post("/auth/signup", json={"email": "bad", "password": "longpassword"}).status_code == 400
    r = client.post("/auth/signup", json={"email": "x@y.com", "password": "short"})
    assert r.status_code == 400 and r.json()["type"] == "error"
    signup(client, "x@y.com", "longpassword")
    r = client.post("/auth/signup", json={"email": "X@y.com", "password": "longpassword"})
    assert r.status_code == 409


def test_login_multiple_devices_and_logout(client):
    signup(client, "s@u.edu", "password123")
    bad = client.post("/auth/login", json={"email": "s@u.edu", "password": "wrong-password"})
    assert bad.status_code == 401 and bad.json()["error"]["type"] == "authentication_error"
    assert client.post("/auth/login", json={"email": "nobody@u.edu", "password": "password123"}).status_code == 401

    t1 = client.post("/auth/login", json={"email": "s@u.edu", "password": "password123"}).json()["token"]
    t2 = client.post("/auth/login", json={"email": "s@u.edu", "password": "password123", "device_name": "laptop"}).json()["token"]
    assert t1 != t2 and len(t1) > 40

    assert client.post("/auth/logout", headers={"Authorization": f"Bearer {t1}"}).json() == {"ok": True}
    assert client.get("/me", headers={"Authorization": f"Bearer {t1}"}).status_code == 401
    # The other device keeps working.
    assert client.get("/me", headers={"Authorization": f"Bearer {t2}"}).status_code == 200


def test_token_auth_bearer_and_x_api_key(client, token):
    assert client.get("/me").status_code == 401
    assert client.get("/me", headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert client.get("/me", headers={"x-api-key": token}).status_code == 200
    body = r.json()
    assert body["email"] == "student@example.edu"
    assert body["plan"]["status"] == "none" and body["plan"]["subscribed"] is False
    assert body["usage"] == {"kind": "trial", "period_start": None, "period_end": None,
                             "used_tokens": 0, "limit_tokens": 100, "remaining_tokens": 100}
