# JobAgent backend

The hosted service behind the JobAgent desktop app. The local engine and the application agent run on
the student's machine. They call Claude through the Claude Code CLI and the Anthropic SDK, and this
backend gives them three things:

- **Accounts.** Email and password signup and login. Each login issues a device token, and one account can have several devices.
- **Billing.** A Stripe subscription (Checkout, Customer Portal, webhooks). Users without a subscription get a one-time free trial allowance.
- **An AI gateway.** It speaks the Anthropic Messages API, so the desktop app never needs the user's own AI key. The gateway authenticates the device token, enforces the plan, budget and rate limit, then forwards the request to `api.anthropic.com` with the server's key, and records token usage.

Stack: Python 3.12, FastAPI, SQLAlchemy 2 (SQLite by default, Postgres-ready), httpx. Stripe is called
over its REST API directly; there is no Stripe SDK.

## API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | – | Liveness check |
| `POST /auth/signup` `{email, password, device_name?}` | – | Creates an account and returns `{token, email}` (201) |
| `POST /auth/login` `{email, password, device_name?}` | – | Returns a new device token `{token, email}` |
| `POST /auth/logout` | token | Revokes the token used for this request |
| `GET /me` | token | Email, plan status, and current-period usage and limit |
| `POST /billing/checkout` | token | Creates a subscription Checkout Session and returns `{url, id}` |
| `POST /billing/portal` | token | Creates a Customer Portal session and returns `{url}` |
| `POST /billing/webhook` | Stripe signature | Stripe events |
| `POST /llm/v1/messages` | token | Messages API proxy (streaming and non-streaming) |
| `POST /llm/v1/messages/count_tokens` | token | Passthrough (no budget charge) |
| `GET /llm/v1/models` | token | Allowlisted models, used when Claude Code model discovery is on |
| `HEAD /llm/api/hello` | – | Claude Code startup probe; always returns 200 |

**Authentication.** Send `Authorization: Bearer <token>`. `x-api-key: <token>` is also accepted. Tokens
are 43+ random characters with a `ja_` prefix. The server stores only their SHA-256. Passwords are
hashed with `hashlib.scrypt` (N=2^14, r=8, p=1) using a per-user random salt.

**Errors** use the Anthropic shape `{"type":"error","error":{"type":...,"message":...}}`:

| Status | Error type | When |
|---|---|---|
| 401 | `authentication_error` | Missing, invalid or revoked token |
| 402 | `billing_error` | No active subscription and the trial is used up, or the monthly budget is used up |
| 429 | `rate_limit_error` | Per-user rate limit (comes with `retry-after`) |
| 400 | `invalid_request_error` | The request is malformed |
| 502 / 503 | `api_error` | The upstream service is unreachable, or the server is not configured |

## Gateway behaviour

