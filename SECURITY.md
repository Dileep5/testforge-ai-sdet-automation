# Security policy

TestForge AI is a test automation portfolio project. **The application is not production software, and should not be deployed or trusted with real data.**

## Supported versions

Only the latest commit on `main` is maintained. There are no releases or backported fixes.

## Reporting a vulnerability

**Please do not put vulnerability details in a public issue.**

Report it privately through this repository's **Security** tab, using **Report a vulnerability**. If that option is not available, open an issue asking for a private way to send details, and leave the details out.

There is no dedicated security email address. This is a personal project, so responses are on a best-effort basis, and no response time is promised.

### What is useful to report

- A real credential, or personal data, in the repository, its history or a CI artifact
- A way for a pull request or workflow to gain access it should not have
- A way past the artifact sanitizer, which removes credentials from published test evidence
- A flaw in the test tooling that could harm someone running it

Issues in the demonstration app are welcome too, though some gaps are deliberate. See below.

### Testing rules

Please test only a copy running on your own machine. Do not run scans or attacks against anyone else's deployment or GitHub's infrastructure.

## Synthetic test credentials

The repository publishes credentials on purpose, and **they are not secrets**:

- Seed accounts such as `admin@testforge.example`, listed in the [README](README.md#running-it)
- The local database password `testforge_local`, and the test role's `testforge_e2e_reader_local`
- Passwords in tests and performance scripts, and dummy values used to test the sanitizer

They are fictional, and only work against a throwaway local database. Seeding is refused when `APP_ENV=production`. **Do not reuse them anywhere.** All customers, products and orders are fictional, and payments are simulated.

## Known gaps in the application

These are documented limitations, and are not hidden vulnerabilities:

- No TLS, and no login rate limiting or lockout
- No per-client rate limiting, including on the chat endpoint
- Public API documentation, and no `Cache-Control: no-store` on authenticated responses
- Cookies are not marked `Secure` unless `COOKIE_SECURE` is set

The full list is in [TEST_RESULTS.md](TEST_RESULTS.md#known-limitations).

The security tests are regression checks against the local app, and **no penetration test has been done**. See [TEST_STRATEGY.md](TEST_STRATEGY.md#security-regression). Scanners only recognise known patterns, so a clean scan does not prove that nothing was missed.

## Handling of test evidence

Raw Playwright traces contain session cookies and passwords for the synthetic accounts. They are ignored by git, and CI uploads only sanitized copies. Screenshots and video cannot be text-scanned. See [CI_CD.md](CI_CD.md#artifact-retention).

Live LLM calls are off by default, need an explicit opt-in, and are blocked in CI. API keys are read only on the server side, and are never committed.
