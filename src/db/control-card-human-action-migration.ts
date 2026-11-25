import type { NumberedMigration } from "./migrator.js";

export const controlCardHumanActionMigration: NumberedMigration = {
  version: 161,
  name: "control-card-human-action",
  source: "control_cards.human_action and discord_pending_questions.human_action nullable TEXT v1",
  up(db) {
    db.exec(`
      ALTER TABLE control_cards ADD COLUMN human_action TEXT;
      ALTER TABLE discord_pending_questions ADD COLUMN human_action TEXT;
    `);
  },
};
