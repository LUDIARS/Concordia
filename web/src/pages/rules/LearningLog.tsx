import { fmtSec, type LearningRunView, type LearningSourceView } from "./rules-api.js";

// 巡回ルールの学習の記録 (spec/feature/patrol-chat.md 「学習の記録」)。 1 日 1 行で、 結果・要約・実際に変えた設定を見せる。

const STATUS_LABEL: Record<LearningRunView["status"], string> = {
  applied: "反映した",
  skipped: "見送り",
  rejected: "却下",
  failed: "失敗",
};

const CHANGE_LABEL: Record<string, string> = {
  prefer_genres: "優先するジャンル",
  prefer_ratio: "優先の割合",
  tick_sec: "投稿の間隔 (秒)",
  root_limit_per_day: "1 日の投稿上限",
  learned_instructions: "学んだ方針",
  learned_keywords: "関心のある言葉",
  topic_keywords: "話題の言葉",
};

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("、");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const quote = (text: string | null) => (text === null ? "(発言は残っていません)" : `「${text}」`);

function SourceItem({ source }: { source: LearningSourceView }) {
  if (source.kind === "message") {
    return (
      <li>
        発言 {quote(source.text)}
        {source.reply_to_text !== null && <span className="text-subtle"> ← 返信先 {quote(source.reply_to_text)}</span>}
      </li>
    );
  }
  const n = (key: string) => (typeof source.signal?.[key] === "number" ? (source.signal[key] as number) : 0);
  return (
    <li>
      投稿 {quote(source.text)}
      <span className="text-subtle"> (返信 {n("replies")} 件・反応 {n("reactors")} 人、 良い {n("fine")} / 悪い {n("bad")})</span>
      {source.replies.length > 0 && (
        <ul className="pl-3">{source.replies.map((r, i) => <li key={i}>返信 {quote(r)}</li>)}</ul>
      )}
    </li>
  );
}

interface Props {
  ruleId: string;
  runs: LearningRunView[];
  onClose: () => void;
}

export function LearningLog({ ruleId, runs, onClose }: Props) {
  return (
    <section className="border border-border rounded p-3 space-y-2 text-sm" data-testid="rule-learning">
      <h3 className="font-semibold">学習の記録: {ruleId}</h3>
      {runs.length === 0 && <p className="text-xs text-subtle">まだ学習していません (毎日 4 時以降に 1 回学習します)。</p>}
      <ul className="space-y-2">
        {runs.map((run) => {
          const summary = typeof run.proposal?.summary === "string" && run.proposal.summary ? run.proposal.summary : null;
          return (
            <li key={run.run_id} className="text-xs border-t border-border pt-1" data-testid={`learning-${run.day}`}>
              <div className="font-medium">{run.day} · {STATUS_LABEL[run.status] ?? run.status} · 断片 {run.fragment_count} 件{run.revision !== null ? ` · rev ${run.revision}` : ""}</div>
              {summary && <div>要約: {summary}</div>}
              {run.reason && run.reason !== summary && <div className="text-subtle">理由: {run.reason}</div>}
              {run.applied && Object.keys(run.applied).length > 0 && (
                <ul className="pl-3 list-disc">
                  {Object.entries(run.applied).map(([key, value]) => (
                    <li key={key}>{CHANGE_LABEL[key] ?? key}: {formatValue(value)}</li>
                  ))}
                </ul>
              )}
              {run.sources && run.sources.length > 0 && (
                <details>
                  <summary className="cursor-pointer">学習に使った会話 ({run.sources.length} 件)</summary>
                  <ul className="pl-3 space-y-1" data-testid={`learning-sources-${run.day}`}>
                    {run.sources.map((s, i) => <SourceItem key={i} source={s} />)}
                  </ul>
                </details>
              )}
              <div className="text-subtle">{fmtSec(run.created_at)}</div>
            </li>
          );
        })}
      </ul>
      <button type="button" className="text-xs underline" onClick={onClose}>閉じる</button>
    </section>
  );
}
