export interface ChatPlatformPost {
  sessionId: string;
  text: string;
  authorLabel?: string | null;
}

export interface ChatPlatformQuestion {
  target_session_id: string;
  question_id: number;
  question: string;
  options: string[];
}

export interface ChatPlatformFrame {
  target_session_id: string;
  kind: string;
  payload: unknown;
  seq?: number;
}

export interface ChatPlatform {
  readonly name: "discord" | "slack";
  stop(): Promise<void>;
  postToSession(input: ChatPlatformPost): Promise<void>;
  ensureSessionSurface(sessionId: string): Promise<void>;
  postQuestion(input: ChatPlatformQuestion): Promise<void>;
  relayFrame(input: ChatPlatformFrame): Promise<void>;
}

export type ChatPlatformStatus =
  | "started"
  | "already_running"
  | "disabled"
  | "stopped"
  | "already_stopped"
  | "error";
