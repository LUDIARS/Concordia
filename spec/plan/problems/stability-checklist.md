# 長時間稼働サービスの安定化チェックリスト (汎用)

- Date: 2026-07-09
- Source: Concordia の Cc 安定性解析 ([spec/plan/cc-stability-analysis.md](../cc-stability-analysis.md)) から一般化
- 対象: Node.js を中心に、 子プロセス管理・常駐 bot・ローカル DB を持つ長時間稼働サービス全般

Concordia で実際に踏んだ落とし穴を、 他プロジェクトでもレビュー時に確認できる
チェックリストに一般化したもの。 各項目は「なぜ危ないか」(Concordia での実例) 付き。

---

## 1. プロセスレベルの安全網

- [ ] `process.on("unhandledRejection")` / `process.on("uncaughtException")` をエントリポイントで登録し、 ログ + 通知経路へ流しているか
  - Node 22 既定では未処理 rejection 1 発でプロセス終了。 管制塔的なサービスが死ぬと配下の全てが同時死したように見える
- [ ] `@typescript-eslint/no-floating-promises` 等で「await も .catch もされない Promise」を機械検出しているか
  - 人力レビューでは `void (async () => {…})()` の `.catch` 漏れを恒常的に見逃す (Concordia では隣接ハンドラは正しく、 2 箇所だけ漏れていた)
- [ ] イベントバス / EventEmitter の listener に **async 関数** を渡す場合、 emit 側の try/catch は同期 throw しか捕まえないことを理解し、 listener 側 body 全体をガードしているか
- [ ] `setInterval(async () => …)` の body 全体が try/catch で包まれているか (1 箇所でも例外パターンのタイマーがあれば統一する)

## 2. 子プロセスの起動と監視

- [ ] すべての `spawn()`/`exec()` に `child.on("error", …)` を付けているか
  - spawn 失敗 (ENOENT/EACCES/EMFILE) は **非同期の error イベント**で届く。 リスナーが無いと親プロセスごと uncaughtException
- [ ] 子プロセスの終了コードを親が観測できるか。 シェルラッパで exit code を握り潰していないか
  - Concordia は WT のタブ残留回避の `& exit 0` で全クラッシュが成功終了に見えていた
- [ ] detach した子プロセスの死活を「何のシグナルで」検知するか明文化されているか (exit イベント / heartbeat / ログ / pid ポーリング)
- [ ] クラッシュ検知後の再起動戦略があるか (回数上限 + バックオフ付き)。 「検知するが復旧しない」は放置と同じ
- [ ] pipe した stdout/stderr を必ず drain しているか (溜めると子がブロックする)。 不要なら `stdio: "ignore"`

## 3. プロセスを kill する側の安全性

- [ ] 保存済み PID を kill する前に、 その PID が「当時のプロセスのままか」を検証しているか (開始時刻 / イメージ名 / cmdline 照合)
  - PID は OS に再利用される。 特に tree-kill (`taskkill /F /T` / `kill -pgid`) は無関係プロセス群を巻き添えにする
- [ ] 「レコードが無い = 孤児 = kill してよい」という判定になっていないか
  - レコード削除 (GC/purge) と kill 判定が独立タイマーで走ると、 **行を消した瞬間に生きているプロセスが孤児扱い**になる。 削除前に生存確認するか、 kill 前に独立した生存シグナル (ログ mtime 等) を確認する
- [ ] graceful shutdown → 強制 kill のタイムアウト猶予が、 相手側のクリーンアップ処理の最大時間と整合しているか (Concordia は猶予 300s < クリーンアップ 600s だった)

## 4. 死活判定 (heartbeat / liveness)

- [ ] 死活シグナルは 2 系統以上あるか。 単一シグナル (WS 接続 1 本など) の瞬断が即「死亡判定」に繋がらないか
- [ ] 「busy で無音」と「死んで無音」を区別できるか (イベント駆動 heartbeat は長い 1 処理中に凍結する。 タイマー式 heartbeat か、 作業出力の mtime を併用)
- [ ] dead 判定から**復帰する経路**があるか。 生存トラフィックが来ているのに dead 扱いが固定される状態遷移になっていないか
  - Concordia の中心的欠陥: lost → active への復帰経路が登録時のみで、 稼働中セッションは lost に落ちたら二度と戻れなかった
