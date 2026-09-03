// Stand-in for a real integration test suite: writes JUnit XML + a screenshot
// for the one failing test, the same shape any real test runner would produce.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("results/screenshots", { recursive: true });

// A 1x1 PNG, just so the report has a real image to embed.
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
writeFileSync(
  "results/screenshots/login-flow-should-reject-bad-password.png",
  Buffer.from(PIXEL_PNG_BASE64, "base64")
);

const junit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="login" tests="2" failures="1">
    <testcase classname="login" name="should log in with valid credentials" time="0.4"></testcase>
    <testcase classname="login" name="login flow should reject bad password" time="0.2">
      <failure message="expected error banner, got none">AssertionError: expected element .error-banner to be visible
    at loginFlow (login.test.js:42)</failure>
    </testcase>
  </testsuite>
</testsuites>
`;

writeFileSync("results/junit.xml", junit);
console.log("Fixture test run complete: 1 passed, 1 failed.");
