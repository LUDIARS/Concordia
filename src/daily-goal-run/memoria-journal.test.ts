import { describe, expect, it } from "vitest";
import { createMemoriaJournalHttp, dailyGoalNoteExternalId } from "./memoria-journal.js";

type Call = { url: string; method: string; body?: string };

function fake(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => next.body ?? null };
  };
  return { calls, port: createMemoriaJournalHttp({ baseUrl: "http://memoria/", fetch }) };
}

describe("Memoria journal HTTP adapter (Memoria との契約)", () => {
  it("puts the diary section and creates the note with the contract paths and body", async () => {
    const { calls, port } = fake([{ status: 200, body: {} }, { status: 201, body: { id: 12, url: "http://memoria/notes/12" } }]);
    expect(await port.putDiarySection("2026-10-10", "concordia-daily-goal", { title: "t", markdown: "m" })).toEqual({ ok: true, value: {} });
    expect(await port.createNote({ external_id: dailyGoalNoteExternalId("2026-10-10"), title: "t", markdown: "m", source: "concordia-daily-goal" }))
      .toEqual({ ok: true, value: { id: "12", url: "http://memoria/notes/12" } });
    expect(calls[0]).toEqual({ url: "http://memoria/api/diary/2026-10-10/sections/concordia-daily-goal", method: "PUT", body: JSON.stringify({ title: "t", markdown: "m" }) });
    expect(calls[1]!.url).toBe("http://memoria/api/notes/from-text");
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ external_id: "concordia-daily-goal:2026-10-10" });
  });

  it("separates a definite rejection (未記載) from an unknown result (照合が要る)", async () => {
    const { port } = fake([{ status: 404 }, { status: 503 }, new Error("ECONNREFUSED")]);
    expect(await port.putDiarySection("2026-10-10", "s", { title: "t", markdown: "m" })).toMatchObject({ ok: false, kind: "rejected" });
    expect(await port.putDiarySection("2026-10-10", "s", { title: "t", markdown: "m" })).toMatchObject({ ok: false, kind: "unknown" });
    expect(await port.createNote({ external_id: "x", title: "t", markdown: "m", source: "s" })).toMatchObject({ ok: false, kind: "unknown" });
  });

  it("reconciles the diary section with GET (404 = not written)", async () => {
    const { port } = fake([{ status: 404 }, { status: 200, body: { title: "t" } }]);
    expect(await port.getDiarySection("2026-10-10", "s")).toEqual({ ok: true, value: { exists: false } });
    expect(await port.getDiarySection("2026-10-10", "s")).toEqual({ ok: true, value: { exists: true } });
  });
});
