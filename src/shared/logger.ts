import pino, { type Logger, type TransportTargetOptions } from "pino";

// dev 時のみ、 logs/concordia.log に追記する file destination を併設して
// Monitor (tail -F) からの観察を可能にする. NODE_ENV=production / CONCORDIA_LOG_FILE=0
// で無効化できる.
const level = process.env.CONCORDIA_LOG_LEVEL ?? "info";
const fileTargetEnabled =
  process.env.NODE_ENV !== "production" && process.env.CONCORDIA_LOG_FILE !== "0";

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
    options: { destination: "logs/concordia.log", mkdir: true },
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
