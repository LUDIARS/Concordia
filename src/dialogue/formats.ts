/**
 * ユースケースのフォーマット (雛形)。 作成時の初期値だけを与え、 作成後の値は
 * ユースケース側が正 (フォーマットを変えても既存ユースケースは書き換わらない)。
 *
 * @implements spec/feature/dialogue-context.md §2
 * @implements SPEC-DLG-FORMATS
 */

export type UseCaseWorkMode = "edit" | "read-only";

export interface UseCaseFormat {
  key: UseCaseFormatKey;
  name: string;
  workMode: UseCaseWorkMode;
  useRequesterProfile: boolean;
  /** 回答前に事前ヒアリング (知りたいこと・技術レベル・役職・目的) を揃えるか (tech-consultation.md §3)。 */
  intake: boolean;
  summary: string;
  preData: string;
}

export const USE_CASE_FORMAT_KEYS = ["chores", "qa", "sparring", "research-report"] as const;
export type UseCaseFormatKey = typeof USE_CASE_FORMAT_KEYS[number];

export const USE_CASE_FORMATS: Readonly<Record<UseCaseFormatKey, UseCaseFormat>> = {
  chores: {
    key: "chores",
    name: "雑用",
    workMode: "edit",
    useRequesterProfile: false,
    intake: false,
    summary: "依頼された作業を何でも引き受ける。実装・調査・整理のどれでもよい。",
    preData: [
      "- 依頼の対象と完了の形を最初に確認し、分からない点だけを質問する。",
      "- 作業後は、何をしたか・何が残っているかを短く報告する。",
    ].join("\n"),
  },
  qa: {
    key: "qa",
    name: "一問一答 Q&A",
    workMode: "read-only",
    useRequesterProfile: true,
    intake: true,
    summary: "投げられた質問に回答を返す。コードやファイルは変更しない。",
    preData: [
      "- 結論を先に 1〜3 行で書き、その後に理由と具体例を続ける。",
      "- 依頼者の技術者レベルに合わせて用語の説明量を変える。",
      "- 確かでないことは確かでないと書き、推測で断定しない。",
      "- 回答したら追加の質問を待つ。自分から作業を広げない。",
    ].join("\n"),
  },
  sparring: {
    key: "sparring",
    name: "壁打ち相談",
    workMode: "read-only",
    useRequesterProfile: true,
    intake: true,
    summary: "依頼者の考えの整理に付き合い、論点と選択肢を一緒に詰める。",
    preData: [
      "- まず依頼者の目的と制約を言い直して確認する。",
      "- 選択肢を並べるときは、それぞれの利点・欠点・向く状況を示す。",
      "- 決めるのは依頼者。推奨を出すときは理由を添える。",
    ].join("\n"),
  },
  "research-report": {
    key: "research-report",
    name: "調査レポート",
    workMode: "read-only",
    useRequesterProfile: false,
    intake: false,
    summary: "指定された事柄を調べ、根拠付きの報告を返す。",
    preData: [
      "- 調べた範囲と調べていない範囲を分けて書く。",
      "- 主張ごとに根拠 (ファイル・行・資料) を示す。",
      "- 最後に要点を 3 行でまとめる。",
    ].join("\n"),
  },
};

export function isUseCaseFormatKey(value: string): value is UseCaseFormatKey {
  return (USE_CASE_FORMAT_KEYS as readonly string[]).includes(value);
}
