import pino, { type Logger, type TransportTargetOptions } from "pino";

const level = process.env.CONCORDIA_LOG_LEVEL ?? "info";
const logFileMode = process.env.CONCORDIA_LOG_FILE;
const logFilePath = process.env.CONCORDIA_LOG_FILE_PATH?.trim() || "logs/concordia.log";
const fileTargetEnabled =
  logFileMode === "1" || (process.env.NODE_ENV !== "production" && logFileMode !== "0");

const targets: TransportTargetOptions[] = [
  process.env.NODE_ENV === "production"
    ? { target: "pino/file", options: { destination: 1 }, level }
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        level,
      },
];
if (fileTargetEnabled) {
  targets.push({
    target: "pino/file",
    options: { destination: logFilePath, mkdir: true },
    level,
  });
}

export const rootLogger: Logger = pino({
  level,
  transport: { targets },
});

export function createChildLogger(name: string): Logger {
  return rootLogger.child({ name });
}
