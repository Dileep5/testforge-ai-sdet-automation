# Playwright runner. The version must match @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY tsconfig.json playwright.config.ts playwright.triage.config.ts ./
COPY framework framework
COPY tests tests
COPY ai/triage-corpus ai/triage-corpus
COPY apps/api/openapi.json apps/api/openapi-accepted-breaking-changes.json apps/api/
COPY apps/web apps/web
# The security suite checks the production bundle for credentials, so it needs a build to read.
RUN npm run build --workspace apps/web
RUN mkdir -p reports && chown -R pwuser:pwuser /app/reports
# pwuser is defined by the base image, which does not document a fixed numeric id.
# hadolint ignore=DL3066
USER pwuser
ENV E2E_EXTERNAL_SERVERS=1 E2E_SKIP_SEED=1 E2E_RETRIES=0 CI=1
CMD ["npx", "playwright", "test", "--project=framework", "--project=chromium", "--project=firefox", "--project=webkit", "--project=accessibility", "--project=keyboard-webkit", "--project=keyboard-firefox", "--project=api", "--project=database", "--project=security", "--project=reliability"]
