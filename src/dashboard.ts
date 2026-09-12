import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toDataUri } from "./dataUri.js";
import type { NetworkEntry, RunSummary } from "./types.js";

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
  /**
   * Groups this run with others published under the same id — e.g. several
   * kestrel instances each running a shard of one suite in parallel, from
   * one CI pipeline run. Each shard still publishes its own run
   * independently (same conflict-safe path as any other run); the
   * dashboard collapses runs sharing a jobId into one expandable row with
   * aggregated totals. Falls back to $KESTREL_JOB_ID so a CI matrix can set
   * it once via env instead of templating it into every shard's config.
   * Omit entirely to keep a run standalone, same as before this existed.
   */
  jobId?: string;
  /**
   * Label for this run within its job (e.g. "shard 2", a device name) —
   * shown when a job row is expanded. Falls back to $KESTREL_SHARD, then to
   * a short id. Meaningless without jobId.
   */
  shard?: string;
}

export interface PendingRun {
  id: string;
  jobId: string | null;
  shard: string | null;
}

type DashboardRunStatus = "pending" | "passed" | "failed";

interface DashboardRunRecord {
  id: string;
  project: string;
  platform: string;
  jobId: string | null;
  shard: string | null;
  ciRunUrl: string | null;
  status: DashboardRunStatus;
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
      networkLogs?: NetworkEntry[];
    }[];
  }[];
}

// Publishing now happens twice per run (started, then finished) instead of
// once, roughly doubling push contention when several shards of one job
// race to publish at the same time — raised from 5 after load-testing showed
// occasional exhaustion at 5 with 5-way concurrency (harmless: a failed
// "started" publish just falls back to appearing only once finished).
const MAX_PUSH_ATTEMPTS = 10;

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

function resolveJobIdentity(config: DashboardConfig, id: string): { jobId: string | null; shard: string | null } {
  const jobId = config.jobId ?? process.env.KESTREL_JOB_ID ?? null;
  const shard = config.shard ?? process.env.KESTREL_SHARD ?? (jobId ? id.slice(-6) : null);
  return { jobId, shard };
}

/**
 * Publishes a placeholder record the moment a run starts — status
 * "pending", zero counts — so the dashboard can show it as running rather
 * than only appearing once results exist (see publishRunFinished). Returns
 * the identity to pass into publishRunFinished so it updates this same
 * record instead of creating a second one; null if publish is skipped
 * (missing token) or fails, in which case publishRunFinished falls back to
 * publishing fresh.
 */
export async function publishRunStarted(config: DashboardConfig, platform: string): Promise<PendingRun | null> {
  const token = process.env.KESTREL_DASHBOARD_TOKEN;
  if (!token) {
    console.warn("KESTREL_DASHBOARD_TOKEN not set — skipping dashboard publish.");
    return null;
  }

  const id = newRunId();
  const { jobId, shard } = resolveJobIdentity(config, id);
  const now = new Date().toISOString();
  const record: DashboardRunRecord = {
    id,
    project: config.project,
    platform,
    jobId,
    shard,
    ciRunUrl: githubActionsRunUrl(),
    status: "pending",
    startedAt: now,
    finishedAt: now,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    suites: [],
  };

  const url = await publishRecord(config, token, record, { updateProjectIndex: false });
  return url === null ? null : { id, jobId, shard };
}

/**
 * Publishes the finished run — real counts, status "passed"/"failed" — and
 * upserts this project's entry in the top-level projects/index.json.
 * Updates the record `pending` identifies (from publishRunStarted) in
 * place, matched by id, rather than adding a second entry for the same
 * run; if `pending` is null (the start publish was skipped or failed),
 * publishes fresh instead. Needs a GitHub token with push access to
 * `config.repo` in KESTREL_DASHBOARD_TOKEN. Never throws: a dashboard
 * publish failure (missing token, network blip, exhausted retries) is
 * logged and skipped rather than failing the actual test run — the real
 * report already exists locally regardless of whether this succeeds.
 */
