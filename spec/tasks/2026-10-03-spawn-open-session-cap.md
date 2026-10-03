---
task: 2026-10-03-spawn-open-session-cap
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
actio_reference: actio:5e4543c8-0a2d-412c-8532-075deb210a00
---
# spawn の権限承認をなくし、会社ごとの同時セッション上限を設けてコスト画面に出す

設計正本: `spec/feature/staff-roster.md` §3、`spec/feature/usage-budgets.md` §9、
`spec/feature/subsidiary-delegation.md` §3.1、`spec/feature/tech-consultation.md` §3/§4、
`spec/feature/test-forum-controls.md` §5。
タスク本文は Actio (`actio:5e4543c8-0a2d-412c-8532-075deb210a00`) を参照する。

## 分解

1. 起動の承認をなくす: `session_spawn` の最低役職をヒラ社員にし、`/spawn` の執行役員一回許可
   (`spawn-approval.ts`) と Session forum の管理職承認カード (`forum-spawn-approval.ts`) を削除する。
2. 起動以外の運用操作を分ける: effort 変更・プラン判断・訂正・`/project-code add`・Test forum の実行設定・
   ドメインレビュー回答・管理面を新しい `session_control` (管理職以上) に付け替える。
   🛠️ `add-as-workflow` は `merge_pr` で閉じ、reaction workflow の readiness は `merge_pr` の人数で数える。
3. 会社ごとの同時セッション上限: 本社は admin 設定 (既定 30)、子会社は `subsidiaries.max_sessions`
   (migration 127、0 = 上限なし)。`/v1/admin/spawn-session`・`/v1/delegation/invoke` (spawn)・`/v1/spawn` で判定し、
   上限以上なら 429 `session_cap_reached:` で断る。Session forum は理由を投稿者へ返す。
4. コスト画面: `GET /v1/cost/session-caps` と Cost 画面の「稼働数 / 上限」欄、子会社設定の上限入力欄。
5. 仕様・台帳: 上記 spec、`cc.acceptance.json`、Augur 契約 `cap-C-1`〜`cap-C-3`、テスト台帳。

## 完了条件

- [x] 1〜5 の実装と、同じ変更での単体・API・Web テスト。
- [x] spec・`cc.acceptance.json`・Augur 契約とテスト台帳。
- [ ] テストの実行 (未指示のため未実施。Revisor の審査で実行される)。
- [ ] 反映後、ヒラ社員の `/spawn` とフォーラム投稿が承認なしで起動し、本社の稼働が 30 本に達すると断られ、
      Cost 画面に会社ごとの「稼働数 / 上限」が出ることを確かめる (親セッション / 人)。
