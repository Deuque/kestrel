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
  /**
   * Identifies this project on the dashboard. Slugified and used as the
   * on-disk namespace (projects/<slug>/…), so two projects publishing at
   * the same time never touch the same files — the only thing they share
   * is the top-level projects/index.json, which retry-on-push-conflict
   * (below) protects. Required: there's no safe shared default that
   * wouldn't risk unrelated projects colliding in one bucket.
   */
  project: string;
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

const MAX_PUSH_ATTEMPTS = 5;

/**
 * Pushes this run's summary — screenshots embedded as base64 — to
 * projects/<slug>/runs/<id>.json on the dashboard's gh-pages branch,
 * updates that project's runs/index.json, and upserts this project's entry
 * in the top-level projects/index.json. Needs a GitHub token with push
 * access to `config.repo` in KESTREL_DASHBOARD_TOKEN. Never throws: a
 * dashboard publish failure (missing token, network blip, exhausted
 * retries) is logged and skipped rather than failing the actual test run —
 * the real report already exists locally regardless of whether this
 * succeeds.
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

  const slug = slugify(config.project);
  const branch = config.branch ?? "gh-pages";
  const remote = `https://x-access-token:${token}@github.com/${config.repo}.git`;
  const workDir = mkdtempSync(join(tmpdir(), "kestrel-dashboard-"));

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const record: DashboardRunRecord = {
    id,
    project: config.project,
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

  try {
    await run("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, remote, workDir]);

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      writeRunFiles(workDir, slug, record);

      await run("git", ["-C", workDir, "add", "-A"]);
      const changed = await hasStagedChanges(workDir);
      if (changed) {
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
          `Publish ${slug} run ${id}`,
        ]);
      }

      const pushed = await tryPush(workDir, branch);
      if (pushed) {
        const [owner, repoName] = config.repo.split("/");
        return `https://${owner.toLowerCase()}.github.io/${repoName}/#${slug}`;
      }

      // Someone else pushed first — pull their state in and redo our
      // writes on top of it, rather than clobbering what they just added.
      await run("git", ["-C", workDir, "fetch", "--quiet", "origin", branch]);
      await run("git", ["-C", workDir, "reset", "--quiet", "--hard", `origin/${branch}`]);
    }

    console.warn(`Dashboard publish: gave up after ${MAX_PUSH_ATTEMPTS} conflicting pushes.`);
    return null;
  } catch (err) {
    console.warn(`Dashboard publish failed, continuing without it: ${(err as Error).message}`);
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function writeRunFiles(workDir: string, slug: string, record: DashboardRunRecord): void {
  const projectDir = join(workDir, "projects", slug);
  const runsDir = join(projectDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${record.id}.json`), JSON.stringify(record));

  const runIndexPath = join(runsDir, "index.json");
  const runIndex = readJsonArray(runIndexPath);
  runIndex.unshift({
    id: record.id,
    project: record.project,
    platform: record.platform,
    startedAt: record.startedAt,
    passed: record.passed,
    failed: record.failed,
    skipped: record.skipped,
    errored: record.errored,
  });
  // Keep each project's manifest small — the dashboard fetches this on every load.
  writeFileSync(runIndexPath, JSON.stringify(runIndex.slice(0, 200), null, 2));

  const projectIndexPath = join(workDir, "projects", "index.json");
  const projectIndex = readJsonArray(projectIndexPath) as Array<Record<string, unknown>>;
  const existing = projectIndex.findIndex((p) => p.id === slug);
  const projectEntry = {
    id: slug,
    project: record.project,
    lastPublishedAt: record.finishedAt,
    lastPassed: record.passed,
    lastFailed: record.failed,
  };
  if (existing >= 0) projectIndex[existing] = projectEntry;
  else projectIndex.push(projectEntry);
  writeFileSync(projectIndexPath, JSON.stringify(projectIndex, null, 2));
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function hasStagedChanges(workDir: string): Promise<boolean> {
  const { code } = await runCapture("git", ["-C", workDir, "diff", "--cached", "--quiet"]);
  return code !== 0;
}

async function tryPush(workDir: string, branch: string): Promise<boolean> {
  const { code } = await runCapture("git", ["-C", workDir, "push", "--quiet", "origin", branch]);
  return code === 0;
}

function slugify(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`dashboard.project "${project}" produced an empty slug`);
  return slug;
}

function runCapture(cmd: string, args: string[]): Promise<{ code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("close", (code) => resolvePromise({ code: code ?? 1 }));
    child.on("error", () => resolvePromise({ code: 1 }));
  });
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
