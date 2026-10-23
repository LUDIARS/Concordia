import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { siteCategoryDefaultsRouter } from "./delegation-site-category-defaults.js";

function harness() {
  const repo = new DelegationRepo(makeTestDb());
  const onTemplateChanged = vi.fn();
  const app = siteCategoryDefaultsRouter({ repo, onTemplateChanged });
  const mail = repo.createTemplate({ call_name: "mail-watch", title: "メール監視", target_provider: "claude", prompt_template: "p", category: "parttimer" });
  const status = repo.createTemplate({ call_name: "status-daily", title: "日次ステータス", target_provider: "claude", prompt_template: "p", category: "parttimer" });
  repo.createTemplate({ call_name: "impl", title: "実装", target_provider: "codex", prompt_template: "p", category: "employee" });
  const put = (path: string, body: unknown) => app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async () => (await (await app.request("/melpot/parttimer")).json()) as {
    default_active: boolean; default_configured: boolean;
    templates: Array<{ call_name: string; exception: boolean | null; effective_active: boolean }>;
  };
  return { repo, mail, status, put, read, onTemplateChanged };
}

describe("site category defaults API (SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS)", () => {
  it("拠点のパートタイマーは組み込み既定でオフ。一覧は parttimer だけ", async () => {
    const { read } = harness();
    const state = await read();
    expect(state).toMatchObject({ default_active: false, default_configured: false });
    expect(state.templates.map((t) => [t.call_name, t.effective_active])).toEqual([["mail-watch", false], ["status-daily", false]]);
  });

  it("気に入ったものだけオンにでき、既定に戻すと例外が外れる", async () => {
    const { put, read, repo, mail, onTemplateChanged } = harness();
    expect((await put(`/melpot/parttimer/templates/${mail.id}`, { enabled: true })).status).toBe(200);
    let state = await read();
    expect(state.templates.find((t) => t.call_name === "mail-watch")).toMatchObject({ exception: true, effective_active: true });
    expect(state.templates.find((t) => t.call_name === "status-daily")).toMatchObject({ exception: null, effective_active: false });
    expect(onTemplateChanged).toHaveBeenCalled();

    expect((await put(`/melpot/parttimer/templates/mail-watch`, { enabled: null })).status).toBe(200);
    state = await read();
    expect(state.templates.find((t) => t.call_name === "mail-watch")).toMatchObject({ exception: null, effective_active: false });
    expect(repo.listTemplateOverrides(mail.id)).toEqual([]);
  });

  it("例外を外しても site override の他の patch キーは残す", async () => {
    const { put, repo, status } = harness();
    repo.upsertTemplateOverride({ template_id: status.id, scope_kind: "site", scope_key: "melpot", patch_json: JSON.stringify({ model: "m" }) });
    await put(`/melpot/parttimer/templates/${status.id}`, { enabled: true });
    expect(JSON.parse(repo.listTemplateOverrides(status.id)[0]!.patch_json)).toEqual({ model: "m", is_active: 1 });
    await put(`/melpot/parttimer/templates/${status.id}`, { enabled: null });
    expect(JSON.parse(repo.listTemplateOverrides(status.id)[0]!.patch_json)).toEqual({ model: "m" });
  });

  it("拠点の既定をオンにすると例外の無いものが動き、null で組み込み既定へ戻る", async () => {
    const { put, read, mail } = harness();
    await put(`/melpot/parttimer/templates/${mail.id}`, { enabled: false });
    expect((await put("/melpot/parttimer", { is_active: true })).status).toBe(200);
    let state = await read();
    expect(state).toMatchObject({ default_active: true, default_configured: true });
    expect(state.templates.map((t) => [t.call_name, t.effective_active])).toEqual([["mail-watch", false], ["status-daily", true]]);
    await put("/melpot/parttimer", { is_active: null });
    state = await read();
    expect(state).toMatchObject({ default_active: false, default_configured: false });
  });

  it("不正な拠点 ID・category・本文は 400、未知テンプレは 404", async () => {
    const { put } = harness();
    expect((await put("/Bad_Site/parttimer", { is_active: true })).status).toBe(400);
    expect((await put("/melpot/unknown", { is_active: true })).status).toBe(400);
    expect((await put("/melpot/parttimer", { is_active: "yes" })).status).toBe(400);
    expect((await put("/melpot/parttimer/templates/nope", { enabled: true })).status).toBe(404);
  });
});
