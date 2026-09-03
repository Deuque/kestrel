import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNetworkLog } from "./networkLog.js";
import type { TestCase } from "./types.js";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

export function listScreenshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => IMAGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)))
    .map((name) => join(dir, name));
}

/**
 * Best-effort filename matching: a screenshot attaches to a test if its
 * filename and the test name share a normalized substring. There's no
 * established naming convention across test frameworks, so this is a
 * heuristic, not a guarantee — see README for the naming convention that
 * makes matches reliable. Skipped tests never ran, so there's nothing to
 * attach; passed and failed tests both get a screenshot when one matches —
 * a passing test's screenshot is visible proof it actually ran.
 *
 * A matched screenshot also pulls in its sibling device log, if kestrel's
 * pytest plugin wrote one alongside it (same basename, .log extension) —
 * parsed into structured network entries where recognizable.
 */
export function attachScreenshots(tests: TestCase[], screenshotPaths: string[]): void {
  const slugged = screenshotPaths.map((path) => ({ path, slug: slug(path) }));

  for (const test of tests) {
    if (test.status === "skipped") continue;
    const key = slug(test.name);
    const match = slugged.find(({ slug: s }) => s.includes(key) || key.includes(s));
    if (!match) continue;

    test.screenshotPath = match.path;

    const logPath = match.path.replace(/\.(png|jpe?g)$/i, ".log");
    if (!existsSync(logPath)) continue;
    test.logPath = logPath;
    try {
      test.networkLogs = parseNetworkLog(readFileSync(logPath, "utf8"));
    } catch {
      // best-effort; leave networkLogs unset
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
