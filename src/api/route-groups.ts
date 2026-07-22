export interface RouteGroup {
  name: string;
  mount(): void;
}

export function mountRouteGroups(groups: readonly RouteGroup[]): void {
  const names = new Set<string>();
  for (const group of groups) {
    if (!group.name || names.has(group.name)) throw new Error(`duplicate route group: ${group.name}`);
    names.add(group.name);
    group.mount();
  }
}
