/** Capability and pin observation; no capability validation is claimed by registration. */
import type {ProviderModel,RoleSnapshot} from "./role-policy.js";
export default {
  post(result: {model:ProviderModel | null;reason:string}, input: {current:RoleSnapshot;source:string}): boolean {
    if(input.current.pinned) return result.model === null && result.reason === "manual_pin";
    if(!result.model) return typeof result.reason === "string" && result.reason.length > 0;
    return input.source.startsWith("codex:model/list") && !result.model.hidden
      && new RegExp(`^gpt-\\d+(?:\\.\\d+)?-${input.current.role}$`).test(result.model.modelId)
      && result.model.capabilities.reasoningEfforts.includes("medium")
      && (input.current.role !== "sol" || result.model.capabilities.reasoningEfforts.includes("xhigh"))
      && result.model.capabilities.inputModalities.includes("text");
  },
};
