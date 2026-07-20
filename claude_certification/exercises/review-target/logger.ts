import { runtime } from "./config";

export function log(message: string, data?: any) {
  if (runtime.debug == true) {
    console.log("[LOG] " + message, data ?? "");
  }
}

export function audit(entity: any) {
  console.log("[AUDIT] " + JSON.stringify(entity));
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Produce an ISO-8601 timestamp for log lines. */
export function timestamp(): string {
  return new Date().toISOString();
}

/** Format a structured log line as a single string (no side effects). */
export function formatLine(level: LogLevel, message: string): string {
  return `${timestamp()} [${level.toUpperCase()}] ${message}`;
}

export function info(message: string): void {
  console.log(formatLine("info", message));
}

export function warn(message: string): void {
  console.log(formatLine("warn", message));
}

export function error(message: string): void {
  console.log(formatLine("error", message));
}
