import type { CreateTaskInput, MemoriaClient } from "../memoria/client.js";

export interface TaskBackend {
  createTask(input: CreateTaskInput): Promise<{ id: string | number }>;
}

/** Phase 4 で ActioBackend を追加する。現時点では Memoria のみを実装する。 */
export class MemoriaBackend implements TaskBackend {
  constructor(private readonly client: MemoriaClient) {}
  async createTask(input: CreateTaskInput): Promise<{ id: string | number }> {
    return this.client.createTask(input);
  }
}
