/** A resident marked child is never a completed-run zombie candidate. */
import type {FindZombieRunsInput,ZombieRun} from "./zombie-run-detect.js";
export default {post(result:ZombieRun[],input:FindZombieRunsInput):boolean {
  return result.every(row=>{const session=input.findSession(row.child_session_id);try {
    return !JSON.parse(session?.metadata ?? "{}").cc_resident_child;
  }catch{return true;}});
}};
