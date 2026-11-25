import type Database from "better-sqlite3";

export default {
  post(_result: void, db: Database.Database): boolean {
    const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").pluck().get();
    const names = db.prepare("SELECT name FROM schema_migrations WHERE version IN (161, 162) ORDER BY version").pluck().all();
    return version === "162"
      && names.join(",") === "control-card-human-action,desk-actio-routing"
      && db.prepare("SELECT human_action FROM control_cards LIMIT 0").reader
      && db.prepare("SELECT human_action FROM discord_pending_questions LIMIT 0").reader
      && db.prepare("SELECT task_reference FROM desk_requests LIMIT 0").reader;
  },
};
