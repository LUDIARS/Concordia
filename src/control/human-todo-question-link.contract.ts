/** @implements spec/feature/autonomous-work-continuation.md §2 — 人間のやることの質問リンク (human-todo-link-C-18) */
const URL_SHAPE = /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/;

interface Card { discord_message_id: string | null }

export default {
  post(result: unknown, _deps: unknown, card: Card): boolean {
    if (result === null) return true;
    if (typeof result !== "string") return false;
    const match = URL_SHAPE.exec(result);
    return match !== null && match[3] === card.discord_message_id;
  },
};
