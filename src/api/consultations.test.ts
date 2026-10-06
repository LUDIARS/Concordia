import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PublicationService } from "../consultation/publication-service.js";
import { ConsultationPublicationsRepo } from "../db/consultation-publications-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { consultationsRouter } from "./consultations.js";

function makeApp(options: { tabula?: boolean } = {}) {
  const db = makeTestDb();
  const consultations = new PrivateConsultationsRepo(db);
  const consultation = consultations.create({
    subsidiary_id: null, department_id: "dept_qa", requester_user_id: "11111", status: "pending_approval", intake_json: "{}",
  });
  consultations.markOpen(consultation.id, "11111");
  consultations.setChannel(consultation.id, "22222");
  consultations.setSession(consultation.id, "sess-1");
  const events: ConcordiaEvent[] = [];
  const importPage = vi.fn(async () => ({ pageId: "page-1", url: "https://tabula/#page=page-1" }));
  const publications = new PublicationService({
    publications: new ConsultationPublicationsRepo(db),
    consultations,
    departmentName: () => "技術相談課",
    tabulaConnection: () => (options.tabula === false ? null : { url: "http://tabula", token: "t" }),
    importPage,
  });
  const app = new Hono().route("/v1/consultations", consultationsRouter({
    publications, emit: (event) => { events.push(event); }, now: () => 5_000,
  }));
  return { app, events, importPage };
}

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("consultationsRouter", () => {
  it("accepts a proposal from the session and announces it to the consultation channel", async () => {
    const { app, events } = makeApp();
    const res = await app.request("/v1/consultations/proposals", post({ session_id: "sess-1", title: "集約の切り方", summary: "要約" }));
    expect(res.status).toBe(201);
    const body = await res.json() as { publication_id: string; tabula_ready: boolean };
    expect(body.tabula_ready).toBe(true);
    expect(events).toEqual([expect.objectContaining({
      type: "consultation.proposed", publication_id: body.publication_id, channel_id: "22222", tabula_ready: true, ts: 5,
    })]);
  });

  it("maps the decision errors and publishes for the requester", async () => {
    const { app, importPage } = makeApp();
    const { publication_id: id } = await (await app.request("/v1/consultations/proposals",
      post({ session_id: "sess-1", title: "集約の切り方", summary: "要約" }))).json() as { publication_id: string };

    expect((await app.request(`/v1/consultations/publications/${id}/publish`, post({ actor_user_id: "99999" }))).status).toBe(403);
    expect((await app.request(`/v1/consultations/publications/${id}/publish`, post({ actor_user_id: "not-a-snowflake" }))).status).toBe(400);
    const published = await app.request(`/v1/consultations/publications/${id}/publish`,
      post({ actor_user_id: "11111", edited_summary: "直した要約" }));
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ publication: { status: "published", tabula_url: "https://tabula/#page=page-1" } });
    expect(importPage).toHaveBeenCalledTimes(1);
    expect((await app.request(`/v1/consultations/publications/${id}/decline`, post({ actor_user_id: "11111" }))).status).toBe(409);
  });

  it("reports an unconfigured Tabula instead of pretending to publish", async () => {
    const { app } = makeApp({ tabula: false });
    const { publication_id: id, tabula_ready } = await (await app.request("/v1/consultations/proposals",
      post({ session_id: "sess-1", title: "t", summary: "s" }))).json() as { publication_id: string; tabula_ready: boolean };
    expect(tabula_ready).toBe(false);
    expect((await app.request(`/v1/consultations/publications/${id}/publish`, post({ actor_user_id: "11111" }))).status).toBe(503);
  });

  it("rejects proposals from sessions without a consultation", async () => {
    const { app } = makeApp();
    expect((await app.request("/v1/consultations/proposals", post({ session_id: "other", title: "t", summary: "s" }))).status).toBe(404);
  });
});

describe("consultationsRouter restore-channel (2026-10-06 neco 指示)", () => {
  it("accepts a restore only for a deleted channel and asks the company's bot to rebuild it", async () => {
    const db = makeTestDb();
    const consultations = new PrivateConsultationsRepo(db);
    const consultation = consultations.create({
      subsidiary_id: "sub-1", department_id: "dept_qa", requester_user_id: "11111", status: "pending_approval", intake_json: "{}",
    });
    consultations.setChannel(consultation.id, "22222");
    const events: ConcordiaEvent[] = [];
    const publications = new PublicationService({
      publications: new ConsultationPublicationsRepo(db), consultations, departmentName: () => "技術相談課",
      tabulaConnection: () => null, importPage: vi.fn(),
    });
    const app = new Hono().route("/v1/consultations", consultationsRouter({
      publications, consultations, emit: (event) => { events.push(event); }, now: () => 5_000,
    }));
    expect((await app.request("/v1/consultations/missing/restore-channel", { method: "POST" })).status).toBe(404);
    expect((await app.request(`/v1/consultations/${consultation.id}/restore-channel`, { method: "POST" })).status).toBe(409);
    consultations.markChannelDeleted(consultation.id);
    const accepted = await app.request(`/v1/consultations/${consultation.id}/restore-channel`, { method: "POST" });
    expect(accepted.status).toBe(202);
    expect(events).toEqual([expect.objectContaining({
      type: "consultation.channel_restore_requested", consultation_id: consultation.id, subsidiary_id: "sub-1", mode: "rebuild", ts: 5,
    })]);
    // repost は作り直し済み (削除の記録が無い) チャンネルだけ。
    expect((await app.request(`/v1/consultations/${consultation.id}/restore-channel?mode=repost`, { method: "POST" })).status).toBe(409);
    consultations.restoreChannel(consultation.id, "33333");
    expect((await app.request(`/v1/consultations/${consultation.id}/restore-channel?mode=repost`, { method: "POST" })).status).toBe(202);
    expect(events.at(-1)).toMatchObject({ mode: "repost" });
  });
});
