export type ModelTierChoice = "" | "ultra" | "high" | "medium" | "low";
export function ModelTierSelect({ value, onChange }: { value: ModelTierChoice; onChange: (value: ModelTierChoice) => void }) {
  return <label className="text-sm space-y-1 col-span-2">
    <span>モデルの水準</span>
    <select className="foundation-form w-full" value={value} onChange={e => onChange(e.target.value as ModelTierChoice)}>
      <option value="">指定モデルを優先（使用枠が尽きた場合は代替）</option>
      <option value="ultra">超高</option><option value="high">高</option>
      <option value="medium">中</option><option value="low">低</option>
    </select>
    <span className="block text-xs text-subtle">選んだ水準の中から、使用枠に余裕のあるモデルを割り当てます。</span>
  </label>;
}
