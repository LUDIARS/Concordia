---
task: teams-discord-runtime-verification
project: Concordia
kind: テスト
created: 2026-08-13
memory_links:
  - spec/feature/teams.md
  - spec/plan/problem_logs/2026-08-13-revisor-516-director-session-fixture.md
---
# Teams Discord 6面と起動時再同期の実環境確認

## 目的

実際の head-office Discord guild でチームのカテゴリと6面が正しく構成され、
Concordia の再起動後も永続化済みIDから同じ面を再利用して重複作成しないことを確認する。

## 完了条件

- Concordia の公開経路から検証用チームを作成すると、対象 guild にカテゴリと
  目標 / タスクボード / コスト / direction / セッションフォーラム /
  タスクフォーラムの6面がそれぞれ1つだけ作成される。
- `teams.discord_category_id` と `team_surfaces` に、実際に作成されたカテゴリ・各面のIDが
  欠落なく保存される。
- Concordia を正規手順で再起動して起動時 reconciliation を走らせても、保存済みIDの
  カテゴリと6面が再利用され、同名または同用途の面が重複作成されない。
- チーム設定またはルールの変更イベントが head-office の所定の面に監査カードとして
  1回だけ投稿され、別 guild には投稿されない。
- 動作確認は Concordia への testing claim 後、Excubitor 経由かつプロジェクト本体
  フォルダだけで行い、終了時に claim を release する。
- 不一致が見つかった場合は、本タスクへ状態を書き戻さず、原因ごとに別の実装タスクを
  `spec/tasks/` へ新規作成する。

## スコープ (編集可ディレクトリ)

- 動作確認のみ (コード編集なし)
