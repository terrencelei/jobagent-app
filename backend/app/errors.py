"""Anthropic-style error responses: {"type":"error","error":{"type":...,"message":...}}."""

from __future__ import annotations

from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, type_: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.type = type_
        self.message = message
        self.headers = headers or {}


def error_response(status: int, type_: str, message: str, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(
        {"type": "error", "error": {"type": type_, "message": message}},
        status_code=status,
        headers=headers,
    )


def unauthorized(message: str = "Invalid or missing JobAgent token. Sign in again in the JobAgent app.") -> ApiError:
    return ApiError(401, "authentication_error", message)


def bad_request(message: str) -> ApiError:
    return ApiError(400, "invalid_request_error", message)
