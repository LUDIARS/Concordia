import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationPublicationsRepo } from "../db/consultation-publications-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { CONSULT_SESSION_MAX_MS, SHARE_ANSWER_TIMEOUT_MS } from "./closure-policy.js";
import { ConsultationClosureService, type ConsultationClosurePorts } from "./closure-service.js";

const SHAREABLE = '{"publishable": true, "title": "集約の切り方", "summary": "不変条件の単位で切る"}';

function setup(options: { subsidiary?: string | null; judge?: () => Promise<string>; leakTerms?: string[] } = {}) {
  const db = makeTestDb();
  const store = new PrivateConsultationsRepo(db);
  const publications = new ConsultationPublicationsRepo(db);
  const consultation = store.create({
    subsidiary_id: options.subsidiary ?? null, department_id: "dept_qa", requester_user_id: "111",
    status: "pending_approval", intake_json: "{}",
  }, 0);
  store.setChannel(consultation.id, "chan-1", 0);
  store.markOpen(consultation.id, "111", 0);
  store.setSession(consultation.id, "sess-1", 0);
  let clock = 1_000;
  const ports = {
    store,
    publications: (id: string) => publications.listForConsultation(id),
    stopSession: vi.fn(async () => true),
    transcript: vi.fn(() => [{ role: "user" as const, text: "集約はどう切る?" }, { role: "assistant" as const, text: "不変条件で" }]),
    judge: vi.fn(options.judge ?? (async () => SHAREABLE)),
    leakTerms: vi.fn(async () => options.leakTerms ?? ["InternalProduct"]),
    proposeShare: vi.fn(async (consultationId: string, title: string, summary: string) => {
      publications.create({ consultation_id: consultationId, title, summary }, clock);
      return true;
    }),
    expireShare: vi.fn(async (publicationId: string) => publications.markClosed(publicationId, "declined", "timeout", clock)),
    deleteChannel: vi.fn(async () => "deleted" as const),
    log: { info: vi.fn(), warn: vi.fn() },
    now: () => clock,
  } satisfies ConsultationClosurePorts;
  const service = new ConsultationClosureService(ports);
  return { service, store, publications, ports, id: consultation.id, advance: (ms: number) => { clock += ms; } };
}

describe("ConsultationClosureService", () => {
  it("asks to share a publishable head-office consultation once, without deleting the channel yet", async () => {
    const { service, store, ports, id } = setup();
    await service.closeConsultation(id);
    await service.closeConsultation(id);
    await service.sweep();
    expect(ports.proposeShare).toHaveBeenCalledTimes(1);
    expect(store.find(id)).toMatchObject({ status: "closed", wrap_status: "asking", channel_deleted_at: null });
    expect(ports.deleteChannel).not.toHaveBeenCalled();
  });

  it("deletes the channel once the requester answers", async () => {
    const { service, store, publications, ports, id } = setup();
    await service.closeConsultation(id);
    const publication = publications.listForConsultation(id)[0]!;
    publications.markClosed(publication.id, "declined", "111");
    await service.onShareDecided(id);
    expect(store.find(id)).toMatchObject({ wrap_status: "done", channel_deleted_at: expect.any(Number) });
    expect(ports.deleteChannel).toHaveBeenCalledWith("chan-1");
  });

  it("treats 24 hours without an answer as 'do not share' and then deletes the channel", async () => {
    const { service, store, ports, id, advance } = setup();
    await service.closeConsultation(id);
    advance(SHARE_ANSWER_TIMEOUT_MS - 1);
    await service.sweep();
    expect(ports.expireShare).not.toHaveBeenCalled();
    advance(1);
    await service.sweep();
    expect(ports.expireShare).toHaveBeenCalledTimes(1);
    expect(store.find(id)).toMatchObject({ wrap_status: "done", channel_deleted_at: expect.any(Number) });
  });

  it("deletes the channel without asking when the conversation is not publishable or leaks internal names", async () => {
    const notPublishable = setup({ judge: async () => '{"publishable": false}' });
    await notPublishable.service.closeConsultation(notPublishable.id);
    expect(notPublishable.ports.proposeShare).not.toHaveBeenCalled();
    expect(notPublishable.store.find(notPublishable.id)).toMatchObject({ wrap_status: "done" });
    expect(notPublishable.ports.deleteChannel).toHaveBeenCalledTimes(1);

    const leaking = setup({ judge: async () => '{"publishable": true, "title": "InternalProduct の話", "summary": "s"}' });
    await leaking.service.closeConsultation(leaking.id);
    expect(leaking.ports.proposeShare).not.toHaveBeenCalled();
    expect(leaking.store.find(leaking.id)?.wrap_status).toBe("done");
    // 語そのものはログに出さない (件数だけ)。
    expect(JSON.stringify(leaking.ports.log.info.mock.calls)).not.toContain("InternalProduct");
  });

  it("never asks in a subsidiary and just deletes the channel", async () => {
    const { service, store, ports, id } = setup({ subsidiary: "glab" });
    await service.closeConsultation(id);
    expect(ports.judge).not.toHaveBeenCalled();
    expect(store.find(id)).toMatchObject({ wrap_status: "done", channel_deleted_at: expect.any(Number) });
  });

  it("keeps the consultation pending when the judge fails and retries on the next sweep", async () => {
    let calls = 0;
    const { service, store, ports, id } = setup({ judge: async () => { calls += 1; if (calls === 1) throw new Error("timeout"); return SHAREABLE; } });
    await service.closeConsultation(id);
    expect(store.find(id)?.wrap_status).toBe("pending");
    await service.sweep();
    expect(store.find(id)?.wrap_status).toBe("asking");
    expect(ports.proposeShare).toHaveBeenCalledTimes(1);
  });

  it("stops the session of a consultation open for 24 hours", async () => {
    const { service, ports, advance } = setup();
    await service.sweep();
    expect(ports.stopSession).not.toHaveBeenCalled();
    advance(CONSULT_SESSION_MAX_MS);
    await service.sweep();
    expect(ports.stopSession).toHaveBeenCalledWith("sess-1");
  });

  it("retries the channel deletion that failed", async () => {
    const { service, store, ports, id } = setup({ subsidiary: "glab" });
    ports.deleteChannel.mockResolvedValueOnce("failed" as never);
    await service.closeConsultation(id);
    expect(store.find(id)?.channel_deleted_at).toBeNull();
    await service.sweep();
    expect(store.find(id)?.channel_deleted_at).not.toBeNull();
  });
});
