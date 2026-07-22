export type ResourceRelease = () => void | Promise<unknown>;

export class ResourceOwner {
  private closed = false;
  private readonly releases: Array<{ name: string; release: ResourceRelease }> = [];

  constructor(private readonly warn: (message: string) => void) {}

  own(name: string, release: ResourceRelease): void {
    if (this.closed) throw new Error(`resource owner already closed: ${name}`);
    this.releases.push({ name, release });
  }

  async closeInOrder(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const resource of this.releases) {
      try { await resource.release(); }
      catch (error) { this.warn(`${resource.name} release failed: ${(error as Error).message}`); }
    }
  }
}
