import express from "express";
import morgan from "morgan";
import browserRoutes from "./routes/browserRoutes.js";
import { failure } from "./utils/response.js";



export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("combined"));

  app.get("/demo-form", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>MCP Demo Form</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; line-height: 1.4; }
      .card { max-width: 720px; border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { display: block; font-weight: 600; margin-top: 10px; }
      input, textarea, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; }
      textarea { min-height: 100px; resize: vertical; }
      button { margin-top: 14px; padding: 10px 14px; border-radius: 10px; border: 1px solid #111; background: #111; color: #fff; cursor: pointer; }
      pre { background: #0b1020; color: #e5e7eb; padding: 12px; border-radius: 12px; overflow: auto; }
      .muted { color: #666; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>MCP Demo Form</h1>
      <p class="muted">Use this page to test MCP browser automation form fill + submit.</p>
      <form id="demoForm">
        <div class="row">
          <div>
            <label for="name">Name</label>
            <input id="name" name="name" placeholder="Jane Doe" required />
          </div>
          <div>
            <label for="email">Email</label>
            <input id="email" name="email" type="email" placeholder="jane@example.com" required />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="role">Role</label>
            <select id="role" name="role" required>
              <option value="">Select role…</option>
              <option value="admin">Admin</option>
              <option value="user">User</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <div>
            <label for="agree">
              <input id="agree" name="agree" type="checkbox" />
              Agree to terms
            </label>
          </div>
        </div>
        <label for="message">Message</label>
        <textarea id="message" name="message" placeholder="Hello from MCP…"></textarea>
        <button type="submit">Submit</button>
      </form>
      <h2>Result</h2>
      <pre id="result">{}</pre>
    </div>
    <script>
      const form = document.getElementById('demoForm');
      const result = document.getElementById('result');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        payload.agree = document.getElementById('agree').checked;
        const res = await fetch('/demo-submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        result.textContent = JSON.stringify(json, null, 2);
      });
    </script>
  </body>
</html>`);
  });

  app.post("/demo-submit", (req, res) => {
    res.json({
      ok: true,
      received: req.body || null,
      receivedAt: new Date().toISOString()
    });
  });

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
