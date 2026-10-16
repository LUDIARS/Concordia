export const meta = {
  name: 'ludiars-verify',
  description: 'Adversarially verify batches of design-review findings with two lenses each',
  phases: [{ title: 'Verify', detail: 'evidence lens + counter-argument lens per batch' }],
}

function requiredPath(key) {
  const value = args?.[key]
  if (typeof value !== 'string' || !value.trim() || !/^(?:\/|[A-Za-z]:[\\/])/.test(value)) {
    throw new Error(`args.${key} must be an absolute path`)
  }
  return value.replace(/\\/g, '/').replace(/\/$/, '')
}
const ROOT = requiredPath('root')
const WF = requiredPath('wf')

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    verdicts: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      verdict: { type: 'string', description: 'confirmed | weakened | refuted' },
      evidenceChecked: { type: 'array', items: { type: 'object', properties: {
        file: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } }, required: ['file', 'ok'] } },
      corrections: { type: 'string', description: '主張・根拠・数字の訂正 (無ければ空)' },
      counterArgument: { type: 'string', description: '意図的な分離や方針 (SRP / 個人データ / 依存ゼロ / セキュリティ境界) で正当化できるか。できるなら所見は weakened/refuted' },
      adjustedSeverity: { type: 'string' },
      implementNowOk: { type: 'boolean', description: 'implementNow.feasible=true の所見について、本当に単一リポ・無害・検証可能か' },
      implementNowNote: { type: 'string' },
      proposalCritique: { type: 'string', description: '提案の過不足。より小さく/大きくすべきか、別案が良いか' },
    }, required: ['id', 'verdict', 'evidenceChecked', 'adjustedSeverity', 'implementNowOk'] } },
  },
  required: ['lens', 'verdicts'],
}

const COMMON = `
背景: ${ROOT}/ 配下に LUDIARS の AI 開発支援ツール 9 リポ (Actio, Anatomia, Augur, Breviarium, Concordia, Conflux, Genius, Praeforma, Revisor)。設計レビューの所見 (ドメイン重複・コード重複・管理負荷・ボトルネック・統合トポロジ・即効改善) を反証検証する。
あなたは懐疑的な検証者。所見を信じず、引用されたファイルを実際に開いて確認する (node_modules / dist は読まない)。不確かなら confirmed にしない。補助資料: ${WF}/map-*.json (リポ別マップ), ${WF}/notes-fable.md。
出力は日本語、生データ (前置き不要)。`

phase('Verify')
const batches = args.batches
if (!Array.isArray(batches) || !batches.length || batches.some(b => !b || typeof b.name !== 'string'
  || !b.name.trim() || !Array.isArray(b.findings) || !b.findings.length)
  || new Set(batches.map(b => b.name)).size !== batches.length) throw new Error('Invalid args.batches')
const out = await parallel(batches.map((b, i) => () =>
  parallel([
    () => agent(`${COMMON}
レンズ: 根拠検証。各所見の evidence (リポ/ファイル:行) を開き、主張どおりの内容か、行番号は妥当か、数字 (行数・件数・秒数・ポーリング間隔) は正しいかを確認する。根拠が 1 つでも誤っていれば corrections に書き、致命的なら weakened/refuted。claim に含まれる「既に直っている」可能性 (git log / 現行コード) も確認する。
所見バッチ (${b.name}):
${JSON.stringify(b.findings, null, 1)}`, { label: `verify:evidence:${b.name}`, phase: 'Verify', schema: VERDICT_SCHEMA }),
    () => agent(`${COMMON}
レンズ: 反論と提案批評。各所見について (1) その重複/分離/遅さが「意図的で正当」(SRP、個人データ非保管、依存ゼロ方針、セキュリティ境界、サービスの独立配備、Node 版差、過去の障害記録 spec/plan/problem_logs) である証拠をリポ内で探す。見つかれば weakened/refuted。(2) 提案が過剰 (大改造で見返りが薄い) か過小 (根本原因に届かない) かを批評し、より良い案があれば書く。(3) implementNow.feasible=true の所見は、変更が単一リポで閉じるか・振る舞いを変えないか・既存テストで検証できるかを、対象ファイルを開いて判定する。
所見バッチ (${b.name}):
${JSON.stringify(b.findings, null, 1)}`, { label: `verify:counter:${b.name}`, phase: 'Verify', schema: VERDICT_SCHEMA }),
  ]).then(vs => {
    if (vs.length !== 2 || vs.some(v => !v)) throw new Error(`Missing verification lens: ${b.name}`)
    return { batch: b.name, evidence: vs[0], counter: vs[1] }
  })
))
if (out.length !== batches.length || out.some(v => !v)) throw new Error('Missing verification batch')
log(`verified batches: ${out.length}/${batches.length}`)
return out
