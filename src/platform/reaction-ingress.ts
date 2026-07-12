export type ReactionIngressRoute<Action> =
  | { kind: "workflow"; action: Action; emoji: string }
  | { kind: "unsupported-emoji"; emoji: string }
  | { kind: "prompt" };

export function classifyReactionIngress<Action>(input: {
  text: string;
  normalize?: (text: string) => string;
  classify: (emoji: string) => Action | null;
  isStandaloneEmoji: (text: string) => boolean;
  isNamedEmoji?: (text: string) => boolean;
}): ReactionIngressRoute<Action> {
  const emoji = (input.normalize?.(input.text) ?? input.text).trim();
  const action = input.classify(emoji);
  if (action !== null) return { kind: "workflow", action, emoji };
  if (input.isStandaloneEmoji(emoji) || input.isNamedEmoji?.(input.text) === true) {
    return { kind: "unsupported-emoji", emoji };
  }
  return { kind: "prompt" };
}
