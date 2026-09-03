# kestrel

*(working name — placeholder until this has a real one)*

A generic CI test runner: point it at an APK and raw Appium test files (or
any other integration test suite), and it runs them, collects the JUnit
results and screenshots, and produces a report — pass/fail counts,
per-failure descriptions, embedded screenshots — as a build artifact your CI
can publish. Optionally also publishes each run to a small hosted dashboard
(session history across every project that uses it) — see "Dashboard" below.

It runs on **your own CI infrastructure** — GitHub Actions today, since
that's what the first real use case (below) targets, but nothing here is
GitHub-specific except the optional `$GITHUB_STEP_SUMMARY` write.

## Where this came from

Distilled from a proposal for replacing per-device cloud testing
(Sauce Labs/BrowserStack) with Appium running against a hardware-accelerated
Android emulator directly in GitHub Actions. That proposal was scoped to one
company's existing `appium-python-test` repo, which already self-manages its
own Appium server via a `conftest.py`/`AppiumService` fixture — the proposal
only changed *where* that suite ran (emulator vs. cloud), not how it worked.

This package generalizes past that: the goal is for a **new** repo to need
nothing but raw test files and an APK — no `conftest.py`, no
`AppiumService` setup of its own — because kestrel owns that harness.
Existing suites that already have their own Appium setup aren't forced to
give it up; see "Bring your own AppiumService" below.

## Two platforms

### `platform: "integration"`

The simple path: kestrel runs `testCommand` as a shell command and parses
whatever JUnit XML it produces. No APK, no Appium, no injected fixtures —
the suite is fully self-contained (works for any language/framework that can
write JUnit XML: pytest, jest, go test, etc).

### `platform: "appium"`

Kestrel owns the harness so the test repo doesn't have to:

1. Installs the APK: `adb install -r <apk>`.
2. Starts a local Appium server (or reuses one already listening on the
   configured port), polling `/status` until it's ready.
3. Runs `testCommand` with env vars set (`KESTREL_APPIUM_SERVER_URL`,
   `KESTREL_APK_PATH`, `KESTREL_PLATFORM_NAME`, `KESTREL_DEVICE_NAME`,
   `KESTREL_AUTOMATION_NAME`, `KESTREL_SCREENSHOTS_DIR`) and `PYTHONPATH`
   pointed at `python-harness/`, so `-p kestrel_appium_plugin` (see your
   `testCommand`) makes a `driver` fixture available to raw test files —
   already connected to the right server and app, no setup required.
   That plugin also auto-captures a screenshot on test failure, named after
   the test's own pytest node id, so kestrel's report can match failures to
   screenshots exactly instead of guessing by filename.
4. Tears the server down afterward (only if kestrel started it).

See `examples/appium-ci/` — `kestrel.config.json`, a sample GitHub Actions
workflow, and `tests/test_login.py`, a raw test file with no setup of its
own, to see the whole shape.

### Bring your own AppiumService

If a suite already has its own `AppiumService` — custom plugins,
`--relaxed-security` flags, per-`pytest-xdist`-worker ports, whatever a real
suite tends to accumulate — set `"appium": { "apk": "...", "ownServer": false }`.
Kestrel then just installs the APK and runs `testCommand` as-is: no server,
no injected plugin, no env vars. The suite manages Appium exactly as it did
before adopting kestrel; kestrel's only job is the APK install and the
report at the end.

## How results become a report

1. Scans `resultsDir` for `*.xml` JUnit reports and parses them.
2. Scans `screenshotsDir` (if set) and attaches screenshots to failing
   tests. For `platform: "appium"` with kestrel's own server, this is exact
   (see above). Otherwise it's a best-effort filename match — see
   "Screenshot matching" below.
3. Writes `reportDir/index.html` (self-contained, screenshots embedded as
   base64 — safe to upload as a single CI artifact), `reportDir/summary.md`,
   and `reportDir/summary.json`.
4. If running under GitHub Actions (`$GITHUB_STEP_SUMMARY` is set), appends
   the markdown summary there too, so failures are visible on the run page
   without opening the artifact.
5. Exits non-zero if any test failed or errored, so the CI job fails
   correctly.

## Screenshot matching (non-Appium-owned paths)

Outside of kestrel's own Appium harness, there's no universal convention for
"which screenshot belongs to which test failure." The fallback heuristic:
normalize both the test name and each screenshot filename (lowercase, strip
non-alphanumerics) and match on substring containment. Name screenshots
after their test and it'll match reliably.

## Dashboard

Live at **[deuque.github.io/kestrel](https://deuque.github.io/kestrel/)** —
a static site (no build step, no server) on this repo's `gh-pages` branch.
Session list on the left; click one to see its failures and screenshots.

To publish a run there, add to `kestrel.config.json`:

```json
"dashboard": {
  "repo": "Deuque/kestrel",
  "project": "your-project-name"
}
```

and set `KESTREL_DASHBOARD_TOKEN` (a GitHub token with push access to that
repo) in the environment kestrel runs in — in CI, a repo secret. Without the
token set, kestrel logs a warning and skips publishing; it never fails the
actual test run over a missing/broken dashboard push. Each run lands as
`runs/<id>.json` (screenshots embedded as base64, same as the HTML report)
plus an updated `runs/index.json` manifest, committed and pushed straight to
`gh-pages` — no server, no database.

## Try it (generic path, no Android/Appium needed)

```
npm install
cd examples/generic-fixture
node ../../node_modules/.bin/tsx ../../src/cli.ts run --config kestrel.config.json
open report/index.html
```

This runs a fixture "suite" (`run-tests.mjs`) that fakes one passing and one
failing test and writes real JUnit XML + a screenshot, so you can see the
whole pipeline — parse, match, render — without a device.

## Try it (Appium/Android path)

See `examples/appium-ci/`. Point `appium.apk` at your built APK, write raw
test files under `tests/` using the `driver` fixture (see
`tests/test_login.py`), and run:

```
pip install -r python-harness/requirements.txt
npx tsx src/cli.ts run --config examples/appium-ci/kestrel.config.json
```

against a real device/emulator reachable via `adb`.

## Status

This is a shell, not a finished tool:

- No packaged CLI binary yet — invoke via `tsx src/cli.ts run`.
- Only JUnit XML is supported as the results format.
- The Appium server lifecycle (start, poll `/status`, stop) is verified for
  real; the `driver` fixture + screenshot-on-failure plugin is written but
  not yet run against a real device/APK — that's the next step, against the
  klasha app.
- The dashboard is minimal by design — a session list and a detail view,
  no filtering/search/trends yet. Verified end-to-end (published a real run,
  confirmed it rendered) against the live site before this was written.
