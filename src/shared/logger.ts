import pino, { type Logger, type TransportTargetOptions } from "pino";
import { resolveRotationPolicy, rotateLogFileIfOversize } from "./log-file-rotation.js";

const level = process.env.CONCORDIA_LOG_LEVEL ?? "info";
const logFileMode = process.env.CONCORDIA_LOG_FILE;
const logFilePath = process.env.CONCORDIA_LOG_FILE_PATH?.trim() || "logs/concordia.log";
const fileTargetEnabled =
  logFileMode === "1" || (process.env.NODE_ENV !== "production" && logFileMode !== "0");

// pino が fd を掴む前に世代交代させる (稼働中 rename は Windows で失敗する)。
if (fileTargetEnabled) rotateLogFileIfOversize(logFilePath, resolveRotationPolicy());

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
