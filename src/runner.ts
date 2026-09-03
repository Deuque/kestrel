import { spawn } from "node:child_process";

/** Installs an APK onto whatever device/emulator `adb` currently targets. */
export function installApk(apkPath: string): Promise<void> {
  return run("adb", ["install", "-r", apkPath]);
}

/** Runs the user's test command via the shell, streaming its output straight through. */
export function runTestCommand(command: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, stdio: "inherit", env });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}
