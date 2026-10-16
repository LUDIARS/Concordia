# 文脈不明時の自動タイトル維持

Human instruction: neco, 2026-10-16, タイトル変更時にコンテキストを読み取れなかった場合は変更しない。
Actio: `2f7db92d-a189-42ae-b3dd-940ce34a0189`。状態はActioを正本とし、本資料に複製しない。

## 実装内容

Existing session-lifecycle owns current_task; consultation owns public consultation title decisions and the Discord adapter owns delivery records. No new domain, database migration, cloud delegation change or manual rename restriction.
UX-CC-SC-W1 / CC-INV-01/08: preserve a recognizable task name when input is ambiguous, the summarizer fails or a result is stale.
Session automatic naming no longer stores the first input line before summarization. A strict JSON understood=true response is required. Both prompt and consultation summarizers explicitly decline ambiguous context. Latest-request identity and observed-title comparison protect pending results. Pending tokens are removed at settlement; established names survive process restart.

specRefs: `spec/feature/session-prompt-title.md` (`SPEC-SESSION-PROMPT-TITLE`), `spec/feature/consultation-title-summary.md` (`CC-CONSULT-TITLE`), `spec/ux/session-coordination.md`.

## 受け入れ条件

- Null, failure, exception, absent summarizer, malformed/plain prose and understood=false/missing never change the established name.
- A valid understood=true result updates a name, including initial naming.
- A newer ambiguous prompt invalidates older pending output; manually changed names are preserved.
- Public consultation uncertainty produces no rename and no replacement saved record.
- Existing private, fixed-name, ownership and unknown-rename guards remain active.

## 検証と復旧

Production TypeScript check passed. Focused strict TypeScript check of the five naming test files passed. Source/test acceptance mappings updated; diff whitespace check passed.
Unit/integration execution, live model evaluation, service restart and Discord visual verification not performed: no explicit local test/service authorization for this added scope. Runtime regression is submitted to the normal Revisor workflow; no passing result is claimed.
Rollback: revert this change; preserve session rows and existing consultation delivery records. No destructive migration or cleanup.
Limitation: explicit model understanding is a conservative acceptance signal, not proof of semantic correctness; stale automatic results are guarded within the current process and against observed title changes.

## 調査根拠

Baseline main `34e638945d5351bd2441d30bb1b0552cd5607fb1`. Anatomia context and deterministic plan completed; plan hash `d21760a14086416a`. Broad candidates were refined using the existing session-lifecycle and consultation domain membership. Two existing unrelated domain-definition warnings were not modified.
Praeforma project `01M1XZZMEXWTFCN4HKW8K7TJKM` exists; its returned spec list has no matching title specification. Repository feature/UX documents remain the source; no Pf approval is claimed.
