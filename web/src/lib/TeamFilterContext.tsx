/**
 * チーム選択のグローバルフィルタ (spec/feature/teams.md §4.2)。
 *
 * ヘッダの <TeamSelect /> で選んだチームを context + localStorage に保持し、
 * Sessions / Taskflow / CostFeed などのページが useTeamFilter() で読む。
 * null = 全チーム (フィルタ無し)。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Team } from "../api.js";
import {
  TEAM_FILTER_STORAGE_KEY,
  readStoredTeamId,
  resolveSelectedTeamId,
} from "./team-filter-core.js";

interface TeamFilterValue {
  teams: Team[];
  teamsLoaded: boolean;
  teamsError: Error | null;
  /** 選択中チーム id (null = 全チーム)。 */
  teamId: string | null;
  team: Team | null;
  setTeamId: (id: string | null) => void;
  reloadTeams: () => void;
}

const TeamFilterContext = createContext<TeamFilterValue | null>(null);

export function TeamFilterProvider({ children }: { children: ReactNode }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [storedId, setStoredId] = useState<string | null>(
    () => readStoredTeamId(readTeamFilterStorage()),
  );
  const [loaded, setLoaded] = useState(false);
  const [teamsError, setTeamsError] = useState<Error | null>(null);
  const requestGenerationRef = useRef(0);

  const reloadTeams = useCallback(() => {
    const generation = ++requestGenerationRef.current;
    setTeamsError(null);
    void api.teamsList()
      .then((result) => {
        if (generation !== requestGenerationRef.current) return;
        setTeams(result.teams);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (generation !== requestGenerationRef.current) return;
        setTeamsError(error instanceof Error ? error : new Error(String(error)));
        setLoaded(true);
      });
  }, []);
  useEffect(() => {
    reloadTeams();
    return () => { requestGenerationRef.current += 1; };
  }, [reloadTeams]);

  const setTeamId = useCallback((id: string | null) => {
    setStoredId(id);
    writeTeamFilterStorage(id);
  }, []);

  // チーム一覧ロード前は保存値をそのまま使う (初回描画のフィルタ剥がれ防止)。
  const teamId = loaded ? resolveSelectedTeamId(storedId, teams) : storedId;
  const value = useMemo<TeamFilterValue>(() => ({
    teams,
    teamsLoaded: loaded,
    teamsError,
    teamId,
    team: teams.find((candidate) => candidate.id === teamId) ?? null,
    setTeamId,
    reloadTeams,
  }), [teams, loaded, teamsError, teamId, setTeamId, reloadTeams]);

  return <TeamFilterContext.Provider value={value}>{children}</TeamFilterContext.Provider>;
}

export function useTeamFilter(): TeamFilterValue {
  const value = useContext(TeamFilterContext);
  if (!value) throw new Error("useTeamFilter must be used within TeamFilterProvider");
  return value;
}

/** ヘッダ常設のチーム選択。 チーム未登録なら描画しない。 */
export function TeamSelect() {
  const { teams, teamsError, teamId, setTeamId } = useTeamFilter();
  if (teamsError) {
    return <span className="text-xs text-danger" title={teamsError.message}>チーム一覧の取得に失敗</span>;
  }
  if (teams.length === 0) return null;
  return (
    <label className="flex items-center gap-1 text-xs text-subtle">
      チーム
      <select
        className="foundation-form text-xs"
        value={teamId ?? ""}
        onChange={(event) => setTeamId(event.target.value || null)}
      >
        <option value="">全チーム</option>
        {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select>
    </label>
  );
}

/** localStorage はブラウザ設定で拒否され得るため、永続化だけを best-effort にする。 */
function readTeamFilterStorage(): string | null {
  try {
    return localStorage.getItem(TEAM_FILTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeTeamFilterStorage(teamId: string | null): void {
  try {
    if (teamId) localStorage.setItem(TEAM_FILTER_STORAGE_KEY, teamId);
    else localStorage.removeItem(TEAM_FILTER_STORAGE_KEY);
  } catch {
    // Storage unavailable: the in-memory selection remains functional for this page lifetime.
  }
}
