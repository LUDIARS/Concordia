import { useEffect, useState } from "react";

import {
  api,
  fmtTs,
  type StaffListResult,
  type StaffMember,
  type StaffPlatform,
  type StaffRole,
} from "../api.js";
import { StaffAddForm } from "./staff/StaffAddForm.js";
import { StaffRoleLegend } from "./staff/StaffRoleLegend.js";

// 社員 (役職権限登録リスト) ページ。
//
// LLM に触れた Discord / Slack ユーザは自動で名簿に載り (既定 = ヒラ社員)、 ここで
// 役職を付けると spawn / end-session / キルスイッチの権限が付く。 判定源は backend の
// staff_members のみ — リアクションワークフロー側に allowlist は無い。
//
// いずれ Cernere の個人データと連携する可能性があるが、 今は Concordia 単独で運用する。

const ROLE_STYLE: Record<StaffRole, string> = {
  staff: "bg-subtle/20 text-subtle",
  manager: "bg-accent/20 text-accent",
  executive: "bg-warn/20 text-warn",
};

const ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: "staff", label: "ヒラ社員" },
  { value: "manager", label: "管理職" },
  { value: "executive", label: "執行役員" },
];

function roleLabel(role: StaffRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function StaffRow({
  member,
  busy,
  onRoleChange,
  onNoteCommit,
  onRemove,
}: {
  member: StaffMember;
  busy: boolean;
  onRoleChange: (role: StaffRole) => void;
  onNoteCommit: (note: string) => void;
  onRemove: () => void;
}) {
  const [note, setNote] = useState(member.note);
  // 他セッションや自動記録で行が入れ替わったらメモ欄も追随させる。
  useEffect(() => { setNote(member.note); }, [member.platform_user_id, member.note]);

  const name = member.profile_name || member.display_name || "(名前未取得)";
  return (
    <tr className="border-b border-border/50">
      <td className="py-1.5 pr-2">
        <div className="text-sm">{name}</div>
        <div className="text-[11px] text-subtle font-mono" title={member.platform_user_id}>
          {member.platform} / {member.platform_user_id}
        </div>
        {member.profile_name && member.display_name && member.profile_name !== member.display_name && (
          <div className="text-[11px] text-subtle">global: {member.display_name}</div>
        )}
      </td>
      <td className="py-1.5 pr-2">
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${ROLE_STYLE[member.role]}`}>
          {roleLabel(member.role)}
        </span>
      </td>
      <td className="py-1.5 pr-2">
        <select
          value={member.role}
          disabled={busy}
          onChange={(e) => onRoleChange(e.target.value as StaffRole)}
          className="foundation-form text-sm"
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </td>
      <td className="py-1.5 pr-2">
        <input
          type="text"
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if (note !== member.note) onNoteCommit(note); }}
          placeholder="メモ"
          className="foundation-form text-sm w-full min-w-32"
        />
      </td>
      <td className="py-1.5 pr-2 text-[11px] text-subtle whitespace-nowrap">
        {fmtTs(member.last_seen_at)}
      </td>
      <td className="py-1.5 text-right">
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          className="text-subtle hover:text-danger text-xs disabled:opacity-40"
          title="名簿から削除 (次の発言で ヒラ社員 として再記録されます)"
        >
          削除
        </button>
      </td>
    </tr>
  );
}

export function Staff() {
  const [data, setData] = useState<StaffListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<StaffPlatform | "all">("all");

  async function refresh() {
    try {
      setData(await api.staffList());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // 自動記録で名簿が増えるので、 開いている間は緩めに追随する。
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, []);

  /** 成否を返す — 手動登録フォームは失敗時に入力を消さないためこれを見る。 */
  async function run(key: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusyId(key);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const members = (data?.members ?? []).filter(
    (member) => platformFilter === "all" || member.platform === platformFilter,
  );
  const counts = data?.counts;
  const totalManagers = counts
    ? counts.discord.manager + counts.slack.manager + counts.discord.executive + counts.slack.executive
    : 0;

  return (
    <div className="max-w-5xl space-y-4">
      <header>
        <h1 className="text-lg font-semibold">社員 (役職権限登録リスト)</h1>
        <p className="text-subtle text-sm mt-1">
          LLM にアクセスした Discord / Slack ユーザを記録し、 役職で権限を決めます。
          登録の無いユーザは会話はできますが、 権限が必要な操作は Deny です。
          {" "}権限判定はここが唯一の正本で、 リアクションワークフロー側に allowlist はありません。
        </p>
      </header>

      {error && <div className="text-danger text-sm">{error}</div>}

      {data && !data.has_executive && (
        <div className="border border-warn bg-warn/10 text-warn rounded p-3 text-xs">
          <div className="font-semibold">執行役員が未登録です</div>
          <div className="mt-1">
            キルスイッチ (サービス起動・再起動) を実行できる人が居ません。 少なくとも 1 人に
            執行役員を割り当ててください。
          </div>
        </div>
      )}

      {data && totalManagers === 0 && (
        <div className="border border-danger bg-danger/10 text-danger rounded p-3 text-xs">
          <div className="font-semibold">管理職以上が 0 人です</div>
          <div className="mt-1">
            セッションの起動 / 終了とリアクションワークフローの発火が全員 Deny になります。
          </div>
        </div>
      )}

      {data && <StaffRoleLegend data={data} />}

      <StaffAddForm
        busy={busyId === "create"}
        onSubmit={(input) => run("create", () => api.staffCreate(input))}
      />

      <div className="flex items-center gap-2 text-xs">
        <span className="text-subtle">platform:</span>
        {(["all", "discord", "slack"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setPlatformFilter(value)}
            className={
              "px-2 py-0.5 rounded border " +
              (platformFilter === value
                ? "border-accent text-accent bg-accent/10"
                : "border-border text-subtle hover:text-text")
            }
          >
            {value === "all" ? "すべて" : value}
          </button>
        ))}
        {counts && (
          <span className="ml-auto text-subtle">
            ヒラ {counts.discord.staff + counts.slack.staff} /
            管理職 {counts.discord.manager + counts.slack.manager} /
            執行役員 {counts.discord.executive + counts.slack.executive}
          </span>
        )}
      </div>

      <section className="bg-surface border border-border rounded p-3">
        {members.length === 0 ? (
          <div className="text-subtle text-sm">
            まだ記録がありません。 Discord / Slack で誰かが発言すると自動で登録されます。
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[11px] text-subtle border-b border-border text-left">
                <th className="pb-1 font-normal">社員</th>
                <th className="pb-1 font-normal">現在の役職</th>
                <th className="pb-1 font-normal">変更</th>
                <th className="pb-1 font-normal">メモ</th>
                <th className="pb-1 font-normal">最終アクセス</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const key = `${member.platform}:${member.platform_user_id}`;
                return (
                  <StaffRow
                    key={key}
                    member={member}
                    busy={busyId === key}
                    onRoleChange={(role) => void run(
                      key,
                      () => api.staffUpdate(member.platform, member.platform_user_id, { role }),
                    )}
                    onNoteCommit={(note) => void run(
                      key,
                      () => api.staffUpdate(member.platform, member.platform_user_id, { note }),
                    )}
                    onRemove={() => {
                      // 役職持ちを誤って消すと権限がその場で消えるので確認を挟む。
                      const label = member.profile_name || member.display_name || member.platform_user_id;
                      if (!window.confirm(`「${label}」(${roleLabel(member.role)}) を名簿から削除しますか?`)) return;
                      void run(key, () => api.staffDelete(member.platform, member.platform_user_id));
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-[11px] text-subtle">
        Cernere (認証・個人データ) との連携は将来検討事項で、 現在は Concordia 単独で運用しています。
      </p>
    </div>
  );
}
