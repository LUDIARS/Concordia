---
task: curiosity-walk
project: Concordia
kind: 実装
status: todo
created: 2026-08-20T00:00:00.000Z
source_session: lictor-14618068-9b0b-4762-88da-1084e623df0d
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# 散歩セッション — ランダムな組み合わせと他サービスへの興味から問いを起こす

設計正本: `spec/feature/curiosity-walk.md`。
双子の機能: `spec/feature/director-inquiry-session.md` (決定を得る問い / こちらは決定を求めない問い)。

## 目的

1 日数回のランダムなタイミングで、互いに関連の薄い 2 件 (原則として別サービス) を引き、
片方の制約をもう片方に当てるとどうなるかを 1 投稿だけ書かせる。外れることが仕様なので、
質問カードでなく流れて消える面に出す。

## 完了条件

- [ ] `src/curiosity/scheduler.ts` — 活動時間 1 日あたり平均 λ=2.5 回のポアソン間隔 +
      活動時間帯 (既定 10:00-22:00 JST) の supervised timer。待ち時間は活動時間で数え、
      時間帯外へ掛かる分は次の活動時間帯へ繰り越す。等間隔にしない。
      workflow binding key は `curiosity`、**既定 OFF**。
- [ ] `src/curiosity/material.ts` — 素材の遠さ重みつきサンプリング。
      源 = 別リポの spec/feature・spec/tasks、直近マージ local PR、director case の
      goal/handoff_note、Excubitor カタログの稼働サービス。
      遠さ = 別リポ最優先 → Anatomia ドメイン差 (`.anatomia/domains/*.json`、
      取れなければリポ差で代替) → 直近 N 日に使った組み合わせの種類を避ける。
- [ ] `src/curiosity/instruction.ts` — 出力の型を固定した指示テンプレート
      (2 件の紹介 / 移す制約を 1 つ名指し / 結果 3 行以内・要否の結論は書かない /
      答えなくてよい問いを 1 つ)。
- [ ] 起動は `CONCORDIA_CURIOSITY_CALL_NAME` (未設定時 `claude-sonnet-5-walk`) で解決した
      delegation、options `{ goal_and_go: false }`。prompt と harness で読み取り専用を強制し、
      編集・commit・push・PR・テスト・サービス制御・追加 delegation を拒否する。
- [ ] 出力先はぼやきチャンネル (無ければ chitchat)。
      **`discord_pending_questions` を作らないことをテストで固定する** (spec §3 の成立条件)。
- [ ] `walk_id` と `(repo_a, repo_b, domain_a, domain_b)` を永続化し、無反応が続いた
      種類の重みを下げ、反応があった種類の重みを上げる (個々の外れは罰しない)。
- [ ] 参照率の計測 — spec / spec/tasks / local PR から `walk_id` が参照されたかを数え、
      1 投稿あたりのコストとともに cost-observability に出す。自動停止はしない。
- [ ] 単体テスト: 間隔が等間隔でないこと / 時間帯外に起動しないこと / 別リポが優先されること /
      出力が 1 投稿で質問カードを作らないこと / 重み減衰 / toggle OFF で何も登録されないこと。

## スコープ (編集可ディレクトリ)

- `src/curiosity/` (新設)
- `src/workflow/` (binding key `curiosity` の登録、既定 OFF)
- `src/db/` (walk_id と組み合わせ重みの migration)
- `spec/feature/curiosity-walk.md` (status を implemented へ更新)
- `spec/setup/config-reference.md` (`CONCORDIA_CURIOSITY_CALL_NAME` の既定値と用途)

## 非対象

- 決定の取得・タスク化・実装・PR 作成の自動化。
- direction 面 / 質問カード / 催促タイマーの使用。
- Cc 側での本文生成。
