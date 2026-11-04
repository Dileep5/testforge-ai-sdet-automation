# FastAPI backend. The same image runs the API and the one-shot migrate and seed step.
FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# The lock file is used as constraints, so versions are pinned and test tools stay out of the image.
COPY apps/api/requirements.txt apps/api/requirements.lock apps/api/
COPY ai/requirements.lock ai/pyproject.toml ai/
RUN pip install -r apps/api/requirements.txt -r ai/requirements.lock -c apps/api/requirements.lock

COPY ai/testforge_ai ai/testforge_ai
RUN pip install --no-deps ./ai

COPY apps/api/alembic apps/api/alembic
COPY apps/api/alembic.ini apps/api/alembic.ini
COPY apps/api/app apps/api/app
COPY docker/migrate.sh /usr/local/bin/testforge-migrate
RUN chmod 0555 /usr/local/bin/testforge-migrate \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
USER 10001

WORKDIR /app/apps/api
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/ready', timeout=2)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--timeout-keep-alive", "75"]
