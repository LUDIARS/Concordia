import { describe, expect, it } from "vitest";
import type { SettingsStore } from "../admin/settings-store.js";
import { readFederationEnv, type FederationEnv } from "./env.js";
import {
  listenerNeedsRestart,
  resolveFederationListener,
  resolveFederationSite,
  resolveFederationSiteId,
  siteClientNeedsRestart,
  updateFederationListener,
  updateFederationSite,
} from "./listener-settings.js";

function store(seed: Record<string, string> = {}): SettingsStore {
  const map = new Map(Object.entries(seed));
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    transaction: (update) => update(),
    getBoolean: (key, fallback) => {
      const raw = map.get(key);
      return raw === undefined ? fallback : raw === "1" || raw === "true";
    },
    setBoolean: (key, value) => { map.set(key, value ? "1" : "0"); },
  };
}

const env = (overrides: Partial<FederationEnv> = {}): FederationEnv => ({
  listenEnabled: false,
  listenHost: "127.0.0.1",
  listenPort: null,
  hqUrl: null,
  siteId: null,
  siteToken: null,
  outboxMaxRows: 10,
  outboxTtlSec: 10,
  ...overrides,
});

/** テスト用の可逆な擬似暗号 (実体は SecretBox)。 */
const cipher = {
  encrypt: (value: string) => `enc(${value})`,
  decrypt: (value: string) => {
    const match = /^enc\((.*)\)$/.exec(value);
    if (!match) throw new Error("not encrypted");
    return match[1]!;
  },
};

describe("resolveFederationListener", () => {
  it("DB を最優先し、無ければ env、無ければ既定に落ちる", () => {
    expect(resolveFederationListener(store(), env())).toMatchObject({
      enabled: false, port: null, host: "127.0.0.1",
      source: { enabled: "default", port: "default", host: "default" },
    });
    expect(resolveFederationListener(store(), env({ listenEnabled: true, listenPort: 1, listenHost: "0.0.0.0" })))
      .toMatchObject({ enabled: true, port: 1, host: "0.0.0.0", source: { enabled: "env", port: "env", host: "env" } });
    const db = store({
      "admin.federation.listen.enabled": "1",
      "admin.federation.listen.port": "11112",
      "admin.federation.listen.host": "0.0.0.0",
    });
    expect(resolveFederationListener(db, env({ listenEnabled: false, listenPort: 1 })))
      .toMatchObject({ enabled: true, port: 11112, host: "0.0.0.0", source: { enabled: "db", port: "db", host: "db" } });
  });

  it("DB 解決を行う場合だけ env 単独の port 必須判定を遅らせられる", () => {
    const input = { CONCORDIA_FEDERATION_LISTEN: "1" };
    expect(() => readFederationEnv(input)).toThrow(/requires CONCORDIA_FEDERATION_LISTEN_PORT/);
    const deferred = readFederationEnv(input, { deferListenerPortValidation: true });
    expect(resolveFederationListener(
      store({ "admin.federation.listen.port": "11112" }),
      deferred,
    )).toMatchObject({ enabled: true, port: 11112 });
  });
});

describe("updateFederationListener", () => {
  it("ポートの無い有効化を拒否する (既定ポートを作らない)", () => {
    expect(updateFederationListener(store(), env(), { enabled: true }))
      .toEqual({ ok: false, error: "enabling the federation listener requires a port" });
  });

  it("同じ更新でポートも渡せば通り、以後 DB 由来になる", () => {
    const db = store();
    const result = updateFederationListener(db, env(), { enabled: true, port: 11112, host: "0.0.0.0" });
    expect(result.ok).toBe(true);
    expect(resolveFederationListener(db, env())).toMatchObject({ enabled: true, port: 11112, host: "0.0.0.0" });
  });

  it("範囲外ポートを弾く", () => {
    expect(updateFederationListener(store(), env(), { port: 70000 }).ok).toBe(false);
  });

  it("null は DB 上書きを削除して env 設定へ戻す", () => {
    const db = store({
      "admin.federation.listen.port": "11112",
      "admin.federation.listen.host": "0.0.0.0",
    });
    expect(updateFederationListener(
      db,
      env({ listenPort: 22222, listenHost: "127.0.0.2" }),
      { port: null, host: null },
    ).ok).toBe(true);
    expect(resolveFederationListener(db, env({ listenPort: 22222, listenHost: "127.0.0.2" })))
      .toMatchObject({ port: 22222, host: "127.0.0.2", source: { port: "env", host: "env" } });
  });
});

