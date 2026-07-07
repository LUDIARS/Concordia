export interface BotRuntimeStatus {
  running: boolean;
  embedded_enabled: boolean;
  last_status: string | null;
  last_error: string | null;
}
