import { describe, expect, it } from "vitest";
import type { RevisorLocalPr } from "./revisor-client.js";
import { findLocalPrById, isAlreadyMerged } from "./revisor-merge-confirm.js";

function pr(id: string, status: string): RevisorLocalPr {
  return {
    id,
    number: 1,
    repository: "LUDIARS/Revisor",
    title: "t",
    author: "concordia",
    status,
    checkStatus: "test_ok",
    headRef: "feat/x",
    baseRef: "main",
    headSha: "a".repeat(40),
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("findLocalPrById", () => {
  it("id が一致する行を返す", async () => {
    const reader = { listLocalPrs: async () => [pr("a", "open"), pr("b", "merged")] };
    expect((await findLocalPrById(reader, "b"))?.status).toBe("merged");
  });

  it("見つからなければ null", async () => {
    const reader = { listLocalPrs: async () => [pr("a", "open")] };
    expect(await findLocalPrById(reader, "z")).toBeNull();
  });

  it("読み取りが落ちても投げずに null", async () => {
    const reader = { listLocalPrs: async () => { throw new Error("revisor down"); } };
    expect(await findLocalPrById(reader, "a")).toBeNull();
  });
});

describe("isAlreadyMerged", () => {
  it("merged の PR は true", async () => {
    const reader = { listLocalPrs: async () => [pr("a", "merged")] };
    expect(await isAlreadyMerged(reader, "a")).toBe(true);
  });

  it("open の PR は false", async () => {
    const reader = { listLocalPrs: async () => [pr("a", "open")] };
    expect(await isAlreadyMerged(reader, "a")).toBe(false);
  });

  // 確認できないことをマージ済みへ寄せると、未マージの PR を「マージした」と報告する。
  it("読み取りが落ちたら false (fail-closed)", async () => {
    const reader = { listLocalPrs: async () => { throw new Error("revisor down"); } };
    expect(await isAlreadyMerged(reader, "a")).toBe(false);
  });

  it("reader 未注入なら false", async () => {
    expect(await isAlreadyMerged(undefined, "a")).toBe(false);
  });
});
