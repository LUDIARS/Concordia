/** @implements spec/feature/internal-agent-model-policy.md */
import { suggestForumModel, type ForumModelSuggestionInput } from "../discord/forum-model-suggest.js";
import { forumModelChoices, type ForumModelTemplate } from "./forum-model-selection.js";

/** Reuse the existing policy; never substitute the parent's model. No I/O. */
export function selectInternalAgent(input: Omit<ForumModelSuggestionInput, "choices"> & {
  templates: readonly ForumModelTemplate[];
}) {
  const choices = forumModelChoices(input.templates);
  const suggestion = suggestForumModel({ ...input, choices });
  if (!suggestion) return null;
  const choice = choices.find((item) => item.nick === suggestion.nick)!;
  const template = input.templates.filter((item) => item.is_active
    && item.target_provider === choice.provider && item.model?.trim() === choice.model
    && (item.call_name.toLowerCase() === choice.nick || item.call_name.toLowerCase().startsWith(choice.nick + "-")))
    .sort((a, b) => {
      const rank = (name: string) => name.toLowerCase() === choice.nick ? 0
        : name.toLowerCase() === choice.nick + "-mid" ? 1 : 2;
      return rank(a.call_name) - rank(b.call_name) || a.call_name.toLowerCase().localeCompare(b.call_name.toLowerCase());
    })[0];
  if (!template) return null;
  return { call_name: template.call_name, provider: choice.provider, model: choice.model,
    reasoning_effort: suggestion.effort, reason: suggestion.reason };
}
