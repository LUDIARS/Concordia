# 委託子の質問が親と人間へ同時配信され、親のリレー回答が弾かれる

- Date: 2026-09-05
- Status: resolved (本 PR: 親一次受け + エスカレーション経路)
- Area: Concordia delegation (親子 Question リレー) × pending question / Discord カード
- Severity: 中。親が指示どおり回答しても `already_answered` で弾かれ、委託の自律性が成立しない。人間が気付かなければ委託が停滞する

## Summary

委託子セッションの質問 (`POST /v1/sessions/:id/pending-question`) が、**親 (委託元) への
リレーと人間向け Discord カードの両方へ同時に配信**されていた。

質問行は 1 本しかないため、先に答えた側が確定して `answered_at` が立つ。リレー本文には
「委託元として回答してください」と書かれているのに、人間が先にカードへ回答していると、
その指示に従った親は `already_answered` (409) で弾かれる。

409 の応答は `error` 文字列だけで確定内容を返さないため、親は「自分の回答が採用されな
かったのか」「そもそも別の答えで確定していたのか」すら切り分けられず、異常として扱って
停止するか、誤った前提で続行するかのどちらかになっていた。

## Evidence

- `src/api/sessions/qa.ts` の pending-question ハンドラは、`question.posted` の emit
  (人間向け Discord カード) と親セッションへの inject リレーを**無条件で両方**実行していた
- `src/control/answer-question.ts` は `row.answered_at !== null` で一律
  `{ ok: false, status: 409, error: "already_answered" }` を返すだけで、確定内容を含まない
- `buildDelegationQuestionRelayText` の本文は「自分で判断できない場合は ask マーカーで
  人間へ引き継いでください」と案内していた。しかし ask マーカーで聞き直すと**子の質問と
  人間の回答が別 id になり結び付かない**ため、子は元の質問を待ち続ける

## Regression Context

- 親子リレー自体は「子で権限承認・確認が必要なものは親セッション経由でやりとりする」
  (`spec/feature/delegation-coordination.md` §5) の実装として後から足された経路
- 足す際に**人間向け配信を止めていない**のが本質。両方に出せば「どちらでも答えられる」
  ように見えるが、行が 1 本である以上は先着 1 名しか確定できない
- persona-context の「親に聞け」という指示は文面としてはあったが、API がそれを裏付けて
  いなかった (親が答えても弾かれうる)

## Cause

主因 (確度 高): **一次受けが二重**。委託質問の宛先を親に一本化せず、人間向けカードも
同時に出していた。競合は設計上必ず起きる。

副因 (確度 高): 409 が確定内容を返さないため、競合が起きたときに親が状況を判定できない。

## Fix Requirements

1. **親一次受け**: run が解決できる委託質問は親にだけ配信し、人間向け `question.posted` は
   発火させない。行に `parent_session_id` を持たせ、非 null = 人間未配信の印とする
2. **明示エスカレーション**: 親が裁けないときの逃げ道として
   `POST /v1/sessions/:id/escalate-question { question_id, note? }` を追加し、**元の
   question 行のまま**人間へ配信し直す。ask マーカーで聞き直させない。二重配信は
   `escalated_at` の条件付き UPDATE で防ぐ
3. **自動エスカレーション**: 親が裁かないまま猶予 (既定 300 秒) を過ぎた質問を人間へ
   自動で上げる。親一次受けにすると「親が裁かなければ誰も気付かない」穴が新しく開くため、
   同じ変更の中で塞ぐ。`0` 以下で無効化でき、無効時はリレー本文でもそう案内する
4. **409 に確定内容を添える**: `answered_at` / `answer_index` / `answer_text` を返し、親が
   「自分の回答が採用されなかった」と「別の答えで既に確定していた」を切り分けられるようにする

## Verification

- `src/control/question-escalation.test.ts` — 元の行のまま配信 / note の付与 / 二重
  エスカレーション抑止 / 猶予判定 / 猶予 0 での無効化 / 1 件失敗時の継続 / `multi_select` の保持
- `src/db/discord-repo.test.ts` — `parent_session_id` の記録、`markEscalated` が 1 度だけ
  true、回答済みは対象外、`listStaleParentRelayed` の抽出条件
- `src/control/answer-question.test.ts` — 409 が確定内容を伴うこと
- `src/delegation/coordination.test.ts` — リレー本文が escalate-question を案内すること

人間向けカードが実際に 1 枚だけ出ること (Discord 面) は自動テストの範囲外で、実運用の
委託 run で確認する必要がある。

## Follow-up

- 親セッションが既に終了している委託質問は、猶予を待たず即座に人間へ上げてよいかを検討する
  (現状は一律で猶予待ち)
