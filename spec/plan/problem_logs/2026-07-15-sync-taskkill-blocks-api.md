# API からの同期 taskkill が event loop を停止する

- 発生日: 2026-07-15
- 状態: 修正済み（未リリース）
- 影響: session stop / relictor / delete 保険 / reaper が Windows で process tree を停止するとき、Concordia Web API と同じ Node.js process の event loop が停止する

当初の現象は「Cc が断続的に落ちる」だった。Excubitor の観測では process exit より HTTP health
timeout が中心であり、単一 event loop 上に API、embedded Discord/Slack、同期 SQLite、同期 taskkill が
同居していることが応答停止のリスクだった。最新 main (`b8f3ed7`) を基準に確認した。

## 事実

`src/control/stop-session.ts` は Windows の process tree を確実に閉じるため
`spawnSync("taskkill", ["/F", "/T", ...])` を使っていた。この helper を Web API route、
session 終了 timer、reaper が直接呼んでいた。taskkill の終了待ち中は `/health` を含む全 HTTP、
WebSocket relay、同一 process の timer が進まない。

## 原因

OS 制御という遅くなり得る処理と HTTP request lifecycle が同一 process にあり、かつ同期 subprocess
API を使っていた。失敗時に再試行できる永続境界も無かった。

## 対応

- SQLite schema v38 に lease 付き `control_jobs` durable queue を追加した。
- API / timer / reaper は停止対象を queue に登録するだけにした。admin stop は `202 queued` を返す。
- `control-worker` を別 process として追加し、queue から取得した job だけが同期 taskkill / signal を実行する。
- worker crash 時は lease 失効後に job を再取得する。active job は dedupe key で重複登録しない。
- PID 再利用対策として job を5分で失効させ、session metadata の role/PID または orphan の command line
  指紋を worker が再検証する。不一致なら停止しない。
- taskkill 自体にも30秒 timeout を設定した。
- Excubitor catalog に `concordia-control` process service を追加し、失敗時再起動と process health を設定した。

関連する分離として、既存 chat-worker v2（SQLite read model、async WebSocket bridge、durable mutation
outbox）を Excubitor の `concordia-chat` service で有効化し、core は `CONCORDIA_CHAT_MODE=worker`
にした。operational log の direct file 二重出力は無効化し、stdout/stderr の永続化と tail は Excubitor
process に集約した。Vestigium の audit JSONL は用途が別なので既存の async stream を維持する。

## 検証

- queue の active dedupe、worker lease crash recovery、retry、期限切れ、session PID 再検証を unit test 化。
- admin stop が taskkill を実行せず2件の durable job を残す API test を追加。
- Concordia: TypeScript / dependency-cruiser、対象 test、全 test、build を実行する。
- Excubitor: typecheck と全 test を実行する。
