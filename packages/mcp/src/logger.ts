import pino, { type Logger } from "pino";

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino(
    {
      level,
      base: { service: "patch-cat" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ fd: 2, sync: false }),
  );
}
