/** Successful public snapshot results are fresh and versioned. */
import type {RoleSnapshot} from "./role-policy.js";
export default {post(result:RoleSnapshot,_snapshot:unknown,now:number):boolean {
  const observed=Date.parse(result.observedAt),expires=Date.parse(result.expiresAt);
  return result.schemaVersion === 1 && Number.isFinite(observed) && observed<=now && expires>now
    && expires>observed && expires-observed<=48*3_600_000;
}};
