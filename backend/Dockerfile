FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY pyproject.toml ./
COPY app ./app
RUN pip install ".[postgres]" && useradd --create-home jobagent && mkdir -p /data && chown jobagent /data

USER jobagent
# SQLite fallback lives on a volume at /data; set DATABASE_URL to Postgres in production.
ENV DATABASE_URL=sqlite:////data/jobagent.db PORT=8080
EXPOSE 8080

# --proxy-headers so client IPs and https scheme are correct behind Fly/Render proxies.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
