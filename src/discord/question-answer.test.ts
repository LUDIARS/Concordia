/**
 * AskUserQuestion 回答経路の回帰テスト (2026-07-13 障害:
 * embedded bot の self-fetch が backlog 溢れで「fetch failed」→ 例外 escape →
 * ユーザに何も返らない)。
 *
 *  - embedded (answerQuestion dep あり): fetch を一切呼ばない in-process 直呼び。
 *  - worker (dep なし): HTTP fallback は 5xx/接続失敗をリトライし、失敗しても
 *    throw せず { ok: false } を返す (graceful)。4xx はリトライしない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAnswerForQuestion } from "./question.js";

const SESSION = "lictor-regression-session";
const BODY = { question_id: 1, answer_index: 0 } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendAnswerForQuestion (in-process = embedded)", () => {
  it("answerQuestion dep を直呼びし、fetch は使わない", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called in embedded path");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const answerQuestion = vi.fn(() => ({ ok: true as const, answer_text: "案A" }));
    const r = await sendAnswerForQuestion({ answerQuestion, concordiaUrl: "http://127.0.0.1:1" }, SESSION, BODY);
    expect(r).toEqual({ ok: true, answerText: "案A" });
    expect(answerQuestion).toHaveBeenCalledWith(SESSION, BODY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dep が意味的エラーを返したら error として伝える", async () => {
    const answerQuestion = vi.fn(() => ({ ok: false as const, status: 409 as const, error: "already_answered" }));
    const r = await sendAnswerForQuestion({ answerQuestion, concordiaUrl: "http://127.0.0.1:1" }, SESSION, BODY);
    expect(r).toEqual({ ok: false, error: "already_answered" });
  });

  it("dep が throw しても escape させない", async () => {
    const answerQuestion = vi.fn(() => {
      throw new Error("boom");
    });
    const r = await sendAnswerForQuestion({ answerQuestion, concordiaUrl: "http://127.0.0.1:1" }, SESSION, BODY);
    expect(r).toEqual({ ok: false, error: "boom" });
  });
});

describe("sendAnswerForQuestion (HTTP fallback = worker)", () => {
  const deps = { concordiaUrl: "http://127.0.0.1:59999" };

  it("接続失敗はリトライして成功したら ok (2026-07-13 の fetch failed 回帰)", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, answer_text: "案B" }) });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendAnswerForQuestion(deps, SESSION, BODY, { retryDelayMs: 0 });
    expect(r).toEqual({ ok: true, answerText: "案B" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("全滅しても throw せず ok:false を返す", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendAnswerForQuestion(deps, SESSION, BODY, { retries: 2, retryDelayMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unreachable");
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 初回 + リトライ 2
  });

  it("4xx (意味的エラー) はリトライしない", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "already_answered" }) });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendAnswerForQuestion(deps, SESSION, BODY, { retryDelayMs: 0 });
    expect(r).toEqual({ ok: false, error: "already_answered" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("5xx はリトライする", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, answer_text: "案C" }) });
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendAnswerForQuestion(deps, SESSION, BODY, { retryDelayMs: 0 });
    expect(r).toEqual({ ok: true, answerText: "案C" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
