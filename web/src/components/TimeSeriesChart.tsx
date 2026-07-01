/**
 * 依存ライブラリ無しの軽量 SVG 折れ線グラフ。
 *
 * 複数系列を「各系列の最大値で正規化」して重ねる (spent/context/sessions は単位が桁違いに
 * 異なるため、 絶対スケール共有ではなく系列ごとに 0..1 へ畳んで形を比較する)。 凡例に各系列の
 * 実最大値を出す。 X 軸は時刻ラベル (両端のみ)。
 */
import { useMemo, useState } from "react";

export interface ChartSeries {
  label: string;
  color: string;
  values: number[];
  /** 凡例の値整形 (既定は toLocaleString)。 */
  fmt?: (n: number) => string;
}

export interface TimeSeriesChartProps {
  xLabels: string[];
  series: ChartSeries[];
  height?: number;
  maxValue?: number;
}

const W = 720;
const PAD_L = 8;
const PAD_R = 8;
const PAD_B = 18;
const PAD_T = 8;

export function TimeSeriesChart({ xLabels, series, height = 200, maxValue }: TimeSeriesChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const n = xLabels.length;
  const innerW = W - PAD_L - PAD_R;
  const innerH = height - PAD_T - PAD_B;

  const maxes = useMemo(
    () => series.map((s) => maxValue !== undefined ? Math.max(1, maxValue) : Math.max(1, ...s.values)),
    [series, maxValue],
  );
  const xAt = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (v: number, max: number) => PAD_T + innerH - (Math.max(0, v) / max) * innerH;

  if (n === 0) {
    return <div className="text-subtle text-sm py-8 text-center">まだサンプルがありません (10 分毎に記録)。</div>;
  }

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" preserveAspectRatio="none" role="img">
        {/* baseline */}
        <line x1={PAD_L} y1={PAD_T + innerH} x2={W - PAD_R} y2={PAD_T + innerH} stroke="currentColor" className="text-border" strokeWidth={1} />
        {series.map((s, si) => {
          const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v, maxes[si]).toFixed(1)}`).join(" ");
          return <polyline key={s.label} points={pts} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinejoin="round" />;
        })}
        {/* hover guide */}
        {hover !== null && (
          <line x1={xAt(hover)} y1={PAD_T} x2={xAt(hover)} y2={PAD_T + innerH} stroke="currentColor" className="text-subtle" strokeWidth={0.5} strokeDasharray="3 3" />
        )}
        {/* invisible hover targets */}
        {xLabels.map((_, i) => (
          <rect
            key={i}
            x={xAt(i) - innerW / Math.max(1, n) / 2}
            y={PAD_T}
            width={innerW / Math.max(1, n)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-subtle px-1 -mt-1">
        <span>{xLabels[0]}</span>
        <span>{xLabels[n - 1]}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {series.map((s, si) => {
          const cur = hover !== null ? s.values[hover] : s.values[n - 1];
          const f = s.fmt ?? ((x: number) => x.toLocaleString());
          return (
            <span key={s.label} className="inline-flex items-center gap-1 text-subtle">
              <span className="inline-block w-3 h-[2px]" style={{ backgroundColor: s.color }} />
              {s.label}: <span className="text-text">{f(cur ?? 0)}</span>
              <span className="opacity-50">/ max {f(maxes[si])}</span>
            </span>
          );
        })}
        {hover !== null && <span className="text-subtle">@ {xLabels[hover]}</span>}
      </div>
    </div>
  );
}
