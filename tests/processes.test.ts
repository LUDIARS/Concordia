import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestDb, makeTestDir } from "./helpers/db.js";
import { ProcessesRepo } from "../src/db/processes-repo.js";
import { ProcessManager } from "../src/processes/manager.js";
import { parseDevProcessMd, readDevProcessMd } from "../src/processes/dev-process-md.js";
import { windowsTreeKillArgs } from "../src/processes/runner.js";

it("builds a Windows taskkill command that includes the full process tree", () => {
  expect(windowsTreeKillArgs(1234)).toEqual(["/PID", "1234", "/T", "/F"]);
});

function tmpRepo(content: string): string {
  const dir = makeTestDir("concordia-proc-test-");
  writeFileSync(join(dir, "dev-process.md"), content, "utf8");
  return dir;
}

function makeRepo() {
  const db = makeTestDb();
  return new ProcessesRepo(db);
}

function makeManager(repo: ProcessesRepo): ProcessManager {
  const logsDir = makeTestDir("concordia-test-logs-");
  return new ProcessManager({ repo, logsDir });
}

const nodeCommand = (source: string) => ({ file: process.execPath, args: ["-e", source] });

describe("dev-process.md parser", () => {
  it("returns empty processes when no fence", () => {
    const out = parseDevProcessMd("# heading\nplain text");
    expect(out.processes).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it("parses concordia.processes JSON fence", () => {
    const md = [
      "# Dev process marker",
      "",
      "```concordia.processes",
      JSON.stringify({
        processes: [
          { name: "be", command: { file: "node", args: ["srv.js"] } },
          { name: "fe", command: { file: "vite", args: [] }, cwd: "web", auto_start: false },
        ],
      }, null, 2),
      "```",
    ].join("\n");
    const out = parseDevProcessMd(md);
    expect(out.processes).toHaveLength(2);
    expect(out.processes[0]).toMatchObject({ name: "be", command: { file: "node", args: ["srv.js"] } });
    expect(out.processes[1]).toMatchObject({ name: "fe", cwd: "web", auto_start: false });
    expect(out.warnings).toEqual([]);
  });

  it("warns and skips invalid name / duplicate", () => {
    const md = [
      "```concordia.processes",
      JSON.stringify({
        processes: [
          { name: "ok", command: { file: "x", args: [] } },
          { name: "ok", command: { file: "y", args: [] } },        // duplicate
          { name: "bad name!", command: { file: "z", args: [] } }, // invalid name
          { name: "no-cmd", command: "" },     // empty command
        ],
      }),
      "```",
    ].join("\n");
    const out = parseDevProcessMd(md);
    expect(out.processes).toHaveLength(1);
    expect(out.processes[0].name).toBe("ok");
    expect(out.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("readDevProcessMd: existence + parse", async () => {
    const dir = tmpRepo("# marker only");
    const out = await readDevProcessMd(dir);
    expect(out.exists).toBe(true);
    expect(out.processes).toEqual([]);
    expect(out.path).toBe(join(dir, "dev-process.md"));
  });

  it("readDevProcessMd: no file = exists false", async () => {
    const dir = makeTestDir("concordia-no-md-");
    const out = await readDevProcessMd(dir);
    expect(out.exists).toBe(false);
  });
});

describe("ProcessesRepo", () => {
  it("upsert / setStarted / setExited round trip", () => {
    const repo = makeRepo();
    repo.upsert({
      name: "p1", cwd: "/x", command: "echo",
      repo_path: "/x", repo_origin: null, log_path: "/tmp/p1.log",
      instance_id: "instance-1", generation: 1,
    });
    expect(repo.find("p1")?.status).toBe("starting");
    repo.setStarted("p1", "instance-1", 1, 1234, 1000);
    const after = repo.find("p1")!;
    expect(after.pid).toBe(1234);
    expect(after.status).toBe("running");

    repo.appendLog({ process_name: "p1", ts: 1001, stream: "stdout", level: null, line: "hello" });
    repo.appendLog({ process_name: "p1", ts: 1002, stream: "stderr", level: "error", line: "Error: bad" });
    expect(repo.recentLogs("p1", { limit: 10 })).toHaveLength(2);
    expect(repo.recentLogs("p1", { level: "error" })).toHaveLength(1);

    repo.setExited("p1", "instance-1", 1, { exit_code: 0, exit_signal: null, exited_at: 1100, failed: false });
    expect(repo.find("p1")?.status).toBe("exited");

    repo.remove("p1");
    expect(repo.find("p1")).toBeNull();
    expect(repo.recentLogs("p1")).toHaveLength(0);
  });
});

describe("ProcessManager spawn", () => {
  it("startOne runs a short command, captures stdout, marks exited", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    // 短命コマンド: cross-platform に node -e で固定行を吐く
    const r = await mgr.startOne({
      name: "echo1",
      command: nodeCommand("console.log('hello-runner')"),
      cwd: process.cwd(),
      repo_path: null,
    });
    expect(r.ok).toBe(true);

    // exit を待つ
    await new Promise<void>((resolve, reject) => {
      const t = setInterval(() => {
        const row = repo.find("echo1");
        if (row && (row.status === "exited" || row.status === "failed")) {
          clearInterval(t);
          clearTimeout(deadline);
          resolve();
        }
      }, 50);
      const deadline = setTimeout(() => { clearInterval(t); reject(new Error("process did not exit within 5s")); }, 5000);
    });

    const row = repo.find("echo1")!;
    expect(["exited", "failed"]).toContain(row.status);
    const logs = repo.recentLogs("echo1", { limit: 50 });
    const stdoutLines = logs.filter((l) => l.stream === "stdout").map((l) => l.line);
    expect(stdoutLines.some((l) => l.includes("hello-runner"))).toBe(true);
  }, 20000);

  it("startFromRepo skips when no dev-process.md", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const dir = makeTestDir("concordia-empty-");
    const r = await mgr.startFromRepo(dir, null);
    expect(r.started).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.devProcessMdPath).toBeNull();
  });

  it("startFromRepo treats marker-only file as no-op", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const dir = tmpRepo("# Dev marker, no fence");
    const r = await mgr.startFromRepo(dir, null);
    expect(r.started).toEqual([]);
    expect(r.marker_only).toBe(true);
  });

  it("stopAll terminates every running process", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const r1 = await mgr.startOne({
      name: "ka", command: nodeCommand("setTimeout(()=>{},5000)"), cwd: process.cwd(),
    });
    const r2 = await mgr.startOne({
      name: "kb", command: nodeCommand("setTimeout(()=>{},5000)"), cwd: process.cwd(),
    });
    expect(r1.ok && r2.ok).toBe(true);
    expect(mgr.listRunning()).toHaveLength(2);

    // pid を控えておく (stopAll 後の実プロセス終了確認に使う)
    const pids = [r1.pid, r2.pid].filter((p): p is number => typeof p === "number" && p > 0);

    await mgr.stopAll(2000);

    // manager 内 Map が空になること
    expect(mgr.listRunning()).toHaveLength(0);

    // 実プロセスが終了していること: pid への signal 0 が throw するまで有限リトライ。
    // Windows では taskkill /T /F、POSIX では signal fallback でラッパーを終了する。
    const deadline = Date.now() + 3000;
    for (const pid of pids) {
      let exited = false;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0); // プロセスが生きていれば例外なし
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          exited = true;
          break;
        }
      }
      expect(exited, `pid ${pid} should have exited within timeout`).toBe(true);
    }
  }, 20000);

  it("ad-hoc startOne refuses duplicate names", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    // sleep 相当: node -e + setTimeout で 1.5s 走らせる
    const r1 = await mgr.startOne({
      name: "dup",
      command: nodeCommand("setTimeout(()=>{},1500)"),
      cwd: process.cwd(),
    });
    expect(r1.ok).toBe(true);
    const r2 = await mgr.startOne({
      name: "dup",
      command: nodeCommand("setTimeout(()=>{},1500)"),
      cwd: process.cwd(),
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("already_running");
    return mgr.stopAll();
  }, 20000);
});