export async function publishRunFinished(
  config: DashboardConfig,
  pending: PendingRun | null,
  summary: RunSummary,
  platform: string
): Promise<string | null> {
  const token = process.env.KESTREL_DASHBOARD_TOKEN;
  if (!token) {
    console.warn("KESTREL_DASHBOARD_TOKEN not set — skipping dashboard publish.");
    return null;
  }

  const id = pending?.id ?? newRunId();
  const { jobId, shard } = pending ?? resolveJobIdentity(config, id);
  const record: DashboardRunRecord = {
    id,
    project: config.project,
    platform,
    jobId,
    shard,
    ciRunUrl: githubActionsRunUrl(),
    status: summary.failed + summary.errored > 0 ? "failed" : "passed",
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
        networkLogs: test.networkLogs,
      })),
    })),
  };

  return publishRecord(config, token, record, { updateProjectIndex: true });
}

async function publishRecord(
  config: DashboardConfig,
  token: string,
  record: DashboardRunRecord,
  opts: { updateProjectIndex: boolean }
): Promise<string | null> {
  const slug = slugify(config.project);
  const branch = config.branch ?? "gh-pages";
  const remote = `https://x-access-token:${token}@github.com/${config.repo}.git`;
  const workDir = mkdtempSync(join(tmpdir(), "kestrel-dashboard-"));

  try {
    await run("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, remote, workDir]);

    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      writeRunFiles(workDir, slug, record, opts.updateProjectIndex);

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
          `Publish ${slug} run ${record.id} (${record.status})`,
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

function writeRunFiles(workDir: string, slug: string, record: DashboardRunRecord, updateProjectIndex: boolean): void {
  const projectDir = join(workDir, "projects", slug);
  const runsDir = join(projectDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${record.id}.json`), JSON.stringify(record));

  const runIndexPath = join(runsDir, "index.json");
  const runIndex = readJsonArray(runIndexPath) as Array<Record<string, unknown>>;
  const indexEntry = {
    id: record.id,
    project: record.project,
    platform: record.platform,
    jobId: record.jobId,
    shard: record.shard,
    ciRunUrl: record.ciRunUrl,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    passed: record.passed,
    failed: record.failed,
    skipped: record.skipped,
    errored: record.errored,
  };
  // publishRunFinished updates the same entry publishRunStarted created
  // (matched by id) instead of adding a duplicate for the same run.
  const existingRun = runIndex.findIndex((r) => r.id === record.id);
  if (existingRun >= 0) runIndex[existingRun] = indexEntry;
  else runIndex.unshift(indexEntry);
  runIndex.sort((a, b) => new Date(b.startedAt as string).getTime() - new Date(a.startedAt as string).getTime());
  // Keep each project's manifest small — the dashboard fetches this on every load.
  writeFileSync(runIndexPath, JSON.stringify(runIndex.slice(0, 200), null, 2));

  // The pending publish (run just started, counts all zero) must not
  // clobber the project card's "last known" snapshot — only a finished
  // run's real numbers should update it.
  if (!updateProjectIndex) return;

  const projectIndexPath = join(workDir, "projects", "index.json");
  const projectIndex = readJsonArray(projectIndexPath) as Array<Record<string, unknown>>;
  const existing = projectIndex.findIndex((p) => p.id === slug);
  const total = record.passed + record.failed + record.errored + record.skipped;
  const passRate = total > 0 ? Math.round((record.passed / total) * 100) : 100;
  const previousTrend = existing >= 0 && Array.isArray(projectIndex[existing]!.trend) ? (projectIndex[existing]!.trend as number[]) : [];
  const projectEntry = {
    id: slug,
    project: record.project,
    lastPublishedAt: record.finishedAt,
    lastPlatform: record.platform,
    lastPassed: record.passed,
    lastFailed: record.failed,
    // Rolling pass-rate history (last 12 runs) — powers the trend sparkline
    // on the project card without the dashboard fetching every run.
    trend: [...previousTrend, passRate].slice(-12),
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

/**
 * Links a published run back to the GitHub Actions run that produced it, so
 * the dashboard can offer "view / re-run in GitHub Actions" instead of
 * kestrel trying to trigger a re-run itself — a static gh-pages site has no
 * safe place to hold a token with actions:write, so this defers to GitHub's
 * own re-run buttons and permissions instead. All three env vars are set
 * automatically on every GitHub Actions runner; null outside that context
 * (e.g. running kestrel locally, or on non-GitHub CI).
 */
function githubActionsRunUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null;
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
