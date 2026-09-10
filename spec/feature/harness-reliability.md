---
title: ハーネスの復旧と適用状況
type: feature
id: CC-HARNESS-RELIABILITY
status: draft
domain: harness-reliability
---

# 利用者に起きる変化

UX-CC-W2/W4/W5、UX-CC-S3/S5: コンパクション後も合意と未回答事項へ戻れ、認証切れと未観測を区別できる。
UX-CC-W3/S4: コミットの存在を契約条件達成と混同しない。

## 所有と不変条件

- HR-01: チェックポイントは Cc が保持する作業状態を即時保存し、読み戻してから保存済みを返す。モデルによる要約待ちを PreCompact に置かない。ネイティブ要約の品質向上を保証しない。
- HR-02: 保存は session ごと、同じ event は重複処理しない。SessionStart(compact) は保存済み参照を短く戻す。未知の項目は不明として残す。引継ぎ内容は権限追加ではない。
- HR-03: MCP認証は実際のフック結果から判定する。401/明示的な認証期限切れと403、ネットワーク、rate limitを区別し、成功を観測するまで回復済みにしない。能動的なprobeは行わない。
- HR-04: MCP応答本文の自称Ccを信頼しない。命令形やclaimという語だけではインジェクションと判定しない。検出は記録と助言のみで、既存の権限ガードを変更しない。
- HR-05: 人間の初動と中間の実プロンプトを時間枠ごとに確率抽出し、上限を設ける。注入文・出所不明の文をユーザー評価へ混ぜない。公式資料の対象provider/modelと版を記録し、文脈不足は判定不能とする。
- HR-06: 任意実行のアプローチ生成は記録上の同じ依頼者・repo・teamの過去30日から最大32標本（直近200session内）を使う。依頼者IDを照合できない場合は当該sessionに限定する。SYSTEM投稿受付とDiscord配送済みを区別する。秘密を含む原文は通知しない。
- HR-07: `/projects` は設定、sessionの関連作業欄は観測時刻・結果・未観測理由を示す。Augurの受入契約とsession作業契約は別物。

状態所有者は reliability がcheckpoint/観測/標本、session-lifecycle が保存API、agent-delegation が完了判定、chat-platforms が配送。I/OはAPIとhook adapterに分離する。

## ハーネス信頼性の実装境界

`src/harness/reliability/` は HR-01～HR-07 の保存・復旧・助言・観測を担う。
`checkpoint.ts` は復旧資料、`guidance.ts` と `advisor.ts` は標本選択と助言、
`ontime-runtime.ts` は挿入契約の観測を担当する。契約述語は同ディレクトリの `contracts/` に置く。
API・bootstrap・session保存adapterはこれらの入口と永続化を接続し、業務条件の所有を移さない。
`SessionHarnessPanel.tsx` は観測、`ProjectCodes.tsx` は必須設定を表示する。
setupの配布スキルと `concordia-ontime.mjs` は、この仕様を導入・検証する定型手順である。

## 検証環境

既存vitestとin-memory SQLiteを使用する。reliability用fixtureでは時刻・乱数・LLM・通知を差し替える。実AI CLI、Discord、Excubitorを呼ばない。新しい定期回帰サービスは導入しない。テスト実行は利用者の許可が必要。

## 復旧と制限

保存失敗はhook stderrとAPIエラーに残す。未対応クライアント/未設定hook/観測なしは不明であり正常ではない。手動clearは保存・投稿失敗で停止し、送信結果不明は自動再送しない。CLIのhook非対応経路は監視できない。

公式資料は2026-09-10確認: https://learn.chatgpt.com/docs/hooks 、https://learn.chatgpt.com/guides/best-practices 、https://developers.openai.com/api/docs/guides/reasoning-best-practices 、https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices 。推奨は強制規則に変換しない。

## 導入とAPI

`GET /v1/setup?provider=claude-code` または `provider=codex-cli` が現在のフック設定を返す。既存設定へマージし、Codexは `.codex/hooks.json` と `/hooks` の信頼確認を使用する。導入した事実と実行観測は別。ターン終了のStopをsession終了と誤認しないようSessionEndを使用する。

フックは `POST /v1/harness/reliability/:sessionId/hook` を呼ぶ。PreCompact/PostCompact/SessionStart(compact) と PostToolUse、ClaudeのPostToolUseFailureを登録する。外部・ホスト側処理がフックを出さない場合は検出不能で、認証監視の常駐probeは導入しない。

進行中の決定事項は `POST .../:sessionId/notes` に `{decisions,next_action,unresolved,artifacts}` を書く。圧縮直前にはその保存済み情報、未回答質問、作業契約、Augur契約の条件、作業記録をまとめる。資料は `GET .../:sessionId/checkpoint` で読める。

`POST .../:sessionId/config-advisory` は観測した設定snapshotを受け取る。`provider` 必須、`model`、`hooks_enabled`、`hook_trust`、`context_window`、`auto_compact_limit`、`hook_events`、`uses_deprecated_codex_hooks` は分かる項目だけ送る。providerがsessionと違えば拒否する。設定ファイル全量や秘密は送らない。全clientの設定を自動抽出する機能ではなく、未送信項目は未確認のまま。

`POST .../:sessionId/approach` または関連作業欄のボタンで、直近標本の依頼者について生成し共通SYSTEMへ投稿する。本社以外は組織別の投稿経路が未設定のため拒否し、他組織へ流さない。生の標本はstatus APIに返さない。分類器停止・未対応providerは評価不能。モデル固有の公式指針が確定していない場合はprovider共通の推奨に限定する。

手動clearの既存送信adapterは配送完了応答を持たないので、資料保存・投稿受付の時点で停止する。通常はネイティブコンパクションを使う。依頼したclearの結果不明は再送せず、SessionStart(clear)を観測した場合に保存済み資料を復旧する。

契約未設定の既存委託は互換性のためbranch証跡のみを確認し、`not_configured` と記録する。契約がある場合は空集計・欠落条件・不一致を拒否する。契約の削除検知を保証する起動時immutable snapshotはこの変更に含まない。

## 追加の固定処理と受入要件

Pf/Anatomiaの機能調査、Actio/Memoriaの作業管理は配布スキルへ誘導する。Pf未登録は従来のrepo内検索。推奨と成功したツール呼び出しの観測は別に記録する。呼び出し観測だけで対象projectや調査結果の正しさを保証しない。

同一ツール失敗3回を固定判定し、復旧手順を案内する。外部更新のtimeout/通信切断/5xxは結果不明として既存ID照合を案内する。無関係な読み取り成功で解消しない。ツール名が未対応なら変更操作と推測しない。

DDD・テスト・オンタイム実装の必須設定はproject_codesが所有する。構造的受入の詳細はproject-harness-policy.md、導入は ../setup/harness-reliability.md。オンタイムはAugur manifest・純粋述語・互換runtime・CLIで完結しLLMを呼ばない。プロセス内表示と永続JSONLレポートを区別する。
