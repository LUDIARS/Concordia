import type { SessionsRepo } from "../db/sessions-repo.js";
import { discoverOrbisEndpoint } from "./discovery.js";
import { createOrbisService, type OrbisService } from "./service.js";

/** Secret access stays at the composition boundary; never persist or expose this dependency. */
export function createOrbisRuntime(sessions: Pick<SessionsRepo, "findSession">): OrbisService {
  return createOrbisService({ findSession: id => sessions.findSession(id),
    token: () => process.env.ORBIS_VINCULUM_TOKEN, discover: discoverOrbisEndpoint });
}
