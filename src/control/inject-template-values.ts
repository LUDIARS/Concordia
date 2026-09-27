/** One-pass substitution: task content is data, never a second template. */
export function injectSlot(values: Record<string, string>, name: string, value: string): string {
  values[name] = value;
  return `[[CC:${name}]]`;
}

export function renderCapturedInject(template: string, values: Readonly<Record<string, string>>): string {
  const names = [...template.matchAll(/\[\[CC:([^\]]+)\]\]/g)].map((match) => match[1]);
  for (const name of names) {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown Inject placeholder: ${name}`);
  }
  for (const name of Object.keys(values)) {
    if (!names.includes(name)) throw new Error(`Missing Inject placeholder: ${name}`);
  }
  return template.replace(/\[\[CC:([^\]]+)\]\]/g, (_, name: string) => values[name]);
}
