import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toDataUri } from "./dataUri.js";
import type { RunSummary } from "./types.js";

export interface DashboardConfig {
  /** "owner/repo" the dashboard's gh-pages site lives in, e.g. "Deuque/kestrel". */
  repo: string;
  /** Branch GitHub Pages serves. Must already exist. Default "gh-pages". */
  branch?: string;
  /** Label shown on the dashboard for this run's source, e.g. "klasha-mobile-app". */
  project?: string;
}

interface DashboardRunRecord {
  id: string;
  project: string;
  platform: string;
  startedAt: string;
  finishedAt: string;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  suites: {
    name: string;
    tests: {
      name: string;
      classname?: string;
      status: string;
      timeSeconds?: number;
      message?: string;
      screenshot: string | null;
    }[];
  }[];
}

/**
 * Pushes this run's summary — screenshots embedded as base64 — to the
 * dashboard's gh-pages branch as runs/<id>.json, and updates
 * runs/index.json. Needs a GitHub token with push access to `config.repo`
 * in KESTREL_DASHBOARD_TOKEN. Never throws: a dashboard publish failure
 * (missing token, network blip, push race) is logged and skipped rather
 * than failing the actual test run — the real report already exists
 * locally regardless of whether this succeeds.
 */
export async function publishToDashboard(
  config: DashboardConfig,
  summary: RunSummary,
  platform: string
): Promise<string | null> {
  const token = process.env.KESTREL_DASHBOARD_TOKEN;
  if (!token) {
    console.warn("KESTREL_DASHBOARD_TOKEN not set — skipping dashboard publish.");
    return null;
  }

  const branch = config.branch ?? "gh-pages";
  const workDir = mkdtempSync(join(tmpdir(), "kestrel-dashboard-"));

  try {
    await run("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      branch,
      `https://x-access-token:${token}@github.com/${config.repo}.git`,
      workDir,
    ]);

    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    const record: DashboardRunRecord = {
      id,
      project: config.project ?? "unlabeled",
      platform,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      errored: summary.errored,
      suites: summary.suites.map((suite) => ({
        name: suite.name,
        tests: suite.tests.map((test) => ({
          name: test.name,
          classname: test.classname,
          status: test.status,
          timeSeconds: test.timeSeconds,
          message: test.message,
          screenshot: test.screenshotPath ? toDataUri(test.screenshotPath) : null,
        })),
      })),
    };

    mkdirSync(join(workDir, "runs"), { recursive: true });
    writeFileSync(join(workDir, "runs", `${id}.json`), JSON.stringify(record));

    const indexPath = join(workDir, "runs", "index.json");
    const index: unknown[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
    index.unshift({
      id,
      project: record.project,
      platform: record.platform,
      startedAt: record.startedAt,
      passed: record.passed,
      failed: record.failed,
      skipped: record.skipped,
      errored: record.errored,
    });
    // Keep the manifest small — dashboard fetches this on every page load.
    writeFileSync(indexPath, JSON.stringify(index.slice(0, 200), null, 2));

    await run("git", ["-C", workDir, "add", "-A"]);
    await run("git", [
      "-C",
      workDir,
      "-c",
      "user.email=kestrel@localhost",
      "-c",
      "user.name=kestrel",
      "commit",
      "--quiet",
      "-m",
      `Publish run ${id}`,
    ]);
    await run("git", ["-C", workDir, "push", "--quiet", "origin", branch]);

    const [owner, repoName] = config.repo.split("/");
    return `https://${owner.toLowerCase()}.github.io/${repoName}/`;
  } catch (err) {
    console.warn(`Dashboard publish failed, continuing without it: ${(err as Error).message}`);
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}
