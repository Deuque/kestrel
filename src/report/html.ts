import { toDataUri } from "../dataUri.js";
import type { RunSummary, TestCase } from "../types.js";

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!);
}

function renderTestCase(test: TestCase): string {
  const screenshot = test.screenshotPath ? toDataUri(test.screenshotPath) : null;
  return `
    <li class="test ${test.status}">
      <div class="test-head">
        <span class="test-name">${escapeHtml(test.name)}</span>
        <span class="test-status">${test.status}</span>
      </div>
      ${test.message ? `<pre class="test-message">${escapeHtml(test.message)}</pre>` : ""}
      ${screenshot ? `<img class="screenshot" src="${screenshot}" alt="${escapeHtml(test.name)} screenshot">` : ""}
    </li>`;
}

export function renderHtmlReport(summary: RunSummary): string {
  const allTests = summary.suites.flatMap((s) => s.tests);
  const failing = allTests.filter((t) => t.status === "failed" || t.status === "error");
  const rest = allTests.filter((t) => t.status !== "failed" && t.status !== "error");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Kestrel test report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 32px; background: #f4f6f8; color: #161a1f; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #5b6670; }
  .totals { margin-bottom: 24px; font-size: 14px; color: #5b6670; }
  ul.test-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  li.test { border: 1px solid #d7dee3; border-radius: 8px; padding: 12px 16px; background: #fff; }
  li.test.failed, li.test.error { border-color: #b23a2e; background: #fbe7e4; }
  li.test.passed { border-color: #2e7d4f; background: #e3f3e9; }
  li.test.skipped { border-color: #d7dee3; background: #eef1f3; }
  .test-head { display: flex; justify-content: space-between; align-items: baseline; font-weight: 600; }
  .test-status { font-size: 11px; text-transform: uppercase; font-weight: 600; color: #5b6670; }
  .test-message { white-space: pre-wrap; font-size: 13px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; margin: 8px 0 0; }
  img.screenshot { max-width: 480px; display: block; margin-top: 8px; border-radius: 4px; border: 1px solid #d7dee3; }
  section { margin-bottom: 32px; }
</style>
</head>
<body>
  <h1>Kestrel test report</h1>
  <div class="totals">${summary.passed} passed &middot; ${summary.failed} failed &middot; ${summary.skipped} skipped &middot; ${summary.errored} errored</div>
  ${failing.length > 0 ? `<section><h2>Failures</h2><ul class="test-list">${failing.map(renderTestCase).join("")}</ul></section>` : ""}
  <section><h2>All tests</h2><ul class="test-list">${rest.map(renderTestCase).join("")}</ul></section>
</body>
</html>
`;
}
