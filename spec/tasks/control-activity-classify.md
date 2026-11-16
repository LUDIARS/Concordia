---
task: control-activity-classify
project: Concordia
kind: 実装
status: review
created: 2026-11-17T00:00:00.000Z
source_session: lictor-a3bb0280-f4c5-4975-983a-864d43e82462
memoria_task_id: null
pr_number: null
actio_task_id: a160b379-7713-423b-ae67-944ec9cad852
memory_links: []
---
# 管制の進捗確認を「観測された動き」の分類で作り直す

neco 指示 (2026-11-17)「進捗確認のやり方を根本的に見直せ」「自動確認の更新判定も同じように」「作業が終わったパートはセッション終了」。
前段の PR (自動確認の変化判定を観測された動きにする) の上に、管制側の分類と行動を足す。

### 価値 / 不変条件

- 待つ理由の無いセッションが 20 分以上無活動なら、自動確認の記録の有無にかかわらず停止か応答なしに分類する (CC-CTL-INV-09)。
- 停止へは管制の巡回が自分で追加指示を送り、未返信でも 20 → 40 → 80 分 (上限 2 時間) で再送する。3 回届いて無反応なら応答なしとして名指し報告する。
- 人間待ち・審査待ちには送らない。理由はボードに残す。
- 担当 PR がマージ済みのセッションは、子に限らず案内 → 10 分 → 既存の終了経路で閉じる。人間待ち・未コミットの変更があれば閉じない。

### 仕様

- [spec/feature/control-session.md](../feature/control-session.md) §2 §4 §7 §9、CC-CTL-INV-08 / 09。

### 受け入れ条件

- C-1 classifySession(input): 全員 100 分以上無活動・指紋なしでも、待つ理由の無いものは停止になる (`src/control/session-classify.test.ts`, `src/control-session/patrol.test.ts`)。
- C-2 createControlPatrol(deps).runOnce: 停止へ追加指示を送り、20 / 40 分で再送し、3 回届いて無反応なら応答なしとして 1 回だけ名指し報告する (`src/control-session/patrol.test.ts`)。
- C-3 createChildReaper(deps).runOnce: 担当 PR がマージ済みの standalone を案内 → 10 分後に終了し、人間待ち・未コミットありは閉じない (`src/control-session/reaper.test.ts`)。
- C-4 renderHourlySummary(rows,now,ended): 分類別件数と、停止・応答なし・人間待ち・終了したものを理由付きで 1 件ずつ出す (`src/control-session/hourly-summary.test.ts`)。
- C-5 recordNudgeSkip(repo,log,id,reason,now): 自動確認の見送りを info ログと metadata に残し、ボードの last_skip_reason に写す (`src/control/nudge-skip-record.test.ts`)。
