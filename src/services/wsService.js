/**
 * WebSocket Service — Real-time event streaming via Socket.IO.
 * Streams job status, action logs, screenshots, and session events
 * to connected dashboard/monitoring clients.
 */
import { Server as SocketIOServer } from "socket.io";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("websocket");

class WsService {
  constructor() {
    this._io = null;
    this._clientCount = 0;
  }

  /**
   * Attach Socket.IO to an existing HTTP server.
   * @param {import("http").Server} httpServer
   */
  attach(httpServer) {
    this._io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      path: "/ws",
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this._io.on("connection", (socket) => {
      this._clientCount++;
      log.info("WebSocket client connected", { id: socket.id, total: this._clientCount });

      // Send welcome message
      socket.emit("connected", {
        message: "MCP Automation WebSocket connected",
        timestamp: new Date().toISOString()
      });

      // Handle client requesting specific room subscriptions
      socket.on("subscribe", (room) => {
        socket.join(room);
        log.debug("Client joined room", { id: socket.id, room });
      });

      socket.on("unsubscribe", (room) => {
        socket.leave(room);
      });

      // Handle ping (keep-alive)
      socket.on("ping", () => {
        socket.emit("pong", { timestamp: new Date().toISOString() });
      });

      socket.on("disconnect", (reason) => {
        this._clientCount--;
        log.info("WebSocket client disconnected", { id: socket.id, reason, total: this._clientCount });
      });
    });

    log.info("WebSocket service attached to HTTP server");
  }

  /**
   * Broadcast an event to all connected clients.
   * @param {string} event - Event name
   * @param {object} data - Event data
   */
  broadcast(event, data) {
    if (!this._io) return;
    this._io.emit(event, {
      ...data,
      timestamp: data.timestamp || new Date().toISOString()
    });
  }

  /**
   * Send event to clients in a specific room (e.g., a session).
   * @param {string} room - Room name (usually sessionId)
   * @param {string} event - Event name
   * @param {object} data - Event data
   */
  toRoom(room, event, data) {
    if (!this._io) return;
    this._io.to(room).emit(event, {
      ...data,
      timestamp: data.timestamp || new Date().toISOString()
    });
  }

  // ─── Convenience Methods ──────────────────────────────────

  /** Stream a job status update. */
  jobUpdate(jobId, status, data = {}) {
    this.broadcast("job:update", { jobId, status, ...data });
  }

  /** Stream an action log entry. */
  actionLog(entry) {
    this.broadcast("action:log", entry);
    if (entry.sessionId) {
      this.toRoom(entry.sessionId, "session:action", entry);
    }
  }

  /** Stream a screenshot (as base64 or path). */
  screenshotTaken(sessionId, screenshotData) {
    this.toRoom(sessionId, "session:screenshot", {
      sessionId,
      ...screenshotData
    });
    this.broadcast("screenshot:taken", {
      sessionId,
      url: screenshotData.url,
      path: screenshotData.path
    });
  }

  /** Stream session lifecycle events. */
  sessionEvent(sessionId, event, data = {}) {
    this.broadcast(`session:${event}`, { sessionId, ...data });
  }

  /** Stream self-healing events. */
  healingEvent(data) {
    this.broadcast("healing:attempt", data);
  }

  /** Stream error events. */
  errorEvent(error) {
    this.broadcast("error", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }

  /** Get connection stats. */
  getStats() {
    return {
      active: this._io !== null,
      clients: this._clientCount,
      rooms: this._io ? Array.from(this._io.sockets.adapter.rooms.keys()).length : 0
    };
  }
}

export const wsService = new WsService();
