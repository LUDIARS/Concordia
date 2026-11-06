import { contract } from './ontime-runtime.js'; /* augur-inject:import:d64bcc9c */
import augurContract_efb22843 from './periodic-progress-guidance.contract.js'; /* augur-inject:contract-predicate:51421340 */
/** @implements spec/feature/periodic-progress-report.md — report meaning, independent of transport. */
export function buildProgressReportGuidance(): string {
  return [
    "[定期進捗報告] 委託または明示ゴールのある依頼の10分連絡です。",
    "依頼者へ通常のセッション報告経路で、依頼全体の概算%・根拠（完了した成果と検証）・残件・次の具体的な作業を短く報告してください。割合が判断できなければ未確認としてください。Cc は経過時間やAI活動量から割合を算出しません。",
    "モニターへの報告書式の正本は skills/session-followup/SKILL.md、採用判定は src/platform/monitor-progress.ts です。依頼者への説明とともに、次の独立した cc-progress ブロックを通常のセッション報告経路へ出してください（例の値は実際の報告に置き換える）。自然文から%を推測して採用する経路はありません。",
    "task は自分の現在の Cc current_task と完全一致させます。自分の Lictor sidecar GET http://127.0.0.1:$LICTOR_PORT/v1/concordia/session からその場で session_id を取得し、Cc の GET /v1/sessions/:id の session.current_task を読んでください。Cc endpoint はサービス所有 excubitor.catalog.yaml から解決します。IDは保存・ログ出力せず、他セッションやActioの題名から推測せず、報告のためにtaskを書き換えません。取得不能・空task・未知percentならブロックを省略し「未確認」と報告します。",
    '```cc-progress',
    '{"task":"取得したsession.current_task","percent":40,"evidence":"完了した成果と検証の根拠","remaining":["同じ依頼の未完了条件"],"complete":false,"at":"報告時の現在UTC ISO"}',
    '```',
    "percent は担当自身の根拠付き数値（0〜100）、evidence は空でない根拠、remaining は残件の文字列配列、complete は依頼全体の完了条件を満たす時だけtrue、at は現在のUTC ISO（例: new Date().toISOString()）です。100%ではcomplete=trueかつremaining=[]が必要です。例の40や時刻をそのまま送らず、古い報告や未来時刻を再利用しません。",
    "100% は当該依頼の完了条件をすべて満たした時だけです。依頼された審査・マージ・必要な反映が残る場合は100%としません。提出で終了する依頼はその完了範囲に従います。",
    "100%未満で人間判断待ちがなく、許可済みで実行可能な残件がある場合は、報告や列挙だけで止めずそのまま実装を続けてください。100%から新しい作業を作りません。",
    "人間待ち・未回答質問・明示OFF/停止・予算/回数/時間上限は維持してください。この連絡は新たな実行許可ではありません。",
    "審査/委託の通知待ちは維持し、ポーリング・重複提出・結果不明の再送・人間待ちへの分類変更で埋めません。同じ依頼の独立した許可済み残件だけを進めます。",
    "この要求の注入は実報告の配達完了ではありません。定期報告に委託の終端status（completed/failed/partial）APIを流用しません。終端報告は依頼の完了条件を確認した別の手順です。",
  ].join("\n");
}
// @ts-expect-error augur-inject
buildProgressReportGuidance = contract(buildProgressReportGuidance, { ...augurContract_efb22843, contractId: 'periodic-progress-C-2', mode: 'observe', sample: 1, where: 'src/control/periodic-progress-guidance.ts:2', rule: 'contract-wrap', id: 'efb22843' }); /* augur-inject:contract-wrap:efb22843 */
