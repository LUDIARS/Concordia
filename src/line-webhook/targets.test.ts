import { describe, expect, it } from "vitest";
import {
  channelServices,
  listLineChannels,
  normalizeKeywords,
  parseLineWebhookTargets,
  readLineWebhookTargets,
  replaceTargetKeywords,
  validateLineWebhookTargetEntries,
} from "./targets.js";

const mf = JSON.stringify({ name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", host: "mf-hook.example.test", enabled: true });
const off = JSON.stringify({ name: "off", url: "https://off.example.test/hook", enabled: false });
const sharedMf = JSON.stringify({ name: "mf", url: "http://192.0.2.10/hook", enabled: true, channel: "ludiars", keywords: ["おてつだい"] });
const sharedMm = JSON.stringify({ name: "mm", url: "http://192.0.2.11/hook", enabled: true, channel: "ludiars", keywords: [" メモリア "] });
const sharedOff = JSON.stringify({ name: "old", url: "http://192.0.2.12/hook", enabled: false, channel: "ludiars" });

describe("parseLineWebhookTargets", () => {
  it("channel の無い既存行は name をチャネル名とみなし、呼びかけの言葉は無し", () => {
    expect(parseLineWebhookTargets([mf, off])).toEqual({
      targets: [
        { name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", host: "mf-hook.example.test", enabled: true, channel: "mf", keywords: [] },
        { name: "off", url: "https://off.example.test/hook", host: null, enabled: false, channel: "off", keywords: [] },
      ],
      errors: [],
    });
  });

  it("channel と keywords を読み、言葉の前後の空白は落とす", () => {
    const { targets, errors } = parseLineWebhookTargets([sharedMf, sharedMm]);
    expect(errors).toEqual([]);
    expect(targets.map(({ name, channel, keywords }) => ({ name, channel, keywords }))).toEqual([
      { name: "mf", channel: "ludiars", keywords: ["おてつだい"] },
      { name: "mm", channel: "ludiars", keywords: ["メモリア"] },
    ]);
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
    ["channel に記号", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", enabled: true, channel: "Shared!" })],
    ["keywords が文字列", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", enabled: true, keywords: "おてつだい" })],
    ["keywords に空", JSON.stringify({ name: "mf", url: "http://192.0.2.10/", enabled: true, keywords: [" "] })],
  ])("壊れた項目 (%s) は登録に入れず理由を返す", (_label, entry) => {
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

describe("channelServices", () => {
  const { targets } = parseLineWebhookTargets([sharedMf, mf.replace('"mf"', '"solo"'), sharedOff, sharedMm]);

  it("そのチャネルの enabled のサービスだけを設定順に返す", () => {
    expect(channelServices(targets, "ludiars").map((target) => target.name)).toEqual(["mf", "mm"]);
    expect(channelServices(targets, "solo").map((target) => target.name)).toEqual(["solo"]);
  });

  it("未登録・名前形式違反は空", () => {
    expect(channelServices(targets, "unknown")).toEqual([]);
    expect(channelServices(targets, "ludiars/extra")).toEqual([]);
    expect(channelServices(targets, "")).toEqual([]);
  });

  it("チャネル名の一覧は enabled を問わず初出順", () => {
    expect(listLineChannels(targets)).toEqual(["ludiars", "solo"]);
  });
});

describe("呼びかけの言葉", () => {
  it("normalizeKeywords は前後の空白を落とし、壊れていれば理由を返す", () => {
    expect(normalizeKeywords([" おてつだい ", "ごほうび"])).toEqual(["おてつだい", "ごほうび"]);
    expect(normalizeKeywords([])).toEqual([]);
    expect(normalizeKeywords("おてつだい")).toMatch(/配列/);
    expect(normalizeKeywords(["a", "a"])).toMatch(/重複/);
    expect(normalizeKeywords(["x".repeat(33)])).toMatch(/文字/);
    expect(normalizeKeywords(Array.from({ length: 21 }, (_, index) => `w${index}`))).toMatch(/個まで/);
  });

  it("replaceTargetKeywords は該当サービスの行の keywords だけを書き換える", () => {
    const raw = JSON.stringify([mf, sharedMm]);
    const next = replaceTargetKeywords(raw, "mf", ["おてつだい"])!;
    expect(next[1]).toBe(sharedMm);
    expect(JSON.parse(next[0]!)).toEqual({ ...JSON.parse(mf), keywords: ["おてつだい"] });
    expect(validateLineWebhookTargetEntries(next)).toBeNull();
    expect(replaceTargetKeywords(raw, "unknown", [])).toBeNull();
    expect(replaceTargetKeywords("not json", "mf", [])).toBeNull();
  });
});

describe("設定値の読み書き", () => {
  it("PUT の検証は 1 件でも壊れていれば理由を返す", () => {
    expect(validateLineWebhookTargetEntries([mf, off])).toBeNull();
    expect(validateLineWebhookTargetEntries([mf, "{"])).toMatch(/2 件目/);
  });

  it("schema_meta の JSON 配列からサービスを読み、壊れていればサービスなし", () => {
    expect(readLineWebhookTargets(JSON.stringify([mf])).map((target) => target.name)).toEqual(["mf"]);
    expect(readLineWebhookTargets(null)).toEqual([]);
    expect(readLineWebhookTargets("not json")).toEqual([]);
    expect(readLineWebhookTargets(JSON.stringify({ mf }))).toEqual([]);
  });
});
