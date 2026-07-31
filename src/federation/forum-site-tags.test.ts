/**
 * 拠点タグの「候補に出る条件」と Villa 停止時の degrade を固定するテスト。
 *
 * 純関数側 (forum-site-routing.test.ts) では出せない性質 —
 * Villa への実 fetch と拠点レジストリの突き合わせ — をここで押さえる。
 */

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeFederationSitesRepo } from "../db/federation-sites-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import { createFederationRuntime } from "./runtime.js";
import { VillaClient } from "../villa/client.js";
import type { FederationEnv } from "./env.js";

const secretBox = new SecretBox(Buffer.alloc(32, 9));

// 連合ロールは起動しない (このテストはタグ候補の解決だけを見る)。
const env: FederationEnv = {
  listenEnabled: false,
  listenHost: "127.0.0.1",
  listenPort: null,
  hqUrl: null,
  siteId: null,
  siteToken: null,
  outboxMaxRows: 100,
  outboxTtlSec: 3600,
};

function villaClientReturning(pcs: unknown): VillaClient {
  return new VillaClient({
    fetchImpl: (async () => new Response(JSON.stringify({ state: { pcs } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });
}

describe("federation forum site tag candidates", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it("villa_pc_id 未設定の拠点はタグ候補に出ない", async () => {
    const sites = makeFederationSitesRepo(db, secretBox);
    sites.create({ siteId: "site-a" });
    sites.create({ siteId: "site-b" });
    sites.setVillaPcId("site-a", "pc-haster");

    const runtime = createFederationRuntime({
      db,
      secretBox,
      version: "test",
      env,
      villaClient: villaClientReturning([
        { id: "pc-haster", name: "HASTER" },
        { id: "pc-yidhra", name: "YIDHRA" },
      ]),
    });
    // 対応づけの無い site-b の PC (YIDHRA) は候補に含めない。
    expect(await runtime.listForumSiteTagNames()).toEqual(["HASTER"]);
  });

  it("失効した拠点はタグ候補に出ない", async () => {
    const sites = makeFederationSitesRepo(db, secretBox);
    sites.create({ siteId: "site-a" });
    sites.setVillaPcId("site-a", "pc-haster");
    sites.revoke("site-a");

    const runtime = createFederationRuntime({
      db,
      secretBox,
      version: "test",
      env,
      villaClient: villaClientReturning([{ id: "pc-haster", name: "HASTER" }]),
    });
    expect(await runtime.listForumSiteTagNames()).toEqual([]);
  });

  it("Villa 停止時はタグ候補が空になり、ルーティングは guild 側だけで動く", async () => {
    const sites = makeFederationSitesRepo(db, secretBox);
    sites.create({ siteId: "site-a" });
    sites.setVillaPcId("site-a", "pc-haster");
    sites.setDepartments("site-a", ["guild-a"]);

    const runtime = createFederationRuntime({
      db,
      secretBox,
      version: "test",
      env,
      villaClient: new VillaClient({
        fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
      }),
    });

    // 例外を投げず空で degrade すること (Concordia 本体を巻き込まない)。
    await expect(runtime.listForumSiteTagNames()).resolves.toEqual([]);
    // 拠点タグが解決できなくても ingress の判定自体は例外にならない。
    expect(() => runtime.routeIngress({
      guild_id: "guild-a",
      channel_id: "c",
      message_id: "m",
      author_id: "a",
      author_label: "a",
      text: "t",
      ts: 0,
      applied_tag_names: ["HASTER"],
    })).not.toThrow();
  });
});
