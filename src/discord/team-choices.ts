// `/spawn` の team オプション補完 (spec/feature/teams.md §2)。
//
// team は元々自由入力で、 id か slug を人が覚えて打つ前提だった。 登録済みチームを
// 候補として出し、 値には canonical な id を入れる (slug 改名で spawn が壊れない)。

export interface TeamChoiceRow {
  id: string;
  name: string;
  slug: string;
}

export function toTeamChoices(
  teams: readonly TeamChoiceRow[],
  focused: string,
): Array<{ name: string; value: string }> {
  const needle = focused.trim().toLowerCase();
  return teams
    .filter((team) => {
      if (!needle) return true;
      return team.name.toLowerCase().includes(needle)
        || team.slug.toLowerCase().includes(needle)
        || team.id.toLowerCase() === needle;
    })
    .slice(0, 25)
    .map((team) => ({ name: `${team.name} (${team.slug})`.slice(0, 100), value: team.id }));
}
