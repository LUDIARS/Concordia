/**
 * vitest 全体 setup (vitest.config.ts の test.setupFiles から読み込まれる).
 * 各テスト後に helpers が登録したリソース (in-memory DB / tmpdir / env 退避) を
 * 確実に解放する。
 */

import { afterEach } from "vitest";
import { flushCleanups } from "./cleanup.js";

afterEach(() => {
  flushCleanups();
});
