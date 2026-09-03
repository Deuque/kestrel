import { spawn, type ChildProcess } from "node:child_process";

// Pinned rather than "latest": an unpinned `npx appium` can resolve to
// whatever's cached or newest at the time, and Appium's driver ecosystem
// doesn't stay compatible across that drift — a newer uiautomator2 release
// can require a core version an older cached `appium` doesn't satisfy (or
// vice versa). Pinning both keeps a kestrel run reproducible. Verified
// together under Node 20.20.2 (the version this actually runs under in CI):
// server starts and reports ready, and the driver installs and is
// recognized. Bump both at once, deliberately, when there's a reason to.
const APPIUM_VERSION = "3.7.0";
const UIAUTOMATOR2_DRIVER_VERSION = "8.5.2";

export interface AppiumServerHandle {
  port: number;
  /** false if kestrel found a server already listening and reused it — stop() is then a no-op. */
  ownsProcess: boolean;
  child?: ChildProcess;
}

/** Starts a local Appium server on `port`, or reuses one that's already reachable there. */
export async function startAppiumServer(port: number, readyTimeoutMs = 30_000): Promise<AppiumServerHandle> {
  if (await isReachable(port)) {
    console.log(`Appium server already reachable on port ${port} — reusing it.`);
    return { port, ownsProcess: false };
  }

  await ensureUiAutomator2Driver();

  console.log(`Starting Appium server on port ${port}...`);
  const child = spawn("npx", ["--yes", `appium@${APPIUM_VERSION}`, "--port", String(port), "--log-level", "error"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[appium] ${chunk}`));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[appium] ${chunk}`));

  await waitUntilReachable(port, readyTimeoutMs, child);
  console.log(`Appium server ready on port ${port}.`);
  return { port, ownsProcess: true, child };
}

/** Stops a server kestrel started. Leaves alone one it merely reused. */
export async function stopAppiumServer(handle: AppiumServerHandle): Promise<void> {
  if (!handle.ownsProcess || !handle.child) return;
  handle.child.kill();
}

/**
 * A fresh `appium` install has no drivers — session creation fails with
 * "Could not find a driver for automationName 'UiAutomator2'" until one is
 * installed. Idempotent: skips the (slow, network-dependent) install if
 * already present.
 */
async function ensureUiAutomator2Driver(): Promise<void> {
  if (await isUiAutomator2Installed()) return;

  console.log(`Installing Appium's uiautomator2 driver (${UIAUTOMATOR2_DRIVER_VERSION})...`);
  await runStreamed("npx", [
    "--yes",
    `appium@${APPIUM_VERSION}`,
    "driver",
    "install",
    `uiautomator2@${UIAUTOMATOR2_DRIVER_VERSION}`,
  ]);
}

async function isUiAutomator2Installed(): Promise<boolean> {
  const { stdout, code } = await runCapture("npx", [
    "--yes",
    `appium@${APPIUM_VERSION}`,
    "driver",
    "list",
    "--installed",
    "--json",
  ]);
  if (code !== 0) return false;
  try {
    const installed = JSON.parse(stdout) as Record<string, unknown>;
    return Object.hasOwn(installed, "uiautomator2");
  } catch {
    return false;
  }
}

function runCapture(cmd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolvePromise({ stdout, code: code ?? 1 }));
    child.on("error", () => resolvePromise({ stdout, code: 1 }));
  });
}

function runStreamed(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function isReachable(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilReachable(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const start = Date.now();
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  while (Date.now() - start < timeoutMs) {
    if (exited) {
      throw new Error(`Appium server process exited before becoming reachable on port ${port}`);
    }
    if (await isReachable(port)) return;
    await sleep(500);
  }
  child.kill();
  throw new Error(`Appium server did not become reachable on port ${port} within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
