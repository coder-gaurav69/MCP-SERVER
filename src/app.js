import express from "express";
import morgan from "morgan";
import browserRoutes from "./routes/browserRoutes.js";
import { failure } from "./utils/response.js";



export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("combined"));

  app.get("/", (_req, res) => {
    res.json({
      status: "success",
      action: "root",
      data: {
        name: "browser-automation-mcp-server",
        health: "/health",
        routes: [
          "POST /open",
          "POST /click",
          "POST /type",
          "POST /scroll",
          "POST /hover",
          "POST /wait",
          "POST /select",
          "POST /upload",
          "POST /plan",
          "POST /flow/:template",
          "GET /agent/events",
          "GET /agent/state",
          "GET /screenshot",
          "GET /analyze",
          "GET /errors",
          "GET /state",
          "GET /sessions",
          "DELETE /session/:sessionId",
          "GET /health"
        ]
      },
      error: ""
    });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "success",
      action: "health",
      data: { ok: true },
      error: ""
    });
  });

  app.use("/", browserRoutes);

  app.use((req, res) => {
    res.status(404).json(failure("route", `Route not found: ${req.method} ${req.originalUrl}`));
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json(failure("server", error));
  });

  return app;
}
