import type { RunSummary, TestCase, TestStatus, TestSuiteResult } from "../types.js";

function badge(label: string, value: number, color: string): string {
  const text = encodeURIComponent(`${label}-${value}`);
  return `![${label}: ${value}](https://img.shields.io/badge/${text}-${color}?style=flat-square)`;
}

function headline(summary: RunSummary): string {
  const parts = [`${summary.passed} passed`, `${summary.failed} failed`];
  if (summary.errored > 0) parts.push(`${summary.errored} errored`);
  parts.push(`${summary.skipped} skipped`);
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

interface SuiteStats {
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  timeSeconds: number | null;
}

function statsFor(suite: TestSuiteResult): SuiteStats {
  const count = (status: TestStatus) => suite.tests.filter((t) => t.status === status).length;
  const timed = suite.tests.filter((t) => t.timeSeconds !== undefined);
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    errored: count("error"),
    timeSeconds: timed.length > 0 ? timed.reduce((sum, t) => sum + t.timeSeconds!, 0) : null,
  };
}

function fmtSeconds(seconds: number | null): string {
  if (seconds === null) return "—";
  return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function suiteRow(suite: TestSuiteResult): string {
  const s = statsFor(suite);
  const failedCell = s.failed + s.errored > 0 ? `**${s.failed + s.errored}** ❌` : "0";
  const skippedCell = s.skipped > 0 ? `${s.skipped} ⚪` : "0";
  return `| ${suite.name} | ${s.passed} ✅ | ${failedCell} | ${skippedCell} | ${fmtSeconds(s.timeSeconds)} |`;
}

function failureBlock(suiteName: string, test: TestCase): string {
  const lines = [`#### ${test.status === "error" ? "🟠" : "❌"} \`${test.name}\` <sub>${suiteName}</sub>`];
  if (test.message) lines.push("", "```", test.message.trim(), "```");
  if (test.screenshotPath) lines.push("", `📸 Screenshot captured — see \`${test.screenshotPath}\` in this run's artifacts.`);
  if (test.networkLogs && test.networkLogs.length > 0) {
    const failing = test.networkLogs.filter((n) => (n.statusCode !== undefined && n.statusCode >= 400) || (n.statusCode === undefined && n.snippet));
    if (failing.length > 0) {
      lines.push("", `<details><summary>Network — ${test.networkLogs.length} call${test.networkLogs.length === 1 ? "" : "s"}, ${failing.length} failed</summary>`, "");
      for (const n of failing) {
        const status = n.statusCode !== undefined ? String(n.statusCode) : "no response";
        lines.push(`- \`${n.method ?? "?"} ${n.url}\` → **${status}**`);
        if (n.snippet) lines.push("  ```", ...n.snippet.trim().split("\n").map((l) => `  ${l}`), "  ```");
      }
      lines.push("", "</details>");
    }
  }
  return lines.join("\n");
}

export function renderSummaryMarkdown(summary: RunSummary, dashboardUrl?: string | null): string {
  const lines: string[] = [];
  lines.push("## Kestrel test run", "");
  lines.push(`### ${headline(summary)}`, "");

  const badges = [badge("passed", summary.passed, "2e7d4f")];
  badges.push(badge("failed", summary.failed, summary.failed > 0 ? "b23a2e" : "2e7d4f"));
  if (summary.errored > 0) badges.push(badge("errored", summary.errored, "b23a2e"));
  badges.push(badge("skipped", summary.skipped, "6b7684"));
  lines.push(badges.join(" "), "");

  if (dashboardUrl) {
    lines.push(`🔗 [View this run on the dashboard](${dashboardUrl})`, "");
  }

  if (summary.suites.length > 0) {
    lines.push(
      "<details>",
      "<summary>Expand for details</summary>",
      "",
      "| Suite | Passed | Failed | Skipped | Time |",
      "|---|---|---|---|---|",
      ...summary.suites.map(suiteRow),
      "",
      "</details>",
      ""
    );
  }

  const failures = summary.suites.flatMap((suite) =>
    suite.tests
      .filter((t) => t.status === "failed" || t.status === "error")
      .map((test) => ({ suite: suite.name, test }))
  );

  if (failures.length === 0) {
    lines.push("No failures. ✅");
    return lines.join("\n");
  }

  lines.push("### Failures", "");
  failures.forEach(({ suite, test }, i) => {
    lines.push(failureBlock(suite, test));
    if (i < failures.length - 1) lines.push("", "---", "");
  });

  return lines.join("\n");
}
