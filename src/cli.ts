#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAppiumServer, stopAppiumServer } from "./appiumServer.js";
import { loadConfig, type KestrelConfig } from "./config.js";
import { findJUnitFiles, parseJUnitFile } from "./junit.js";
import { renderHtmlReport } from "./report/html.js";
import { renderSummaryMarkdown } from "./report/summary.js";
import { installApk, runTestCommand } from "./runner.js";
import { attachScreenshots, listScreenshots } from "./screenshots.js";
import type { RunSummary, TestSuiteResult, TestStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_HARNESS_DIR = resolve(__dirname, "..", "python-harness");
const DEFAULT_APPIUM_PORT = 4723;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command !== "run") {
    console.error("usage: kestrel run --config <path-to-config.json>");
    process.exit(1);
  }

  const configPath = flagValue(rest, "--config") ?? "kestrel.config.json";
  const config = loadConfig(configPath);

  const startedAt = new Date().toISOString();
  const testCommandExitCode =
    config.platform === "appium" ? await runAppiumSuite(config) : await runTestCommand(config.testCommand);

  const junitFiles = findJUnitFiles(config.resultsDir);
  if (junitFiles.length === 0) {
    console.warn(`No JUnit XML files found in ${config.resultsDir} — report will be empty.`);
  }
  const suites: TestSuiteResult[] = junitFiles.flatMap(parseJUnitFile);

  const screenshotPaths = config.screenshotsDir ? listScreenshots(config.screenshotsDir) : [];
  for (const suite of suites) attachScreenshots(suite.tests, screenshotPaths);

  const summary: RunSummary = {
    suites,
    passed: countByStatus(suites, "passed"),
    failed: countByStatus(suites, "failed"),
    skipped: countByStatus(suites, "skipped"),
    errored: countByStatus(suites, "error"),
    startedAt,
    finishedAt: new Date().toISOString(),
    testCommandExitCode,
  };

  const reportDir = config.reportDir!;
  mkdirSync(reportDir, { recursive: true });

  const markdown = renderSummaryMarkdown(summary);
  writeFileSync(join(reportDir, "summary.md"), markdown);
  writeFileSync(join(reportDir, "index.html"), renderHtmlReport(summary));
  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log("");
  console.log(markdown);
  console.log("");
  console.log(`Report written to ${reportDir}/`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  }

  process.exit(summary.failed + summary.errored > 0 ? 1 : 0);
}

/**
 * Owns the whole Appium harness so the test repo doesn't have to: installs
 * the APK, starts (or reuses) an Appium server, injects the pytest plugin
 * that provides the `driver` fixture + on-failure screenshots, runs
 * testCommand, then tears the server down.
 */
async function runAppiumSuite(config: KestrelConfig): Promise<number> {
  const appium = config.appium!;

  console.log(`Installing APK: ${appium.apk}`);
  await installApk(appium.apk);

  if (appium.ownServer === false) {
    console.log(
      "appium.ownServer is false — assuming the suite manages its own Appium server. " +
        "Kestrel installed the APK and will just run testCommand as-is (no server, no injected driver fixture)."
    );
    console.log(`Running: ${config.testCommand}`);
    return runTestCommand(config.testCommand);
  }

  const port = appium.port ?? DEFAULT_APPIUM_PORT;
  const server = await startAppiumServer(port);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KESTREL_APPIUM_SERVER_URL: `http://localhost:${server.port}`,
      KESTREL_APK_PATH: resolve(appium.apk),
      KESTREL_PLATFORM_NAME: appium.platformName ?? "Android",
      KESTREL_DEVICE_NAME: appium.deviceName ?? "Android Emulator",
      KESTREL_AUTOMATION_NAME: appium.automationName ?? "UiAutomator2",
      PYTHONPATH: process.env.PYTHONPATH
        ? `${PYTHON_HARNESS_DIR}:${process.env.PYTHONPATH}`
        : PYTHON_HARNESS_DIR,
    };
    if (config.screenshotsDir) {
      env.KESTREL_SCREENSHOTS_DIR = resolve(config.screenshotsDir);
    }

    console.log(`Running: ${config.testCommand}`);
    return await runTestCommand(config.testCommand, env);
  } finally {
    await stopAppiumServer(server);
  }
}

function countByStatus(suites: TestSuiteResult[], status: TestStatus): number {
  return suites.reduce((total, suite) => total + suite.tests.filter((t) => t.status === status).length, 0);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
