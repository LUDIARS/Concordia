import { spawn } from "node:child_process";
import { join } from "node:path";

const SUPERVISOR_TIMEOUT_MS = 30_000;

/** supervisor を起動して判定を受け取る。 @implements CC-GROK-HOOK GHK-01 */
export function runSupervisor({ runtime, config, input, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(runtime, "harness/supervisor-cli.js"), config], {
      env, windowsHide: true, shell: false, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stderr: `harness supervisor did not answer within ${SUPERVISOR_TIMEOUT_MS} ms` });
    }, SUPERVISOR_TIMEOUT_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stderr: error.message }));
    child.on("exit", (code) => finish({ code, stderr }));
    child.stdin.on("error", () => { /* supervisor が先に終わった。 exit で結果を受け取る */ });
    child.stdin.end(input);
  });
}
