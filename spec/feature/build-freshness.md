---
updated: 2026-09-04
---

# ビルド鮮度 (dist が src より古いまま稼働していないか)

## 背景

Concordia は Excubitor 管理下で `node dist/server.js` を実行する。`restart_policy` は
クラッシュ時にしか再起動しないので、**ソースを直して main へ入れただけではプロセスは
古い `dist/` を動かし続ける**。サービスは止まらないため「main に入っているのに直らない」
という形の事故になり、コードからは検知できない。

実例 (Memoria #1996): PR #1291 が main に入っているのに `dist/server.js` (9/3 17:43) が
`src/db/schema.ts` (9/4 02:10) より古く、migration 82 が走らないまま稼働していた。
`delegation_templates.review_only` 列が作られず、`vulnerability-response-daily` の
completed 報告が完了証跡ガードで failed 化され続けた。毎回 dist と src の mtime を
手で比べて気づいている。

同じ仕組みは Genius が `SPEC-GENIUS-BUILD-FRESHNESS` で先に持っており、本仕様はその写し。

## SPEC-CONCORDIA-BUILD-FRESHNESS: 起動時のビルド鮮度判定

起動時に 1 度だけ TypeScript のビルド対象となる `src/**/*.ts` と対応する
`dist/**/*.js` の mtime を比べ、
**src のほうが新しい、または対応する出力が無い**ファイルが 1 件でもあれば stale とする。

- **起動は止めない。** fail-fast の対象は設定不備であって、ビルド鮮度は運用上の警告。
  古い dist でもサービスとしては動いているので、止めると可用性を落とすだけになる。
- **`ok` も落とさない。** Excubitor の health チェックが失敗と見なすと再起動を始めるが、
  再起動しても dist は新しくならないので、古いまま再起動を繰り返すだけになる。
- 判定結果は `GET /health` の `build_stale` (boolean) に出す。
- `dist/` が丸ごと無い (未ビルド) 場合は stale にしない。それは「そもそも起動できない」
  という別のエラーで顕在化するため、ここで二重に報せても運用の判断は変わらない。
- `src/` が読めない構成 (配布物だけを置いた環境) でも stale にしない。
- `tsconfig.json` で除外される `.d.ts` と `.test.ts` は出力を持たないので比較対象にしない。
- 最初の 1 件で打ち切り、そのファイルの相対パスを警告へ載せる。何件古いかは対処
  (`npm run build` + Excubitor 経由の再起動) を変えないため、件数は数えない。
- 判定自体が失敗した場合は fresh として扱う。**鮮度が判らないことと古いことは別**で、
  判定の失敗を stale と報せると誤った再ビルドを促す。

## 実装

- `src/runtime/build-freshness.ts` — 判定と警告文
- `src/bootstrap/core.ts` — 起動時に 1 度実行し、結果を `AppDeps.buildStale` へ渡す
- `src/app.ts` — `GET /health` の `build_stale`

## 対象外

Excubitor が起動前に build する案 (Memoria #1639 から引き継ぎ) は catalog / インフラ側の
変更で別軸。サービス側の可視化 (本仕様) と両方あってよい。
