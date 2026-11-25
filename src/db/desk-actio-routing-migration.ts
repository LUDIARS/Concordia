import type { NumberedMigration } from "./migrator.js";

export const deskActioRoutingMigration: NumberedMigration = {
  version: 162,
  name: "desk-actio-routing",
  source: "desk_requests Actio project, reference, delivery and retry tracking v1",
  up(db) {
    db.exec(`
      ALTER TABLE desk_requests ADD COLUMN routing_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE desk_requests ADD COLUMN requested_project TEXT;
      ALTER TABLE desk_requests ADD COLUMN project_code TEXT;
      ALTER TABLE desk_requests ADD COLUMN routing_repo TEXT;
      ALTER TABLE desk_requests ADD COLUMN task_reference TEXT;
      ALTER TABLE desk_requests ADD COLUMN previous_session_id TEXT;
      ALTER TABLE desk_requests ADD COLUMN delivery TEXT;
      ALTER TABLE desk_requests ADD COLUMN delivery_at INTEGER;
      ALTER TABLE desk_requests ADD COLUMN routing_issue TEXT;
      ALTER TABLE desk_requests ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX desk_requests_routing ON desk_requests(routing_enabled, retry_at, created_at);
    `);
  },
};
