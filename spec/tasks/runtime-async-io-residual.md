---
task: runtime-async-io-residual
project: Concordia
kind: 実装
status: delegated
created: 2026-10-14T00:00:00.000Z
source_session: lictor-f15c28be-5160-4fd5-a61d-4048f72576f9
actio_task_id: ebfc25ae-9ec8-49aa-bcb0-2756fe4be40b
memory_links: []
---
# ランタイム I/O の残りの同期処理を非同期化し、再混入を検査で止める

## 背景

設計の正本は spec/tasks/full-async-io.md。 #357 / #368 の後も、リクエスト経路
(web-hosts の読み書き、セッション登録の repo_path 確認) と、前回残件にした spawn 経路に
同期 fs が残っていた (Pf フラグメント 01M4VTCS9JY3E7P8B3NSPXA59T の再確認)。

## 分解

1. 共通の非同期プローブ `pathExists` (src/shared/fs-async.ts) を足す。
2. リクエスト経路を非同期化する: web-hosts / セッション登録 / work-submission の本体 checkout 解決 /
   バグバウンティ Bot トークン / setup スキル / ハーネスの DDD・受入証跡 / pre-compact /
   委託の完了証跡・別リポ md 同梱・Augur CLI 解決 / claude 起動先解決 / Test Forum QA /
   domain-review / 相談の CODEX_HOME / deploy・release の clone 解決。
3. spawn 経路を非同期化する: `spawnSession` を Promise 化し、cwd 検証・内部 Agent プラグイン・
   session Git hooks・Lictor launcher・spawn-target / spawn-cwd・process のログ dir を await に揃える。
4. interval tick を非同期化する: WAL guard / nightly vacuum / ログ退避 zip / director 巡回 /
   federation 設定キャッシュ書き込み / repo 走査。
5. 再発防止の検査 `tests/runtime-sync-io.test.ts` を足し、残す同期処理を full-async-io.md に理由つきで列挙する。

## 再利用の検討

- 既存の非同期プローブを探したが、`access(...).then(() => true, () => false)` が processes/manager.ts
  に 1 か所あるだけで共通関数は無かった。 existsSync と同じ判定の `pathExists` を shared に置いて
  各所で使う。
- 呼び出し側の差し替え口 (DI) は既存のものを残し、 同期・非同期のどちらの実装も受けられる型
  (`T | Promise<T>`) に広げた。 テストの差し替えはそのまま動く。
- 検査は ESLint ではなく vitest のテストにした。 リポジトリに ESLint の設定が無く、 登録テストとして
  Revisor の動作ブロックで必ず走るため。

## 判断が要る点

- ログ退避 zip の圧縮 (zlib) は fs ではないが同期 API でイベントループを止めるので対象に含めた。
- spec の一覧で CLI 扱いだった release の clone 解決と build 判定は、 director 巡回と deploy から
  呼ばれていたので非同期化した。
- better-sqlite3 の同期 API は従来どおり対象外。

## 完了条件

- リクエスト処理・interval tick・イベント処理・spawn の経路に同期 fs / 同期子プロセス / 同期 zlib が残らない。
- 起動時だけ・CLI だけ・テスト専用で残すものは spec/tasks/full-async-io.md に理由つきで列挙されている。
- エラー時の応答と処理順序が変わらない (federation の設定キャッシュは到着順に書き、書いた後に onConfig を呼ぶ)。
- `tests/runtime-sync-io.test.ts` が許可リスト外の同期呼び出しと、不要になった許可を検出して落ちる。
- `npx tsc --noEmit -p tsconfig.json` が通り、変更ファイルに対応するテストが通る。
