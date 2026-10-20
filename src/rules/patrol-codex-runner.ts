/** Bounded, tool-free Codex invocation for patrol text; owns its temporary output. */
import { execFileOneShot, resolveModel } from "@ludiars/one-shot";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexModelCommand } from "../model-catalog/codex-command.js";
import { recordLocalOneShot } from "../cost/one-shot-recorder.js";

export function patrolCodexArgs(model: string, output: string): string[] {
  return ["exec", "--model", model, "-c", 'model_reasoning_effort="high"',
    "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
    "--disable", "shell_tool", "--disable", "plugins",
    "-c", "mcp_servers={}", "-c", "project_root_markers=[]", "-c", "project_doc_max_bytes=0",
    "-c", 'web_search="disabled"', "--output-last-message", output, "-"];
}

export async function runPatrolCodex(prompt: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const startedAt = Date.now();
  const model = resolveModel("luna", "codex");
  const cwd = await mkdtemp(join(tmpdir(), "cc-patrol-"));
  let ok = false;
  try {
    const launch = await resolveCodexModelCommand({
      platform: process.platform, path: process.env.PATH ?? "", nodeExecutable: process.execPath,
      explicit: process.env.CONCORDIA_CODEX_MODEL_CATALOG_EXECUTABLE,
    });
    const output = join(cwd, "answer.txt");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(CONCORDIA_|LICTOR_|CLAUDECODE$|CLAUDE_CODE_SESSION|CODEX_THREAD_ID$)/.test(key)) delete env[key];
    }
    const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      const child = execFileOneShot(launch.executable, [...launch.prefixArgs, ...patrolCodexArgs(model, output)], {
        cwd, env, shell: false, windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL",
        maxBuffer: 256 * 1024, encoding: "utf8",
      }, (error, _stdout, stderr) => resolve({ ok: !error, stderr: error ? String(stderr || error.message).slice(-4000) : "" }));
      child.stdin?.on("error", () => { child.kill("SIGKILL"); });
      child.stdin?.end(prompt, "utf8");
    });
    if (!result.ok) return { ...result, stdout: "" };
    if ((await stat(output)).size > 16000) throw new Error("patrol_output_limit");
    const stdout = await readFile(output, "utf8");
    ok = stdout.trim().length > 0;
    return { ok, stdout, stderr: ok ? "" : "patrol_empty_output" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  } finally {
    recordLocalOneShot({ ts: startedAt, service: "concordia", provider: "codex", command: "codex exec",
      model, cwd, prompt, status: ok ? "ok" : "error", duration_ms: Date.now() - startedAt,
      metadata_json: JSON.stringify({ purpose: "patrol", effort: "high" }) });
    await rm(cwd, { recursive: true, force: true });
  }
}
