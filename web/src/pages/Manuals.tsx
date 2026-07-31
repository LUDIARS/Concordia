import { useState } from "react";

import { HarnessRulesPanel } from "./manuals/HarnessRulesPanel.js";
import { InjectManualsPanel } from "./manuals/InjectManualsPanel.js";

// マニュアルページ。 「AI に何を守らせるか / 何を渡すか」の設定をここ 1 箇所に集約する。
//
//   ハーネスルール   : ガードが依頼を判定するときに参照する allow / block ポリシー
//                      (旧「子会社」ページから移設)
//   Inject マニュアル: delegation で spawn するセッションの協調コンテキストへ
//                      kind 別に差し込む作業マニュアル
//
// どちらも「LLM に注入される自然文」であり、 運用中に一番よく触る設定なので、
// タブ切り替えで並べて詳細に編集できるようにしている。

type Tab = "harness" | "inject";

const TABS: Array<{ id: Tab; label: string; summary: string }> = [
  {
    id: "harness",
    label: "ハーネスルール",
    summary: "ガードが依頼を判定するときの allow / block ポリシー",
  },
  {
    id: "inject",
    label: "Inject マニュアル",
    summary: "spawn するセッションへ kind 別に差し込む作業マニュアル",
  },
];

export function Manuals() {
  const [tab, setTab] = useState<Tab>("harness");
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="space-y-4 max-w-4xl">
      <header>
        <h1 className="text-lg font-semibold">マニュアル</h1>
        <p className="text-subtle text-sm mt-1">
          AI に注入するルールと作業マニュアルの設定。 ハーネスルールは「守らせること」、
          Inject マニュアルは「作業のやり方」を渡します。
        </p>
      </header>

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "px-3 py-1.5 text-sm border-b-2 -mb-px " +
              (tab === t.id
                ? "border-accent text-accent"
                : "border-transparent text-subtle hover:text-text")
            }
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-subtle hidden sm:inline">{active.summary}</span>
      </div>

      {tab === "harness" ? <HarnessRulesPanel /> : <InjectManualsPanel />}
    </div>
  );
}
