import { BOUNTY_TRIAGE_CALL_NAME } from "../bounty/triage-template.js";
import type { DelegationRepo } from "../db/delegation-repo.js";

export default {
  post(_result: void, repo: DelegationRepo): boolean {
    return repo.findTemplateByCallName(BOUNTY_TRIAGE_CALL_NAME)?.model === "sonnet";
  },
};
