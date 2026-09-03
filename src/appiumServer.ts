import { spawn, type ChildProcess } from "node:child_process";

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

  console.log(`Starting Appium server on port ${port}...`);
  const child = spawn("npx", ["--yes", "appium", "--port", String(port), "--log-level", "error"], {
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
