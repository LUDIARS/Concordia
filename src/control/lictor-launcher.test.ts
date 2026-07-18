import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { AdminState } from "../admin/state.js";
import { resolveLictorLauncher } from "./lictor-launcher.js";
import { buildWtArgs, escapeCmdArg } from "./spawner.js";

function admin(defaults?: { lictorDevPath?: string }) {
  const db = makeTestDb();
  return new AdminState(db, defaults);
}

describe("resolveLictorLauncher", () => {
  it("auto (default) → bare lictor", () => {
    expect(resolveLictorLauncher(admin())).toEqual(["lictor"]);
  });

  it("dev → node <devPath>/bin/lictor.mjs", () => {
    const a = admin({ lictorDevPath: "E:\\Document\\Ars\\Lictor" });
    a.setLictorMode("dev");
    const out = resolveLictorLauncher(a);
    expect(out[0]).toBe("node");
    expect(out[1]).toMatch(/Lictor[\\/]bin[\\/]lictor\.mjs$/);
  });

  it("dev with empty path → falls back to bare lictor", () => {
    const a = admin();
    a.setLictorMode("dev");
    expect(resolveLictorLauncher(a)).toEqual(["lictor"]);
  });

  it("prod → configured exe", () => {
    const a = admin();
    a.setLictorMode("prod");
    a.setLictorProdExe("C:\\tools\\lictor.exe");
    expect(resolveLictorLauncher(a)).toEqual(["C:\\tools\\lictor.exe"]);
  });

  it("prod with empty exe → falls back to bare lictor", () => {
    const a = admin();
    a.setLictorMode("prod");
    expect(resolveLictorLauncher(a)).toEqual(["lictor"]);
  });
});

describe("buildWtArgs launcher injection", () => {
  it("default launcher is lictor", () => {
    const args = buildWtArgs({ provider: "claude" });
    // トークンは escapeCmdArg でエスケープされるため、 素の "lictor claude" ではなく
    // 引用符 + caret エスケープされた形で cmd 文字列に現れる。
    expect(args.join(" ")).toContain(
      `cmd.exe /d /s /c ${escapeCmdArg("lictor")} ${escapeCmdArg("claude")}`,
    );
  });

  it("custom launcher replaces the lictor token", () => {
    const args = buildWtArgs({ provider: "codex", cwd: "E:\\x" }, ["node", "E:\\Lictor\\bin\\lictor.mjs"]);
    // launcher + provider は cmd string に結合されるため、 join 後の単一要素で確認する
    const cmdStr = args.find((a) => a.includes("node"));
    expect(cmdStr).toBeDefined();
    expect(cmdStr).toContain(
      `${escapeCmdArg("node")} ${escapeCmdArg("E:\\Lictor\\bin\\lictor.mjs")} ${escapeCmdArg("codex")}`,
    );
    expect(cmdStr).toContain("& exit 0");
  });
});

describe("escapeCmdArg (CWE-78 cmd.exe メタ文字対策)", () => {
  it("メタ文字なしの単純な引数も引用符自体を含め caret エスケープされる", () => {
    // cmd.exe の「/C の中身が単一の引用符ペアで囲まれていると外側を剥がして
    // 無引用のまま再解析する」既知の挙動を避けるため、 引用符自身にも `^` を
    // 前置する (cross-spawn と同じアルゴリズム)。
    expect(escapeCmdArg("claude")).toBe('^"claude^"');
  });

  it("`&` を含む引数はコマンド区切りとして解釈されない形にエスケープされる", () => {
    const escaped = escapeCmdArg("a&whoami");
    // caret でエスケープされた `&` (`^&`) のみが含まれ、 無防備な `&` は残らない。
    expect(escaped).not.toMatch(/[^^]&/);
    expect(escaped).toContain("^&");
  });

  it("スペースを含む引数もコマンド区切りにならない", () => {
    const escaped = escapeCmdArg("hello world");
    expect(escaped).toContain("hello");
    expect(escaped).toContain("world");
  });

  it("buildWtArgs はメタ文字を含む args を単一コマンドの追加要素として実行させない", () => {
    const args = buildWtArgs({ provider: "claude", args: ["--prompt", "a & calc.exe & echo pwned"] });
    const cmdStr = args[args.length - 1];
    expect(cmdStr.endsWith("& exit 0")).toBe(true);
    // 末尾の意図した "& exit 0" (exit code 握り潰し用) を除いた本体部分には、
    // caret でエスケープされていない生の `&` が一切残っていないこと。
    const body = cmdStr.slice(0, cmdStr.length - " & exit 0".length);
    expect(body.replace(/\^&/g, "")).not.toMatch(/&/);
  });
});
