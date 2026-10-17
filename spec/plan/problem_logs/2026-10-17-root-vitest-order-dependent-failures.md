# ルート全体テストの実行順依存の失敗と fixture 不整合

- Date: 2026-10-17
- Status: fixed in branch `feat/root-vitest-green`
- Area: test tooling (ルート `vitest.config.ts`) / web-sso / design-review handoff
- Actio: `actio:53a7b6a1-24f0-4831-99f9-851a5c2a5e51`

## Summary

main 553cd88f のルート全体テスト (`vitest run`、`.wt-*` 除外) で 4 ファイル 10 件が落ちていた。単独実行で落ちるのは design-review-handoff の 4 件、全体実行でだけ落ちるのは残りの 6 件。全体実行でだけ落ちる失敗は実行順で顔ぶれが変わる。今回の観察では http-gate だけが落ちる回、web の ChatMarkdown が落ちる回 (`--sequence.shuffle.files` の seed 1・3) があった。cernere-project-channel と runtime-failure は手元の全体実行では再現せず、順序を固定して再現した。

## Evidence / Cause

1. `tests/design-review-handoff.test.mjs` (4 件): 改行・BOM の問題ではない。fixture `map-Anatomia.json` の `repo` が `"Anatomia (LUDIARS/Anatomia, 略称 An) — /home/user/Anatomia"` という説明文で、CC-DESIGN-01 (ファイル名と一致) の検証に正しく弾かれていた。
2. `src/web-sso/http-gate.test.ts` (1 件): 先に走るテストが src/bootstrap/core.ts 等を通して `@hono/node-server` の `getRequestListener` を呼び、global `Request` / `Response` が軽量版に差し替わる。`isolate: false` なので後続の file にも残る。軽量 Response は本文を読むと元の init から作り直すため、`c.text()` で作った後に `headers.set` した `cache-control: no-store` は、`await res.text()` を先に呼ぶと読み戻せない。本番も同じ軽量 Response で動く。487 file を同じ順で流してから http-gate を流すと再現した。
3. web/src の jsdom テスト: `singleThread` の経路では、同じ環境の file が 1 回の実行にまとめて渡され、jsdom 環境は 1 つだけ作られる。ルート実行は globals を有効にしないので Testing Library の自動 cleanup が登録されず、`createRoot` の container を body に付けたままの file もある。前の file の描画が残り、`ChatMarkdown.test.tsx` が `Found multiple elements with the role "table"` で落ちる。node 環境の file とは環境ごとに worker が作り直されるので、jsdom の globals が node のテストへ漏れる経路ではなかった (タスク本文の仮説は外れ)。
4. cernere-project-channel の `WebSocket is not a constructor` (4 件) と runtime-failure の `vi.waitFor` 不成立 (1 件): `src/api/ws-continuation.test.ts` が `vi.resetModules()` のうえで `vi.mock("ws", () => ({ WebSocket: { OPEN: 1 }, ... }))` と `vi.mock("../taskflow/completion-blackbox.js", ...)` を差し込み、`isolate: false` の共有モジュールキャッシュにそのまま残していた。後続の file が読む `ws` の `WebSocket` は `{ OPEN: 1 }` になり、`TaskflowRuntime` は stub の blackbox を握ったままで、テストが spy する `CompletionBlackbox.prototype.decide` に届かない。ws-continuation → cernere-project-channel → runtime-failure の順に流すと、タスク本文と同じ 5 件が落ちることを確認した。

## Fix

- fixture の `repo` を `"Anatomia"` にし、元の説明は `repoLabel` に残した。検証は弱めていない。
- `webSsoMiddleware` の拒否応答は `c.header()` でヘッダーを init に入れてから `c.text()` で作る。軽量 Response 下で本文を先に読む回帰テストを追加した (旧コードでは落ちることを確認済み)。
- `ws-continuation.test.ts` の終わり (`afterAll`) で `vi.doUnmock` と `vi.resetModules()` を呼び、mock とそれに結びついたモジュールを後続の file に渡さない。修正前は上の順序で 5 件落ち、修正後は 0 件。
- ルート `vitest.config.ts` を `projects` で `node` と `web` (`web/src/**/*.test.{ts,tsx}`) に分け、web にだけ `web/src/rootTestSetup.ts` (各テスト後に Testing Library の cleanup と `document.body` の片付け) を足した。pool・`isolate: false`・`singleThread` は両方ともルートの設定を継承し、node 側の前提 (better-sqlite3 の teardown 対策) は変えていない。収集される file 集合は分割前と同じ (1175 件)。`.augur/tests.jsonl` の runner=vitest はファイル指定で `vitest run <file>` を呼ぶので、どちらの project にもそのまま効く。
- web を `isolate: true` にする案は採らなかった。ルートの `isolate: false` で worker が使い回されるため、外部化された Testing Library が最初の file の document を握ったままになり、shuffle で 64 件落ちた。

## 再発時の調べ方

- 実行順を固定して再現するには、`sequence.sequencer` に順序リストで並べる sequencer を渡す一時 config を使い、全体実行の完了順 (= singleThread の実行順) を与える。
- Concordia 本体フォルダの中に入れ子にした worktree (`.wt-*`) では、web の setupFiles が本体側のパスに解決されて全 suite が落ちる (node_modules を実体の install にしても同じ)。設定ファイルを変えた検証は、E:/Document/Ars 直下に置いた一時 checkout で行う。
