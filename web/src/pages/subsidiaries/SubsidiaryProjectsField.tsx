import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api } from "../../api.js";

/**
 * @implements spec/feature/subsidiary-delegation.md §3.4
 *
 * 子会社の「関係プロジェクト」設定欄。
 *
 * ここに入れた project の Revisor local PR だけが、その子会社の Test forum に載る。
 * 空 = 未設定は「1 件も載せない」(設定漏れで本社の全 PR が出張先へ漏れるのを防ぐ)。
 * project 名は Concordia の project code registry と同じ表記 (= repo 名)。
 */
export function SubsidiaryProjectsField({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (projects: string[]) => void;
}) {
  const [known, setKnown] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  /** @implements spec/feature/subsidiary-delegation.md §3.4 — registry-backed suggestions. */
  useEffect(() => {
    api.projectCodes()
      .then((r) => setKnown(r.categories.flatMap((c) => c.entries.map(([, project]) => project))))
      // registry が読めなくても自由入力で設定できる。 欄ごと落とさない。
      .catch(() => setKnown([]));
  }, []);

  const selected = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);

  /** @implements spec/feature/subsidiary-delegation.md §3.4 — project-scope editing. */
  function add(project: string): void {
    // 1 欄に複数貼られる運用があるので、 カンマ / 空白 / 改行区切りをまとめて取り込む。
    const parts = project.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
    const next = [...value];
    for (const part of parts) {
      if (!next.some((v) => v.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    onChange(next);
  }
  /** @implements spec/feature/subsidiary-delegation.md §3.4 — project-scope removal. */
  const remove = (project: string) => onChange(value.filter((v) => v !== project));

  /** @implements spec/feature/subsidiary-delegation.md §3.4 — commit a typed project. */
  function commitDraft(): void {
    if (!draft.trim()) return;
    add(draft);
    setDraft("");
  }

  /** @implements spec/feature/subsidiary-delegation.md §3.4 — keyboard project entry. */
  function handleDraftKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitDraft();
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-subtle">
        関係プロジェクト (この子会社の Test フォーラムに載せる PR の範囲。空 = 1 件も載せない)
      </span>
      <div className="flex flex-wrap gap-1">
        {value.length === 0 && <span className="text-[10px] text-subtle">未設定</span>}
        {value.map((project) => (
          <button
            key={project}
            type="button"
            className="rounded bg-ok/20 px-2 py-0.5 text-[11px]"
            title="外す"
            onClick={() => remove(project)}
          >
            {project} ×
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          className="foundation-form flex-1"
          placeholder="プロジェクト名を追加 (カンマ / 空白区切り可)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleDraftKeyDown}
        />
        <button
          type="button"
          className="rounded bg-panel px-2 text-[11px]"
          onClick={commitDraft}
        >
          追加
        </button>
      </div>
      {known.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {known.filter((p) => !selected.has(p.toLowerCase())).map((project) => (
            <button
              key={project}
              type="button"
              className="rounded bg-panel px-2 py-0.5 text-[10px] text-subtle"
              onClick={() => add(project)}
            >
              + {project}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
