/**
 * vitest 全体 setup (vitest.config.ts の test.setupFiles から読み込まれる).
 * 各テスト後に helpers が登録したリソース (in-memory DB / tmpdir / env 退避) を
 * 確実に解放する。
 *
 * あわせて **Claude CLI 呼び出しを止める**。 report 生成 (narrative / summary-flags) は
 * 実 `claude -p` を叩くため、 フルスイートの負荷で落ちて session 終了系のテストが
 * 低頻度で赤くなっていた。 落ちる場所が回ごとに変わるので、 無関係な変更が
 * 「自分が壊した」ように見える。
 *
 * 既存の運転スイッチ (`CONCORDIA_DISABLE_CLAUDE`) をそのまま使う。 立てると narrative は
 * fallback テンプレートに、 summary-flags は空になり、 **どちらも決定論的**になる。
 * テストが外部バイナリとネットワークに依存しなくなる。
 */

import { afterEach } from "vitest";
import { flushCleanups } from "./cleanup.js";

// isolate: false では process.env が test file 間で共有される。 setupFiles は各 file の
// collection 前に再実行されるので、 前の file が値を変更・削除していても既定値へ戻す。
// 実 CLI を検証する個別テストは、この setup の実行後に明示的に上書きする。
process.env.CONCORDIA_DISABLE_CLAUDE = "1";
// 委託指示書の「ドメイン先行」前置き (delegation/domain-preamble.ts) は warm Anatomia
// server を叩く。 テストを外部サービスの生死に依存させないため既定で切る
// (織り込みそのものは domain-preamble.test.ts が deps 差し替えで検証する)。
process.env.CONCORDIA_DELEGATION_DOMAIN_PREAMBLE = "0";

afterEach(() => {
  flushCleanups();
});
