import type { CreateTemplateInput } from "../db/delegation-repo.js";

export default {
  post(templates: CreateTemplateInput[]): boolean {
    const daily = templates.find((template) => template.call_name === "ludiars-review-daily-dual")?.prompt_template;
    const duo = templates.find((template) => template.call_name === "review-duo")?.prompt_template;
    return daily?.includes("`claude -p --model opus`") === true
      && daily.includes("`sol` Delegation")
      && duo?.includes("`claude -p --model opus`") === true
      && duo.includes("`sol` Delegation")
      && !/\b(?:claude-opus-[\w.-]+|gpt-[\w.-]+-sol)\b/.test(daily + duo);
  },
};
