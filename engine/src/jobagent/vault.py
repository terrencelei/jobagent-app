"""Secrets the app keeps for the student, in the operating system's own credential store.

`keyring` uses the macOS Keychain, the Windows Credential Manager or the Linux Secret Service, so the same
code works on every platform the desktop app ships to. If no store is available (a headless Linux box),
secrets fall back to a file in the data directory readable only by the user.

Kept here: the JobAgent account token (for the AI gateway), the password the application agent uses when an
employer site needs an account, and the Gmail refresh token for reading verification codes.
"""
import json
import os
from pathlib import Path
from typing import Optional

SERVICE = 'JobAgent'
ACCOUNT_TOKEN = 'account-token'
ACCOUNT_EMAIL = 'account-email'
SITE_PASSWORD = 'site-password'
GMAIL_REFRESH = 'gmail-refresh-token'

DEFAULT_BACKEND = 'https://api.jobagent.app'


def _fallback_path() -> Path:
    from .config import get_settings
    return get_settings().data_dir / 'secrets.json'


def _keyring():
    # JOBAGENT_VAULT=file keeps secrets in the data folder (demos, tests, machines without a credential store).
    if os.environ.get('JOBAGENT_VAULT') == 'file':
        return None
    try:
        import keyring
        from keyring.errors import NoKeyringError  # noqa: F401
        backend = keyring.get_keyring()
        # The "fail" backend means there is no usable store on this machine.
        if 'fail' in type(backend).__module__:
            return None
        return keyring
    except Exception:
        return None


def _read_fallback() -> dict:
    try:
        return json.loads(_fallback_path().read_text())
    except (OSError, ValueError):
        return {}


def _write_fallback(data: dict):
    path = _fallback_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def get(name: str) -> Optional[str]:
    kr = _keyring()
    if kr:
        try:
            value = kr.get_password(SERVICE, name)
            if value is not None:
                return value
        except Exception:
            pass
    return _read_fallback().get(name)


def put(name: str, value: str):
    kr = _keyring()
    if kr:
        try:
            kr.set_password(SERVICE, name, value)
            return
        except Exception:
            pass
    data = _read_fallback()
    data[name] = value
    _write_fallback(data)


def delete(name: str):
    kr = _keyring()
    if kr:
        try:
            kr.delete_password(SERVICE, name)
        except Exception:
            pass
    data = _read_fallback()
    if data.pop(name, None) is not None:
        _write_fallback(data)


def backend_url() -> str:
    return (os.environ.get('JOBAGENT_BACKEND_URL') or DEFAULT_BACKEND).rstrip('/')


# Variables that would point the model CLIs somewhere other than the student's JobAgent account.
BLOCKED = {'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
           'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'}


def model_env(base: Optional[dict] = None) -> dict:
    """Environment for a model CLI (claude) or the application agent.

    With a JobAgent account connected, the Claude Code CLI talks to the JobAgent AI gateway with the account
    token (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, sent as a Bearer token), so the student needs no AI key
    of their own. Without one, the CLI uses whatever login it already has (developer installs)."""
    env = {k: v for k, v in (base if base is not None else os.environ).items() if k not in BLOCKED}
    password = get(SITE_PASSWORD)
    if password:
        # The application agent signs in to employer sites with this (it reads WORKDAY_PASSWORD first).
        env['WORKDAY_PASSWORD'] = password
    token = get(ACCOUNT_TOKEN)
    if token:
        env['ANTHROPIC_BASE_URL'] = f'{backend_url()}/llm'
        env['ANTHROPIC_AUTH_TOKEN'] = token
    return env
