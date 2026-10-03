/** Resident reuse/result invariants, independent of the policy implementation. */
import type {ResidentChild} from "./lifecycle-policy.js";
export default {
  post(result: unknown, child: ResidentChild, input: unknown, generation?: string): boolean {
    if (typeof result === "boolean") return result === (child.state === "busy" && child.current_run_id === input && child.generation === generation);
    if (result !== null) return typeof result === "string";
    const request=input as {parentId:string;repoPath:string;organization:string;branch:string;childActive:boolean;generationMatches:boolean};
    return child.state === "idle" && child.parent_id === request.parentId && child.repo_path === request.repoPath
      && child.organization === request.organization && child.branch === request.branch && request.childActive && request.generationMatches;
  },
};
