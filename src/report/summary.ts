import type { RunSummary } from "../types.js";

export function renderSummaryMarkdown(summary: RunSummary, dashboardUrl?: string | null): string {
  const lines: string[] = [];
  lines.push("## Kestrel test run");
  lines.push("");
  lines.push(
    `**${summary.passed} passed**, **${summary.failed} failed**, ${summary.skipped} skipped, ${summary.errored} errored`
  );
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
  lines.push("");

  const failures = summary.suites.flatMap((suite) =>
    suite.tests
      .filter((t) => t.status === "failed" || t.status === "error")
      .map((test) => ({ suite: suite.name, test }))
  );

  if (failures.length === 0) {
    lines.push("No failures.");
    return lines.join("\n");
  }

  lines.push("### Failures");
  lines.push("");
  for (const { suite, test } of failures) {
    lines.push(`- **${test.name}** (${suite})`);
    if (test.message) lines.push(`  ${test.message}`);
    if (test.screenshotPath) lines.push(`  Screenshot: \`${test.screenshotPath}\` — in this run's artifacts.`);
  }

  return lines.join("\n");
}
