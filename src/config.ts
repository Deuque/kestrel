import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AppiumConfig {
  /** Path to the APK under test. Installed via `adb install -r` before the suite runs. */
  apk: string;
  /** Port kestrel's managed Appium server listens on. Reused if something is already there. */
  port?: number;
  /** Appium `deviceName` capability. */
  deviceName?: string;
  /** Appium `platformName` capability. */
  platformName?: string;
  /** Appium `automationName` capability. */
  automationName?: string;
  /**
   * Set to false when the test suite already manages its own Appium server —
   * e.g. a custom AppiumService with plugins, relaxed-security flags, or
   * per-xdist-worker ports that kestrel's generic server can't replicate.
   * Kestrel still installs the APK and runs testCommand, but starts no
   * server and injects no driver-fixture plugin: the suite is on its own,
   * same as before this suite adopted kestrel. Defaults to true.
   */
  ownServer?: boolean;
}

export interface KestrelConfig {
  /**
   * "appium" — kestrel owns the harness: starts an Appium server, installs the
   * APK, and injects a pytest plugin (a `driver` fixture + screenshot-on-failure)
   * so testCommand can be raw test files with no Appium setup of their own.
   *
   * "integration" — kestrel just runs testCommand as-is. No server, no APK,
   * no injected fixtures — the suite is expected to be fully self-contained.
   */
  platform: "appium" | "integration";
  /** Shell command that runs the test suite and writes JUnit XML into resultsDir. */
  testCommand: string;
  /** Directory to scan for JUnit XML result files (*.xml) after testCommand finishes. */
  resultsDir: string;
  /** Directory to scan for screenshots, matched to failing tests by filename. */
  screenshotsDir?: string;
  /** Where the generated report (HTML + markdown + JSON) is written. */
  reportDir?: string;
  /** Required when platform is "appium". */
  appium?: AppiumConfig;
}

export function loadConfig(path: string): KestrelConfig {
  const absolutePath = resolve(path);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<KestrelConfig>;

  if (!parsed.testCommand) {
    throw new Error(`config at ${absolutePath} is missing required field "testCommand"`);
  }
  if (!parsed.resultsDir) {
    throw new Error(`config at ${absolutePath} is missing required field "resultsDir"`);
  }
  const platform = parsed.platform ?? "integration";
  if (platform !== "appium" && platform !== "integration") {
    throw new Error(`config at ${absolutePath}: "platform" must be "appium" or "integration", got "${platform}"`);
  }
  if (platform === "appium" && !parsed.appium?.apk) {
    throw new Error(`config at ${absolutePath}: platform "appium" requires "appium.apk"`);
  }

  return {
    platform,
    testCommand: parsed.testCommand,
    resultsDir: parsed.resultsDir,
    screenshotsDir: parsed.screenshotsDir,
    reportDir: parsed.reportDir ?? "kestrel-report",
    appium: parsed.appium,
  };
}
