export interface PermissionAction {
  sessionId: string;
  requestId: string;
  toolName: string;
  createdAt: number;
}

export type PermissionActionStore = Map<string, PermissionAction>;
