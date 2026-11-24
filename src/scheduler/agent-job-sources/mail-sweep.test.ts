import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { createMailSweepExecution } from "./mail-sweep-execution.js";
import { createMailSweepStore } from "./mail-sweep-store.js";
import { createQuaestorMailSweep } from "./quaestor-mail-http.js";

const reviewId = "3d243b5b-6768-46f6-973e-7d5a12fb346a";
const payload = {
  fetched: 2, processed: { invoice: 1, cloud_notice: 0, ci_failure: 0, dependabot: 0, ignore: 1 },
  committed: 0, needs_review: 1, notified: 0,
  errors: [{ message_id: "fa0123", error: "mail_auth" }, { message_id: "private@example.com", error: "Bearer private" }],
  subject: "private", body: "private", attachments: ["/private/mail.pdf"], from: "private@example.com",
  reason: "https://private.test",
};
const directory = { findService: async () => ({
  code: "quaestor", name: "Quaestor", state: "running", port: null, catalog_snapshot: { port: 12345 },
}) };

describe("HQ mail sweep", () => {
  it("POST は一度だけ送り、文書一覧と sweep 応答を許可リストへ射影する", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(payload))
      .mockResolvedValueOnce(Response.json([{ id: reviewId, file_path: "/private/mail.pdf" }, { id: "/private/data" }]));
    expect(await createQuaestorMailSweep(directory, request)()).toEqual({
      fetched: 2, processed: payload.processed, committed: 0, needs_review: 1, notified: 0, disabled: false,
      errors: [{ message_id: "fa0123", kind: "auth" }, { message_id: "*", kind: "processing_error" }],
      sweep_status: "completed", needs_review_ids: [reviewId],
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(["http://127.0.0.1:12345/v1/mail/sweep", expect.objectContaining({
      method: "POST", body: "{}", redirect: "error",
    })]);
    expect(request.mock.calls[1]?.[0]).toBe("http://127.0.0.1:12345/v1/mail/documents?status=needs_review");
  });

  it("失敗、無効化、応答喪失を区別し、取り込みを再送しない", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "private" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ...payload, disabled: true }))
      .mockRejectedValueOnce(new Error("private endpoint"));
    const sweep = createQuaestorMailSweep(directory, request);
    expect(await sweep()).toEqual({ sweep_status: "failed", failure_kind: "http_error", http_status: 409 });
    expect(await sweep()).toMatchObject({ sweep_status: "disabled", disabled: true, needs_review_ids: [] });
    expect(await sweep()).toEqual({ sweep_status: "unknown", failure_kind: "transport" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("進行中の予約を他の呼び出しが奪わず、中断後は結果不明とする", async () => {
    const db = makeTestDb();
    try {
      const store = createMailSweepStore(db);
      const sweep = vi.fn(async () => ({ sweep_status: "failed", failure_kind: "endpoint_unavailable" } as const));
      const execute = createMailSweepExecution(store, sweep, () => 121_000);
      expect(store.reserve("fresh", 120_000)).toBe(true);
      expect(await execute("fresh")).toBeNull();
      expect(store.reserve("old", 0)).toBe(true);
      expect(await execute("old")).toEqual({ sweep_status: "unknown", failure_kind: "interrupted" });
      expect(await execute("old")).toEqual({ sweep_status: "unknown", failure_kind: "interrupted" });
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
