import { useState } from "react";

import type { StaffPlatform, StaffRole } from "../../api.js";

// まだ発言していないユーザへ先に役職を付けるための手動登録フォーム。
// 通常は「発言 → 自動記録 → 役職を付ける」で足りるので、 これは補助口。

const ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: "staff", label: "ヒラ社員" },
  { value: "manager", label: "管理職" },
  { value: "executive", label: "執行役員" },
];

export function StaffAddForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: {
    platform: StaffPlatform;
    platform_user_id: string;
    role: StaffRole;
    display_name?: string;
    note?: string;
  }) => Promise<boolean>;
}) {
  const [platform, setPlatform] = useState<StaffPlatform>("discord");
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<StaffRole>("manager");
  const [note, setNote] = useState("");

  const canSubmit = userId.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    const ok = await onSubmit({
      platform,
      platform_user_id: userId.trim(),
      role,
      display_name: displayName.trim() || undefined,
      note: note.trim() || undefined,
    });
    // 失敗時に入力を消すと user ID を貼り直す羽目になるので、 成功したときだけ空にする。
    if (!ok) return;
    setUserId("");
    setDisplayName("");
    setNote("");
  }

  return (
    <details className="bg-muted/40 border border-border rounded p-3">
      <summary className="text-sm font-medium cursor-pointer">
        手動で登録 — まだ発言していないユーザに役職を先付けする
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-subtle">platform</span>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as StaffPlatform)}
            className="foundation-form text-sm"
          >
            <option value="discord">Discord</option>
            <option value="slack">Slack</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-subtle">user ID</span>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="123456789012345678"
            className="foundation-form text-sm w-56"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-subtle">表示名 (任意)</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="foundation-form text-sm w-40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-subtle">役職</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as StaffRole)}
            className="foundation-form text-sm"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-48">
          <span className="text-[11px] text-subtle">メモ (任意)</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="foundation-form text-sm w-full"
          />
        </label>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-medium disabled:opacity-50"
        >
          登録
        </button>
      </div>
      <p className="text-[11px] text-subtle mt-2">
        Discord の user ID は開発者モードで「IDをコピー」から取れます。 プロファイル名は
        本人が発言した時点で自動取得されます。
      </p>
    </details>
  );
}