The gateway follows the Claude Code LLM gateway docs
([connect](https://code.claude.com/docs/en/llm-gateway-connect.md),
[protocol](https://code.claude.com/docs/en/llm-gateway-protocol.md)).

**Request**
- Routing matches on path only, so `?beta=true` is ignored.
- `anthropic-version` and `anthropic-beta` are forwarded verbatim, and so are any other `anthropic-*` headers. Beta values are not allowlisted.
- The user's token is never sent upstream. The server's `ANTHROPIC_API_KEY` goes upstream as `x-api-key`.
- The request body is forwarded byte-for-byte, and the `system` array is untouched. The one exception is a model id that is not on the allowlist. Then only the `model` field is rewritten: to the allowlisted model of the same family (for example an older `claude-haiku-*` becomes `claude-haiku-5-5`), or to `DEFAULT_MODEL` if no family matches.

**Response**
- Upstream status and body are relayed unmodified, including 400 bodies. Claude Code's retry logic matches on their wording.
- These response headers are forwarded: `retry-after`, `x-should-retry`, `request-id` and `anthropic-ratelimit-unified-*`.
- A streaming response is returned as `Content-Type: text/event-stream`. Each chunk is relayed as soon as it arrives, with no buffering. Ping events pass through, and the stream runs through `message_delta` and `message_stop`.

**Usage and limits**
- Usage is recorded in the `usage` table for every `/v1/messages` call: input, output, cache-creation and cache-read tokens. For streaming calls it is parsed from `message_start` and `message_delta` while the bytes are relayed; for non-streaming calls it comes from the JSON body.
- **Budget accounting.** Billable tokens = input + output + cache creation + cache reads ÷ 10. Cache reads cost about 10% of normal input upstream.
- Subscribers (Stripe status `active` or `trialing`) get `MONTHLY_TOKEN_BUDGET` per calendar month (UTC).
- Everyone else gets a lifetime `TRIAL_TOKEN_BUDGET`. That includes `past_due`, `canceled` and never-subscribed users.
- The check runs before each request. A request that starts under budget is allowed to finish, so usage can overshoot the budget by at most one response.
- The rate limit is `RATE_LIMIT_PER_MINUTE` requests per user in a sliding 60-second window. It is held in process memory, so each instance counts separately.

## Stripe

**Checkout.** `POST /billing/checkout` creates a `mode=subscription` Checkout Session for
`STRIPE_PRICE_ID`. It sets `client_reference_id`, plus `metadata.user_id` on both the session and the
subscription, to the user id. The desktop app opens the returned URL.

**Webhook.** Point a Stripe webhook endpoint at `https://<host>/billing/webhook` and subscribe it to these events:
- `checkout.session.completed`: stores the customer and subscription ids and sets the status to `active`
- `customer.subscription.updated`: status is set from `subscription.status`, and the current period end is stored
- `customer.subscription.deleted`: status becomes `canceled`
- `invoice.payment_failed`: status becomes `past_due`

Signatures are checked with Stripe's documented scheme: HMAC-SHA256 over `"{t}.{raw body}"` with
`STRIPE_WEBHOOK_SECRET`. Any `v1` signature in the header may match, and the timestamp must be within
`STRIPE_WEBHOOK_TOLERANCE_SECONDS`. Event ids are stored, so retried deliveries apply once. Events
older than the last one applied to a user are ignored, which handles out-of-order delivery.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./jobagent.db` | SQLAlchemy URL. `postgres://` and `postgresql://` URLs are rewritten to the psycopg 3 driver (install the `postgres` extra) |
| `ANTHROPIC_API_KEY` | – (required for the gateway) | Server key used upstream. The gateway returns 503 without it |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Upstream base URL |
| `ALLOWED_MODELS` | `claude-fable-5-2,claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5` | Comma-separated allowlist |
| `DEFAULT_MODEL` | `claude-opus-5-5` | Target for unknown model ids. Must be in the allowlist, otherwise the first allowlisted model is used |
| `MONTHLY_TOKEN_BUDGET` | `20000000` | Billable tokens per calendar month for subscribers |
| `TRIAL_TOKEN_BUDGET` | `200000` | Lifetime billable tokens for users without an active subscription |
| `RATE_LIMIT_PER_MINUTE` | `60` | Gateway requests per user per minute (0 disables the limit) |
| `UPSTREAM_TIMEOUT_SECONDS` | `600` | Read timeout for upstream calls |
| `STRIPE_SECRET_KEY` | – | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_PRICE_ID` | – | Recurring price for the subscription |
| `STRIPE_WEBHOOK_SECRET` | – | Signing secret of the webhook endpoint (`whsec_…`) |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | `300` | Maximum webhook timestamp age |
| `CHECKOUT_SUCCESS_URL` | `https://jobagent.app/billing/success` | Where Checkout redirects after payment |
| `CHECKOUT_CANCEL_URL` | `https://jobagent.app/billing/cancel` | Where Checkout redirects on cancel |
| `PORTAL_RETURN_URL` | `https://jobagent.app/account` | Customer Portal return URL |

`.env.example` lists them all with placeholders. The app reads the process environment, so export the
variables or use your host's secret store. It does not load `.env` files itself.

## Local run

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
set -a; source .env; set +a          # after copying .env.example to .env
.venv/bin/uvicorn app.main:app --reload --port 8080
.venv/bin/python -m pytest -q        # tests mock Anthropic and Stripe; no keys needed
```

Tables are created on startup (`create_all`). Add Alembic before the first schema change in production.

To test webhooks locally, run `stripe listen --forward-to localhost:8080/billing/webhook` and use the
`whsec_…` it prints.

## How the desktop app uses it

1. **Sign in.** The app calls `POST /auth/signup` or `POST /auth/login` and keeps the returned device token in the OS keychain. `GET /me` drives the plan and usage display. `POST /billing/checkout` and `POST /billing/portal` return URLs that the app opens in the browser.
2. **Claude Code CLI.** The app starts the CLI with:
   ```bash
   ANTHROPIC_BASE_URL=https://<backend-host>/llm
   ANTHROPIC_AUTH_TOKEN=<device token>   # arrives as Authorization: Bearer <token>
   ```
   Claude Code then calls `HEAD /llm/api/hello` at startup and `POST /llm/v1/messages?beta=true` for inference.
3. **Anthropic SDK** (Python engine): `anthropic.Anthropic(base_url="https://<backend-host>/llm", auth_token=<device token>)`, or the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` environment variables. The SDK appends `/v1/messages`.
4. **Errors.** A 402 `billing_error` means the user should subscribe, or that the monthly budget is used up. A 401 means the user has to sign in again.
5. **Logout.** `POST /auth/logout` revokes only that device's token.

## Deploy (Fly.io or Render)

The included `Dockerfile` runs `uvicorn app.main:app` on `$PORT` (default 8080) as a non-root user. It
installs the Postgres driver.

**Fly.io**
```bash
fly launch --no-deploy                 # detects the Dockerfile; internal port 8080
fly postgres create && fly postgres attach <db-app>   # sets DATABASE_URL
fly secrets set ANTHROPIC_API_KEY=... STRIPE_SECRET_KEY=... STRIPE_PRICE_ID=... STRIPE_WEBHOOK_SECRET=...
fly deploy
```
For a SQLite-only trial deploy, mount a volume at `/data` instead (the image defaults
`DATABASE_URL=sqlite:////data/jobagent.db`) and keep a single machine.

**Render.** Create a *Web Service* from the repo with root directory `backend` and the Docker runtime.
Add a Render Postgres instance and set `DATABASE_URL` to its internal URL. Add the secrets above as
environment variables. Render sets `PORT` itself.

**Operational notes**
- Streaming responses can run for minutes. Keep proxy idle timeouts at 10 minutes or more, and do not enable response buffering. The gateway sends `X-Accel-Buffering: no`.
- The rate limiter lives in memory. With several instances, the effective limit is the per-instance limit times the instance count. Move it to Redis or Postgres if that matters.
- CORS is deliberately off. Only native processes call this API.
- Set a spend limit on the Anthropic organization as a backstop to the per-user budgets.
