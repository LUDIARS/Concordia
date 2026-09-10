# Project cwd で共通スキル・メモリの入口が欠落

- Date: 2026-09-10
- Status: fixed in working tree
- Area: Cc new session registration

## Summary / Evidence

necoから、project cwdのセッションにCastraの最低限のスキルとメモリ（session-end等）を
読ませたいとの依頼。対象は「今後の起動のみ」と指定された。
既存のsession-work-policyは共通資料の絶対パスを案内していなかった。
`save-session-log` はディレクトリ型SKILL.mdではなく `.claude/skills/save-session-log.md` に存在した。
memory-recallの `Archived/memory` は現在の配置に存在せず、Castra `.claude/memory-backup` が存在した。
読み取り権限エラーを実際に再現したとは扱わない。旧版で成功した証拠は未確認。

## Cause / Fix Requirements

cwdベースの自動発見と資料の保存形式に依存していた。新規登録時に共通4項目とworkflowに応じた資料だけを探索し、
実在する絶対パスと読み取り指示を作業ポリシーに添える。本文の一括注入・メモリ複製はしない。
古い一律pushを含む既定完了範囲を、Ccが判定する対象workflowに従うPR案内へ訂正する。
necoの追加指示によりRv手順の条件判定はAIに任せず、Ccが登録repoのworkflowから実施する。

## Verification / Follow-up

型検査と差分確認を行う。テスト・起動は実施しない。
審査観点: 新規登録のみの送信、複数rootの混同防止、旧skill形式、未存在/読取拒否、索引だけの選定。
新規セッション内での読了は起動時に当該セッションが確認する。配布成功・読了を現在の段階で捏造しない。
