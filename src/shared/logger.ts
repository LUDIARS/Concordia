import pino, { type Logger } from "pino";

export const rootLogger: Logger = pino({
  level: process.env.CONCORDIA_LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
});

export function createChildLogger(name: string): Logger {
  return rootLogger.child({ name });
}
