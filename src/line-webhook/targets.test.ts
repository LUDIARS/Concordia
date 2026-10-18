import { describe, expect, it } from "vitest";
import {
  parseLineWebhookTargets,
  readLineWebhookTargets,
  resolveLineWebhookTarget,
  validateLineWebhookTargetEntries,
} from "./targets.js";

const mf = JSON.stringify({ name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", host: "mf-hook.example.test", enabled: true });
const off = JSON.stringify({ name: "off", url: "https://off.example.test/hook", enabled: false });

describe("parseLineWebhookTargets", () => {
  it("正しい項目を転送先として読む (host は任意)", () => {
    expect(parseLineWebhookTargets([mf, off])).toEqual({
      targets: [
        { name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", host: "mf-hook.example.test", enabled: true },
        { name: "off", url: "https://off.example.test/hook", host: null, enabled: false },
      ],
      errors: [],
    });
  });

  it.each([
    ["JSON でない", "mf http://192.0.2.10/"],
    ["名前に大文字", JSON.stringify({ name: "Mf", url: "http://192.0.2.10/", enabled: true })],
    ["名前に記号", JSON.stringify({ name: "m_f", url: "http://192.0.2.10/", enabled: true })],
    ["http/https 以外", JSON.stringify({ name: "mf", url: "ftp://192.0.2.10/", enabled: true })],
    ["資格情報入り URL", JSON.stringify({ name: "mf", url: "http://u:p@192.0.2.10/", enabled: true })],
    ["host にパス", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", host: "a.example.test/x", enabled: true })],
    ["enabled 欠落", JSON.stringify({ name: "mf", url: "http://192.0.2.10/" })],
    ["未知のキー", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", enabled: true, secret: "x" })],
  ])("壊れた項目 (%s) は転送先に入れず理由を返す", (_label, entry) => {
    const result = parseLineWebhookTargets([entry]);
    expect(result.targets).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^1 件目: /);
  });

  it("重複した名前は後の方を捨てる", () => {
    const result = parseLineWebhookTargets([mf, mf]);
    expect(result.targets.map((target) => target.name)).toEqual(["mf"]);
    expect(result.errors).toEqual([expect.stringContaining("重複")]);
  });
});

describe("resolveLineWebhookTarget", () => {
  const { targets } = parseLineWebhookTargets([mf, off]);

  it("登録済みで有効な転送先を返す", () => {
    expect(resolveLineWebhookTarget(targets, "mf")?.url).toBe("http://192.0.2.10:8080/integrations/line/webhook");
  });

  it("未登録・無効・名前形式違反は null", () => {
    expect(resolveLineWebhookTarget(targets, "unknown")).toBeNull();
    expect(resolveLineWebhookTarget(targets, "off")).toBeNull();
    expect(resolveLineWebhookTarget(targets, "mf/extra")).toBeNull();
    expect(resolveLineWebhookTarget(targets, "")).toBeNull();
  });
});

describe("設定値の読み書き", () => {
  it("PUT の検証は 1 件でも壊れていれば理由を返す", () => {
    expect(validateLineWebhookTargetEntries([mf, off])).toBeNull();
    expect(validateLineWebhookTargetEntries([mf, "{"])).toMatch(/2 件目/);
  });

  it("schema_meta の JSON 配列から転送先を読み、壊れていれば転送先なし", () => {
    expect(readLineWebhookTargets(JSON.stringify([mf])).map((target) => target.name)).toEqual(["mf"]);
    expect(readLineWebhookTargets(null)).toEqual([]);
    expect(readLineWebhookTargets("not json")).toEqual([]);
    expect(readLineWebhookTargets(JSON.stringify({ mf }))).toEqual([]);
  });
});
