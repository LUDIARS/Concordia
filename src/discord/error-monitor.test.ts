/**
 * startVestigiumErrorWatch の in-flight 排他制御の裏取り。
 *
 * poll (runOnce) が interval を超えて長引くと、 setInterval の次 tick が重複実行され
 * watermark 更新前の同じレコードを 2 回 reportError してしまう (継続レビュー指摘:
 * error-monitor.ts:72)。 このテストは、 listVestigiumServices/recent を遅延応答に
 * 差し替え、 前回の runOnce が終わる前に runOnce を再度呼んでも reportError が
 * 重複しないことを確認する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// vi.mock ファクトリは vi.mock 呼び出しごとファイル先頭へ hoist されるため、
// 参照するモック関数は vi.hoisted で先に確保する (通常の const 宣言だと
// hoisting 順序で "Cannot access before initialization" になる)。
const { listVestigiumServices, recent, reportError } = vi.hoisted(() => ({
  listVestigiumServices: vi.fn(),
  recent: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("../mcp/vestigium-reader.js", () => ({
  listVestigiumServices,
  recent,
}));
vi.mock("../errors.js", () => ({
  reportError,
}));

describe("startVestigiumErrorWatch in-flight guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("shares the in-flight poll instead of starting a duplicate run", async () => {
    vi.stubEnv("CONCORDIA_ERROR_WATCH_LOGS_ROOT", "E:/fake/vestigium");
    let resolveServices!: (value: string[]) => void;
    listVestigiumServices.mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveServices = resolve; }),
    );

    const { startVestigiumErrorWatch } = await import("./error-monitor.js");
    const handle = startVestigiumErrorWatch();

    // 1周目 (未解決 = poll がまだ完了していない状態) と、 その完了前に呼んだ
    // 2周目が「同じ in-flight」 を共有すること。
    const first = handle.runOnce();
    const second = handle.runOnce();
    expect(listVestigiumServices).toHaveBeenCalledTimes(1);

    resolveServices([]);
    await Promise.all([first, second]);
    expect(listVestigiumServices).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("does not double-report the same record when overlapping polls occur across two services", async () => {
    vi.stubEnv("CONCORDIA_ERROR_WATCH_LOGS_ROOT", "E:/fake/vestigium");
    listVestigiumServices.mockResolvedValue(["svc-a"]);
    let recentCalls = 0;
    recent.mockImplementation(async () => {
      recentCalls += 1;
      // 初回 poll は watermark 初期化のみ (recent は呼ばれない) なので、
      // ここに到達するのは 2 周目以降。 watermark (last) は初回 poll 時の
      // 実時刻 (Date.now()) を基準にするため、 ts もそれより新しい実時刻にする
      // (固定の小さい値だと rec.ts <= last で常に弾かれてしまう)。
      return [{ ts: Date.now() + recentCalls, level: "error", service: "svc-a", channel: "app", msg: "boom" }];
    });

    const { startVestigiumErrorWatch } = await import("./error-monitor.js");
    const handle = startVestigiumErrorWatch();

    // 1周目: watermark を初期化するだけ (recent 未呼び出し)。
    await handle.runOnce();
    expect(recent).not.toHaveBeenCalled();

    // 2周目を並行して 2 回叩いても、 in-flight 共有により実処理は 1 回だけ。
    const a = handle.runOnce();
    const b = handle.runOnce();
    await Promise.all([a, b]);

    expect(recent).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
