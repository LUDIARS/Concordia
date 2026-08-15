import { describe, expect, it } from "vitest";
import type { SettingsStore } from "../admin/settings-store.js";
import { WORKFLOW_KEYS, workflowEnvName, workflowSettingKey } from "./keys.js";
import { WorkflowToggles } from "./toggles.js";

function makeStore(initial: Record<string, string> = {}): SettingsStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
    delete: (key) => { values.delete(key); },
    transaction: (update) => update(),
    getBoolean: (key, fallback) => {
      const raw = values.get(key);
      return raw === undefined ? fallback : raw === "1" || raw === "true";
    },
    setBoolean: (key, value) => { values.set(key, value ? "1" : "0"); },
  };
}

describe("WorkflowToggles 既定値", () => {
  it("DB も env も無ければ全ワークフローが有効 (既存環境の挙動を変えない)", () => {
    const toggles = new WorkflowToggles({ store: makeStore(), env: {} });
    for (const key of WORKFLOW_KEYS) {
      expect(toggles.isEnabled(key), `workflow.${key}`).toBe(true);
      expect(toggles.state(key).source).toBe("default");
    }
    expect(toggles.isSessionControlOnly()).toBe(false);
  });
});

describe("WorkflowToggles 解決順", () => {
  it("env でフォールバック無効化できる", () => {
    const toggles = new WorkflowToggles({
      store: makeStore(),
      env: { [workflowEnvName("task")]: "0" },
    });
    expect(toggles.state("task")).toEqual({ enabled: false, source: "env" });
    expect(toggles.isEnabled("test")).toBe(true);
  });

  it("DB は env より優先される", () => {
    const toggles = new WorkflowToggles({
      store: makeStore({ [workflowSettingKey("task")]: "1" }),
      env: { [workflowEnvName("task")]: "0" },
    });
    expect(toggles.state("task")).toEqual({ enabled: true, source: "db" });
  });

  it("解釈できない値は警告して次の解決元へ進む (無言フォールバックしない)", () => {
    const warnings: string[] = [];
    const toggles = new WorkflowToggles({
      store: makeStore({ [workflowSettingKey("cost")]: "maybe" }),
      env: { [workflowEnvName("cost")]: "0" },
      log: { warn: (message) => warnings.push(message) },
    });
    expect(toggles.state("cost")).toEqual({ enabled: false, source: "env" });
    expect(warnings.join("\n")).toContain(workflowSettingKey("cost"));
  });
});

describe("WorkflowToggles 都度解決", () => {
  it("resolver は保持したあとの設定変更を次の呼び出しで反映する (再起動不要)", () => {
    const store = makeStore();
    const toggles = new WorkflowToggles({ store, env: {} });
    const isTaskEnabled = toggles.resolver("task");

    expect(isTaskEnabled()).toBe(true);
    toggles.setEnabled("task", false);
    expect(isTaskEnabled()).toBe(false);
    toggles.setEnabled("task", true);
    expect(isTaskEnabled()).toBe(true);
  });

  it("全て無効にするとセッションコントロールのみ構成になる", () => {
    const toggles = new WorkflowToggles({ store: makeStore(), env: {} });
    for (const key of WORKFLOW_KEYS) toggles.setEnabled(key, false);
    expect(toggles.isSessionControlOnly()).toBe(true);
  });
});

describe("morning ワークフロー", () => {
  it("daily を無効にしても morning は独立して有効なまま (cron と朝タスクを別々に切れる)", () => {
    const toggles = new WorkflowToggles({ store: makeStore(), env: {} });
    toggles.setEnabled("daily", false);

    expect(toggles.isEnabled("daily")).toBe(false);
    expect(toggles.isEnabled("morning")).toBe(true);
  });

  it("morning だけ無効にしても daily の cron は動いたまま", () => {
    const toggles = new WorkflowToggles({ store: makeStore(), env: {} });
    toggles.setEnabled("morning", false);

    expect(toggles.isEnabled("morning")).toBe(false);
    expect(toggles.isEnabled("daily")).toBe(true);
  });

  it("env でも morning を切れる", () => {
    const toggles = new WorkflowToggles({
      store: makeStore(),
      env: { [workflowEnvName("morning")]: "0" },
    });
    expect(toggles.state("morning")).toEqual({ enabled: false, source: "env" });
  });
});