describe("listenerNeedsRestart", () => {
  const desired = (port: number | null, enabled = true) => ({
    enabled, port, host: "0.0.0.0",
    source: { enabled: "db", port: "db", host: "db" },
  } as const);

  it("起動・停止・張り替え・無変化を区別する", () => {
    expect(listenerNeedsRestart(null, desired(11112))).toBe("start");
    expect(listenerNeedsRestart({ host: "0.0.0.0", port: 11112 }, desired(11112))).toBe("none");
    expect(listenerNeedsRestart({ host: "0.0.0.0", port: 11112 }, desired(11113))).toBe("restart");
    expect(listenerNeedsRestart({ host: "0.0.0.0", port: 11112 }, desired(11112, false))).toBe("stop");
    // 有効でもポートが無ければ待ち受けない。
    expect(listenerNeedsRestart(null, desired(null))).toBe("none");
  });
});

describe("拠点ロール設定", () => {
  it("site ID は DB を優先し、未設定なら env に戻る", () => {
    expect(resolveFederationSiteId(
      store({ "admin.federation.site.site_id": "db-site" }),
      env({ siteId: "env-site" }),
    )).toBe("db-site");
    expect(resolveFederationSiteId(store(), env({ siteId: "env-site" }))).toBe("env-site");
  });

  it("トークンは暗号化して保存し、平文を返さない", () => {
    const db = store();
    expect(updateFederationSite(db, cipher, { hq_url: "ws://hq:1", site_id: "yidhra", token: "t0ken" }).ok).toBe(true);
    expect(db.get("admin.federation.site.token_enc")).toBe("enc(t0ken)");
    const resolved = resolveFederationSite(db, env(), cipher);
    expect(resolved).toMatchObject({ hqUrl: "ws://hq:1", siteId: "yidhra", hasToken: true });
    expect(resolved.token).toBe("t0ken");
  });

  it("ws/wss 以外の hq_url を弾く", () => {
    expect(updateFederationSite(store(), cipher, { hq_url: "http://hq" }).ok).toBe(false);
  });

  it("復号できないトークンの env フォールバックを呼び元へ表面化する", () => {
    const db = store({ "admin.federation.site.token_enc": "broken" });
    expect(resolveFederationSite(db, env({ siteToken: "from-env" }), cipher)).toMatchObject({
      hasToken: true, tokenDecryptionFailed: true, source: { token: "env" },
    });
  });

  it("資格情報入り URL と不正な site_id を保存しない", () => {
    expect(updateFederationSite(store(), cipher, { hq_url: "wss://user:pass@hq.example" }).ok).toBe(false);
    expect(updateFederationSite(store(), cipher, { site_id: "INVALID" }).ok).toBe(false);
  });

  it("null は暗号文を空文字で残さず DB 上書きを削除する", () => {
    const db = store({ "admin.federation.site.token_enc": "enc(old)" });
    expect(updateFederationSite(db, cipher, { token: null }).ok).toBe(true);
    expect(db.get("admin.federation.site.token_enc")).toBeNull();
    expect(resolveFederationSite(db, env({ siteToken: "from-env" }), cipher)).toMatchObject({
      token: "from-env", source: { token: "env" },
    });
  });

  it("3 値揃うまで起動しない", () => {
    expect(siteClientNeedsRestart(null, { hqUrl: "ws://hq:1", siteId: "s", token: null })).toBe("none");
    expect(siteClientNeedsRestart(null, { hqUrl: "ws://hq:1", siteId: "s", token: "t" })).toBe("start");
    const running = { hqUrl: "ws://hq:1", siteId: "s", token: "t" };
    expect(siteClientNeedsRestart(running, running)).toBe("none");
    expect(siteClientNeedsRestart(running, { ...running, token: "t2" })).toBe("restart");
    expect(siteClientNeedsRestart(running, { hqUrl: null, siteId: null, token: null })).toBe("stop");
  });
});