- [ ] **サービス自身の再起動直後**が最も誤判定しやすい (接続カウントのリセット、 クライアントの再接続ラグ)。 起動猶予ウィンドウ (再接続バックオフ最大値 + 判定周期ぶん) を設けているか
- [ ] 閾値・周期の実定数が README / .env.example / ドキュメントで一致しているか
  - Concordia は `.env.example` が 300s、 コード既定が 1800s で、 サンプルをコピーした環境だけ誤判定が 6 倍出やすかった

## 5. フック / プラグインとして他プロセスに寄生するコード

(エディタ拡張、 git hook、 CI ステップ、 agent hook など「他人のクリティカルパス」で走るコード全般)

- [ ] 外部プロセス呼び出し (`execSync` 等) 全てに timeout があるか。 1 つでも無いとホスト側が無期限ブロックする
- [ ] ネットワーク呼び出しに timeout + 「サーバ不在なら以降を即 skip」の short-circuit があるか
  - 直列 N 本 × timeout 1.5s は、 サーバ停止中「毎回 N×1.5 秒のフリーズ」としてユーザーに見える
- [ ] 失敗時の exit code はホストの動作を阻害しない値か (報告できない ≠ ホストを止めてよい)
- [ ] stdout がホストに取り込まれる場合 (context 注入等)、 出力条件とサイズ上限を絞っているか
- [ ] 設定値 (env) のパースに検証があるか (`Number(env.X)` の NaN が沈黙のフェイルを起こさないか)

## 6. ローカル DB (SQLite 等)

- [ ] `busy_timeout` を明示しているか。 同一 DB を複数プロセスが書くなら競合設計 (リース / 単一 writer) があるか
- [ ] 同期 DB API (better-sqlite3 等) の遅いクエリがイベントループを塞ぐことを把握し、 ホットパスのクエリを計測しているか
  - イベントループ停止は「HTTP 全応答の停止」= 外から見ると死んでいるのと同じ。 3 秒 ACK 期限がある webhook/interaction 系は特に致命的
- [ ] GC / purge 系のバッチ削除が、 他コンポーネントの参照 (生存判定・保護リスト) と整合しているか

## 7. 常駐 bot / 外部 API クライアント

- [ ] ライブラリの**正常な再接続イベントを fatal 扱いしていないか** (discord.js の `ShardReconnecting` は自動 resume される通常イベント)
- [ ] bot が完全停止した場合に自動復帰する watchdog があるか。 「状態を記録して handle を null にするだけ」は復旧ではない
- [ ] ACK 期限があるプラットフォーム (Discord interaction は約 3 秒) では、 handler 冒頭で defer/ACK してから処理しているか。 これをテストで固定しているか
- [ ] rate limit (429) / 対象消滅 (404 系) を「起こり得る正常系」として catch しているか

## 8. 観測性 (落ちたときに原因が残るか)

- [ ] クラッシュ / 誤 kill / 状態遷移 (dead 判定・復帰・purge) がすべてログ + イベントとして残るか
- [ ] 「誰が kill したか」が追えるか (reaper / 手動 / タイムアウト、 対象 pid と根拠)
- [ ] 失敗ログに相関 id (session id / interaction id / 経過時間) が入っているか — 期限切れ到着か処理遅延かを切り分けられる
- [ ] 無限成長するインメモリ構造 (dedup 用 Map/Set、 cursor cache) に上限や TTL があるか

---

## 使い方

新規サービスの設計レビュー時、 または「よく落ちる」調査の初手として、 上から順に
チェックする。 Concordia での各項目の実例と修正内容は
[cc-stability-problems.md](cc-stability-problems.md) を参照。
