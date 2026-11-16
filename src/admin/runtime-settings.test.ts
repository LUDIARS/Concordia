import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_MAIN_PUSH_ALLOWLIST, MAIN_PUSH_ALLOWLIST_ENV } from "../harness/main-push-allowlist.js";
import { RuntimeSettingsStore } from "./runtime-settings.js";
import type { SettingsStore } from "./settings-store.js";

/** in-memory な SettingsStore (DB 不要 — 解決順だけを検証する)。 */
function makeStore(): SettingsStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    transaction: (update) => update(),
    getBoolean: (key, fallback) => (map.has(key) ? map.get(key) === "1" : fallback),
    setBoolean: (key, value) => { map.set(key, value ? "1" : "0"); },
  };
}

describe("RuntimeSettingsStore.getHarnessMainPushAllowlist", () => {
  const original = process.env[MAIN_PUSH_ALLOWLIST_ENV];
  let store: SettingsStore;
  let settings: RuntimeSettingsStore;

  beforeEach(() => {
    delete process.env[MAIN_PUSH_ALLOWLIST_ENV];
    store = makeStore();
    settings = new RuntimeSettingsStore(store);
  });
  afterEach(() => {
    if (original === undefined) delete process.env[MAIN_PUSH_ALLOWLIST_ENV];
    else process.env[MAIN_PUSH_ALLOWLIST_ENV] = original;
  });

  it("未設定なら既定シード (PartnerOrg ローカルクローン)", () => {
    expect(settings.getHarnessMainPushAllowlist()).toEqual([...DEFAULT_MAIN_PUSH_ALLOWLIST]);
  });

  it("env を既定より優先する", () => {
    process.env[MAIN_PUSH_ALLOWLIST_ENV] = "Foo, Bar";
    expect(settings.getHarnessMainPushAllowlist()).toEqual(["Foo", "Bar"]);
  });

  it("設定値を env より優先する", () => {
    process.env[MAIN_PUSH_ALLOWLIST_ENV] = "Foo";
    store.set("harness.main_push_allowlist", JSON.stringify([" Baz "]));
    expect(settings.getHarnessMainPushAllowlist()).toEqual(["Baz"]);
  });

  it("空配列の保存は「例外なし」の明示指定として尊重する", () => {
    process.env[MAIN_PUSH_ALLOWLIST_ENV] = "Foo";
    store.set("harness.main_push_allowlist", "[]");
    expect(settings.getHarnessMainPushAllowlist()).toEqual([]);
  });

  it("明示設定が壊れていたら env / 既定へ戻さず fail-closed にする", () => {
    process.env[MAIN_PUSH_ALLOWLIST_ENV] = "Foo";
    store.set("harness.main_push_allowlist", "not-json");
    expect(settings.getHarnessMainPushAllowlist()).toEqual([]);

    store.set("harness.main_push_allowlist", JSON.stringify({ repo: "Foo" }));
    expect(settings.getHarnessMainPushAllowlist()).toEqual([]);
  });
});

describe("RuntimeSettingsStore.getControlSessionEnabled", () => {
  it("未設定なら OFF (人間の決定待ち)、WebUI で保存した値を優先する (spec/feature/control-session.md §6)", () => {
    const store = makeStore();
    const settings = new RuntimeSettingsStore(store);
    expect(settings.getControlSessionEnabled()).toBe(false);
    store.setBoolean("admin.control_session_enabled", true);
    expect(settings.getControlSessionEnabled()).toBe(true);
    store.set("admin.control_session_enabled", "0");
    expect(settings.getControlSessionEnabled()).toBe(false);
  });
});

describe("RuntimeSettingsStore.getControlSessionReaperEnabled", () => {
  it("未設定なら ON、WebUI で保存した値を優先する (spec/feature/control-session.md §9)", () => {
    const store = makeStore();
    const settings = new RuntimeSettingsStore(store);
    expect(settings.getControlSessionReaperEnabled()).toBe(true);
    store.set("admin.control_session_reaper_enabled", "0");
    expect(settings.getControlSessionReaperEnabled()).toBe(false);
    store.setBoolean("admin.control_session_reaper_enabled", true);
    expect(settings.getControlSessionReaperEnabled()).toBe(true);
  });
});

describe("RuntimeSettingsStore.getLanguageGuardEnabled", () => {
  it("未設定なら ON、WebUI で保存した値を優先する", () => {
    const store = makeStore();
    const settings = new RuntimeSettingsStore(store);
    expect(settings.getLanguageGuardEnabled()).toBe(true);
    store.setBoolean("admin.language_guard_enabled", false);
    expect(settings.getLanguageGuardEnabled()).toBe(false);
    store.set("admin.language_guard_enabled", "true");
    expect(settings.getLanguageGuardEnabled()).toBe(true);
  });
});
