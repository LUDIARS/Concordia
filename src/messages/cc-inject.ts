/** Transport provenance identifies automation; ordinary Web/Discord input stays human. */
export function isCcInjectSource(source: string | null | undefined): boolean {
  return /^(?:auto:|concordia:|cc:|cc-session-work-policy$|session-work-policy|startup-policy|revisor(?:$|:)|taskflow(?:$|:)|delegation(?:$|:))/.test(source ?? "");
}
