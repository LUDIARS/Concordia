// 設定値の出所バッジ。「この値はどこから来ているか」を一目で分かるようにする。
// db=サービス内で変更済 / env=env でのみ変更可 / default=コード既定 / none=未設定。

import type { SettingSource } from "../../../api.js";

const STYLES: Record<SettingSource, { label: string; className: string; title: string }> = {
  db: { label: "DB", className: "bg-ok/20 border-ok text-ok", title: "サービス内で設定済み (ここから変更できます)" },
  env: { label: "env", className: "bg-accent/15 border-accent text-accent", title: "env で指定されています" },
  default: { label: "既定", className: "bg-muted text-subtle border-border", title: "コード上の既定値です" },
  none: { label: "未設定", className: "bg-warn/20 border-warn text-warn", title: "どこにも設定がありません" },
};

export function SourceBadge(props: { source: SettingSource; className?: string }) {
  const style = STYLES[props.source];
  return (
    <span
      title={style.title}
      className={`px-2 py-0.5 rounded text-[11px] border ${style.className} ${props.className ?? ""}`}
    >
      {style.label}
    </span>
  );
}
