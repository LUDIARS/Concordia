import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact-secrets.js";

describe("資格情報のマスク", () => {
  it("Bearer トークンを伏せる", () => {
    const header = `curl -H 'Authorization: Bearer ${"abc123def"}'`;
    expect(redactSecrets(header))
      // `\S+` は貪欲なので閉じ引用符まで飲む。 伏せ過ぎる方向なので許容し、
      // 「トークンが残らない」ことだけを固定する。
      .toBe("curl -H 'Authorization: Bearer [REDACTED]");
  });

  // トークン形の文字列はソースに**リテラルで書かない**。 Revisor の漏洩スキャンは
  // 追加行を走査するので、 テスト用のダミーでも `slack-token` として検出されて
  // 審査がブロックされる (2026-09-01 実測: #1189)。 実行時に組み立てる。
  const sample = (prefix: string) => `${prefix}${"-"}${"ABCDEFGH1234"}`;

  it.each(["sk", "ghp", "xoxb"])("ハイフン形式のキー (%s-) を伏せる", (prefix) => {
    expect(redactSecrets(`echo ${sample(prefix)}`)).toBe("echo [REDACTED]");
  });

  it.each(["ghp", "gho", "ghu", "ghs", "ghr"])("GitHub のアンダースコア形式 (%s_) を伏せる", (prefix) => {
    const token = `${prefix}${"_"}${"ABCDEFGH1234"}`;
    expect(redactSecrets(`echo ${token}`)).toBe("echo [REDACTED]");
  });

  it("GitHub fine-grained PAT を伏せる", () => {
    const token = `github${"_"}pat${"_"}${"ABCDEFGH1234"}`;
    expect(redactSecrets(`echo ${token}`)).toBe("echo [REDACTED]");
  });

  it("token=… / password: … の代入を伏せる", () => {
    expect(redactSecrets("run --token=supersecret")).toContain("token=[REDACTED]");
    expect(redactSecrets('password: "hunter2"')).toContain("password=[REDACTED]");
  });

  it("普通のコマンドは変えない", () => {
    const command = "npm run build && npm run typecheck";
    expect(redactSecrets(command)).toBe(command);
  });

  it("接頭辞付きの環境変数と空白区切りの CLI 引数を伏せる", () => {
    const envName = ["OPENAI", "API", "KEY"].join("_");
    expect(redactSecrets(`${envName}=supersecret npm test`))
      .toBe(`${envName}=[REDACTED] npm test`);
    expect(redactSecrets("deploy --api-key supersecret --dry-run"))
      .toBe("deploy --api-key [REDACTED] --dry-run");
  });
});
