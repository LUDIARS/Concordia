import { createHash, timingSafeEqual } from "node:crypto";
import type { StaffRepo } from "../db/staff-repo.js";
import { roleAtLeast } from "../staff/roles.js";
import type { ConfluxConfig } from "./config.js";

export function confluxIdentity(
  token: string,
  actors: ConfluxConfig["actors"],
  staff: Pick<StaffRepo, "roleOf">,
  organizationExists: (organization: string) => boolean,
) {
  const hash = createHash("sha256").update(token).digest();
  const actor = actors.find((candidate) => timingSafeEqual(hash, Buffer.from(candidate.sha256, "hex")));
  if (!actor || !organizationExists(actor.organizationId)) return null;
  const role = staff.roleOf(actor.platform, actor.userId);
  if (!role) return null;
  const isManager = roleAtLeast(role, "manager");
  return {
    actor_id: `${actor.platform}:${actor.userId}`,
    organization_id: actor.organizationId,
    role,
    roles: role === "executive" ? ["executive", "manager"] : [role],
    is_manager: isManager,
  };
}
