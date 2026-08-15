// spawn したチャンネルからチームを決める規則 (spec/feature/teams.md §2)。
//
// 背景: セッションはほぼ workspace root (Castra) から起動されるため、起動後に
// チームを付け替える運用は取りこぼす。 チーム面の中で `/spawn` したなら、その
// チームで作業する意図が確定しているので、契約 seed の時点で帰属させる。
//
// ここは決定だけを行う純関数で、Discord API も DB も直接触らない。 呼び出し側が
// チャンネル階層 (スレッド → 親チャンネル → カテゴリ) を解決して渡す。

/** チャンネル起点のチーム解決に必要な参照。 TeamsRepo がそのまま満たす。 */
export interface TeamChannelLookup {
  findBySurfaceChannelId(channelId: string): { id: string; name: string } | null;
  findByDiscordCategoryId(categoryId: string): { id: string; name: string } | null;
}

/**
 * spawn 元チャンネルの階層。 いずれも不明なら null を渡す。
 *
 * - `channelId`   : `/spawn` が実行されたチャンネル (スレッドならスレッド id)
 * - `parentId`    : スレッドの親チャンネル。 チャンネル直下の実行なら null
 * - `categoryId`  : 最終的な親カテゴリ
 */
export interface SpawnChannelChain {
  channelId: string | null;
  parentId: string | null;
  categoryId: string | null;
}

export interface ResolvedTeamBinding {
  teamId: string;
  teamName: string;
  /** 何を根拠に決まったか。 ログと spawn 応答に出して、暗黙の帰属をユーザから見えるようにする。 */
  via: "surface" | "thread-parent-surface" | "category";
}

/**
 * チャンネル階層からチームを決める。 一致しなければ null (チーム未所属のまま)。
 *
 * 優先順位は「近い面ほど強い」: 実行チャンネル自身が面 → スレッド親が面 →
 * 所属カテゴリ。 セッションフォーラムのスレッド内で実行した場合は 2 番目で当たる。
 */
export function resolveTeamFromChannel(
  lookup: TeamChannelLookup,
  chain: SpawnChannelChain,
): ResolvedTeamBinding | null {
  const bySurface = chain.channelId ? lookup.findBySurfaceChannelId(chain.channelId) : null;
  if (bySurface) return { teamId: bySurface.id, teamName: bySurface.name, via: "surface" };

  const byParent = chain.parentId ? lookup.findBySurfaceChannelId(chain.parentId) : null;
  if (byParent) {
    return { teamId: byParent.id, teamName: byParent.name, via: "thread-parent-surface" };
  }

  const byCategory = chain.categoryId ? lookup.findByDiscordCategoryId(chain.categoryId) : null;
  if (byCategory) return { teamId: byCategory.id, teamName: byCategory.name, via: "category" };

  return null;
}
