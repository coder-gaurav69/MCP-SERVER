/**
 * Structured logging service using Winston.
 * Provides file + console transports with JSON formatting.
 * All services import `logger` from here for consistent logging.
 */
import winston from "winston";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";

const LOG_DIR = path.resolve(config.logsDir || "src/.ai_outputs/logs");

// Ensure log directory exists synchronously at import time
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const svc = service ? `[${service}]` : "";
    const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${svc} ${message}${extra}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  defaultMeta: { service: "mcp-server" },
  format: logFormat,
  transports: [
    // All logs → combined.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 3
    }),
    // Errors only → error.log
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3
    }),
    // Console (stderr to avoid polluting MCP STDIO)
    new winston.transports.Console({
      format: consoleFormat,
      stderrLevels: ["error", "warn", "info", "debug"]
    })
  ]
});

/**
 * Create a child logger for a specific service/module.
 * @param {string} serviceName
 * @returns {winston.Logger}
 */
export function createServiceLogger(serviceName) {
  return logger.child({ service: serviceName });
}

/**
 * Action log entry — structured record of every browser action.
 * These are stored in-memory per session AND written to the action log file.
 */
const actionLogTransport = new winston.transports.File({
  filename: path.join(LOG_DIR, "actions.log"),
  maxsize: 10 * 1024 * 1024,
  maxFiles: 5
});

const actionLogger = winston.createLogger({
  level: "info",
  format: logFormat,
  defaultMeta: { service: "action-log" },
  transports: [actionLogTransport]
});

/**
 * Log a structured browser action.
 */
export function logAction(entry) {
  actionLogger.info("action", {
    action: entry.action,
    sessionId: entry.sessionId || "unknown",
    selector: entry.selector || "",
    result: entry.result || "unknown",
    retryCount: entry.retryCount || 0,
    duration: entry.duration || 0,
    error: entry.error || "",
    metadata: entry.metadata || {},
    timestamp: entry.timestamp || new Date().toISOString()
  });
}

export { logger };
export default logger;
