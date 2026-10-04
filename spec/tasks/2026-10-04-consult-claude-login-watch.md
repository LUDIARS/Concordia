---
task: 2026-10-04-consult-claude-login-watch
project: Concordia
kind: 実装
created: 2026-10-04
memory_links: []
---
# 相談用 Claude のログイン切れを起動前と起動後に検出する

設計正本: `spec/feature/tech-consultation.md` §6.3 (この task で追加)。
2026-10-04 neco 報告「そもそも相談窓口 spawn しなくなった」「OAuth Error で 400」「claude の認証が通ってなかった。解決しました」、
指示「再発防止入れて」。

- 価値: UX-CC-W6 / シナリオ UX-CC-S7 (相談者が相談窓口から回答を得られる)
- ドメイン: consultation

## 目的

相談専用の Claude 設定フォルダの認証が通っていないと、相談の claude は起動直後のログイン画面で止まり、Cc 上は active のまま
相談者に何も返らない。起動前の判定はファイルの有無だけで、止まったことに誰も気づけなかった。

## 設計

1. `src/consultation/consult-claude-login.ts` (新規、純関数): `.credentials.json` の本文から起動可否を判定する
   (無い・壊れている・更新用トークン無し・更新用トークンの期限切れ → 起動しない)。トークンの値は読まない。
2. `src/api/register-core.ts`: `prepareClaudeConfig` の判定を `existsSync` から 1 に差し替える (未ログインは従来どおり 503)。
3. `src/consultation/consult-startup-watch.ts` (新規): 相談用ディレクトリの claude が起動から 180 秒たっても transcript を
   持たなければ、Cc の system チャンネルへ 1 度だけ知らせる (再ログインのコマンド付き、相談の内容は含めない)。
4. `src/bootstrap/core.ts`: 3 を workflow binding (key `test`) に登録する。

## 受け入れ条件

- [x] 更新用トークンが無い・期限切れの `.credentials.json` では相談の claude を起動しない (503)。アクセストークンの期限切れは起動する。
- [x] 起動から 180 秒たっても transcript が無い相談の claude セッションを 1 度だけ知らせ、相談以外・transcript あり・codex は知らせない。
- [x] spec §6.3 と cc.acceptance.json が実装と一致する。

## 復旧

- 起動前の判定を戻す: `prepareClaudeConfig` を `.credentials.json` の有無に戻す。
- 見張りを止める: workflow binding `consult-startup-watch` を外す (状態は持たない。知らせ済みの記録はメモリだけ)。

## 実施結果

- 検証 (実施): tsc --noEmit エラー 0。vitest — consult-claude-login.test.ts (新規) / consult-startup-watch.test.ts (新規) /
  projectless-consult-launch.test.ts / tests/projectless-consult-spawn.test.ts (仮のログイン情報を更新用トークン付きに更新) が通過。
- 検証 (未実施): 実際にログインが切れた状態での見張りの通知 (再現にはログイン情報を壊す必要があり行わない)。
