export default {
  post(result: { event_key: string; source: string; kind: string; project_code: string; target_key: string; origin: string; summary: string },
    input: { runId: string; gameId: string; gameTitle: string; outcome: string }): boolean {
    return result.event_key === `ig:playtest-review:${input.runId}` && result.source === "ig"
      && result.kind === "playtest-review" && result.project_code === input.gameId
      && result.target_key === `game/${input.gameId}` && result.origin === "ai"
      && result.summary.length <= 2000 && result.summary.includes(input.gameTitle) && result.summary.includes(input.outcome);
  },
};
