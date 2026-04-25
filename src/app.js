import express from "express";
import morgan from "morgan";
import path from "node:path";
import browserRoutes from "./routes/browserRoutes.js";
import { success, failure } from "./utils/response.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerAllTools, serverMetadata, toolsRegistry } from "./mcpServer.js";
import { scratchpadService } from "./services/scratchpadService.js";
import { projectSyncService } from "./services/projectSyncService.js";
import { config } from "./config.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";



export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("combined"));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/static", express.static(path.join(__dirname, "static")));

  const toBooleanLike = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    return value;
  };

  const toNumberLike = (value) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || value.trim() === "") return value;
    const asNumber = Number(value);
    return Number.isNaN(asNumber) ? value : asNumber;
  };

  const unwrapOptional = (field) => {
    let current = field;
    while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      current = current._def.innerType;
    }
    return current;
  };

  const normalizeByShape = (rawArgs, shape) => {
    if (!rawArgs || typeof rawArgs !== "object") return {};
    const normalized = { ...rawArgs };
    for (const [key, field] of Object.entries(shape || {})) {
      if (!(key in normalized)) continue;
      
      // Handle stringified JSON from query parameters (GET requests) or raw strings that should be numbers/bools
      if (typeof normalized[key] === "string" && (normalized[key].startsWith("{") || normalized[key].startsWith("["))) {
        try {
          normalized[key] = JSON.parse(normalized[key]);
        } catch (e) { /* ignore and use raw string */ }
      }

      const fieldType = unwrapOptional(field);
      if (fieldType instanceof z.ZodBoolean) {
        normalized[key] = toBooleanLike(normalized[key]);
      } else if (fieldType instanceof z.ZodNumber) {
        normalized[key] = toNumberLike(normalized[key]);
      }
    }
    return normalized;
  };

  const normalizeToolArgs = (tool, rawArgs) => {
    if (!tool?.schema) return rawArgs || {};
    const schema = tool.schema;
    if (schema instanceof z.ZodObject) {
      return normalizeByShape(rawArgs, schema.shape);
    }
    if (typeof schema === "object") {
      return normalizeByShape(rawArgs, schema);
    }
    return rawArgs || {};
  };

  const executeToolByName = async (toolName, rawArgs) => {
    registerAllTools();
    const tool = toolsRegistry.find((t) => t.name === toolName);
    if (!tool) {
      return {
        ok: false,
        statusCode: 404,
        payload: failure("toolExecution", `Tool not found: ${toolName}`)
      };
    }

    const args = normalizeToolArgs(tool, rawArgs || {});

    // VALIDATION: Ensure the arguments match the tool's schema
    try {
      if (tool.schema) {
        const schema = (tool.schema instanceof z.ZodType) ? tool.schema : z.object(tool.schema);
        schema.parse(args);
      }
    } catch (error) {
      return {
        ok: false,
        statusCode: 400,
        payload: failure("validation", error instanceof Error ? error.message : String(error))
      };
    }

    try {
      const result = await tool.handler(args);
      return {
        ok: true,
        statusCode: 200,
        payload: success(toolName, result)
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 500,
        payload: failure(toolName, error instanceof Error ? error.message : String(error))
      };
    }
  };

  // ─── Scratchpad File Serving ─────────────────────────────
  app.get("/scratchpad/:sessionId/:category/:filename", async (req, res) => {
    try {
      const { sessionId, category, filename } = req.params;
      const fileData = await scratchpadService.readFile(sessionId, filename, category);

      // Determine content type
      const ext = path.extname(filename).toLowerCase();
      const contentTypes = {
        ".html": "text/html",
        ".htm": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".txt": "text/plain",
        ".md": "text/markdown"
      };
      res.setHeader("Content-Type", contentTypes[ext] || "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.send(fileData.content);
    } catch (error) {
      res.status(404).json(failure("scratchpad", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/scratchpad/:sessionId/:filename", async (req, res) => {
    try {
      const { sessionId, filename } = req.params;
      const fileData = await scratchpadService.readFile(sessionId, filename, "pages");
      const ext = path.extname(filename).toLowerCase();
      const contentTypes = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript",
        ".json": "application/json",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8"
      };
      res.setHeader("Content-Type", contentTypes[ext] || "text/plain; charset=utf-8");
      res.send(fileData.content);
    } catch (error) {
      res.status(404).json(failure("scratchpad", error instanceof Error ? error.message : String(error)));
    }
  });

  // ─── Screenshot Image Serving ────────────────────────────
  app.get("/screenshot/image", async (req, res) => {
    try {
      const { browserService } = await import("./services/browserService.js");
      const sessionId = req.query.sessionId;
      if (!sessionId) return res.status(400).json(failure("screenshot", "Missing sessionId"));

      const session = browserService.getSession(sessionId);
      if (!session) return res.status(404).json(failure("screenshot", "Session not found"));

      const fullPage = ["true", "1", "yes", "y"].includes(String(req.query.fullPage || "").toLowerCase());
      const buffer = await session.page.screenshot({ fullPage });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(buffer);
    } catch (error) {
      res.status(500).json(failure("screenshot", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/screenshot/latest/:sessionId", async (req, res) => {
    try {
      const { browserService } = await import("./services/browserService.js");
      const session = browserService.getSession(req.params.sessionId);
      if (!session) return res.status(404).json(failure("screenshot", "Session not found"));

      const latest = session.screenshotHistory[session.screenshotHistory.length - 1];
      if (!latest || !latest.path) return res.status(404).json(failure("screenshot", "No screenshots taken yet"));

      const { default: fs } = await import("node:fs/promises");
      const buffer = await fs.readFile(latest.path);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(buffer);
    } catch (error) {
      res.status(500).json(failure("screenshot", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/screenshots/:sessionId", async (req, res) => {
    try {
      const { browserService } = await import("./services/browserService.js");
      const session = browserService.getSession(req.params.sessionId);
      if (!session) return res.status(404).json(failure("screenshots", "Session not found"));

      const port = config.port || 1000;
      const screenshots = session.screenshotHistory.map((s, i) => ({
        ...s,
        index: i,
        downloadUrl: s.path ? `http://127.0.0.1:${port}/screenshot/file/${req.params.sessionId}/${path.basename(s.path)}` : null
      }));

      res.json({
        status: "success",
        action: "screenshots",
        data: { sessionId: req.params.sessionId, count: screenshots.length, screenshots },
        error: ""
      });
    } catch (error) {
      res.status(500).json(failure("screenshots", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/screenshot/file/:sessionId/:filename", async (req, res) => {
    try {
      const { browserService } = await import("./services/browserService.js");
      const screenshotRoot = browserService.sessionScreenshotRoot(req.params.sessionId);
      const safeName = req.params.filename.replace(/[^\w.\-() ]/g, "_");
      const filePath = path.resolve(screenshotRoot, safeName);

      // Path traversal guard
      const rel = path.relative(screenshotRoot, filePath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return res.status(403).json(failure("screenshot", "Forbidden"));
      }

      const { default: fs } = await import("node:fs/promises");
      const buffer = await fs.readFile(filePath);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.send(buffer);
    } catch (error) {
      res.status(404).json(failure("screenshot", "File not found"));
    }
  });

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
    res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "static", "dashboard.html"));
  });

  app.get("/api/info", (_req, res) => {
    const port = config.port || 1000;
    const host = config.host || "127.0.0.1";
    const baseUrl = `http://${host}:${port}`;

    res.json({
      status: "success",
      action: "info",
      data: {
        name: "universal-browser-automation-server",
        version: "3.5.0",
        integrations: {
          mcp_sse: `${baseUrl}/mcp/sse`,
          mcp_stdio: "npm run mcp",
          rest_api: `${baseUrl}/api/tools`,
          discovery: {
            openai: `${baseUrl}/api/tools/definitions/openai`,
            mcp: `${baseUrl}/api/tools/definitions/mcp`,
            ai_plugin: `${baseUrl}/.well-known/ai-plugin.json`
          }
        },
        features: {
          visionAI: "GEMINI_API_KEY " + (config.geminiApiKey ? "configured ✓" : "not set"),
          scratchpad: config.scratchpadDir
        }
      }
    });
  });

  app.get("/llms.txt", async (req, res) => {
    registerAllTools();
    let output = "# Browser Automation Universal Server\n\n";
    output += "⚠️ VERY IMPORTANT INSTRUCTIONS FOR AI AGENTS ⚠️\n";
    output += "1. **NO CURL**: Use your native MCP Tool Call functions. DO NOT use `curl` or PowerShell terminal commands.\n";
    output += "2. **SMART FORM FILLING**: To fill a form, follow this blueprint:\n";
    output += "   a. Call `browser_analyze` first.\n";
    output += "   b. Look for the `forms` object in the response.\n";
    output += "   c. COPY the keys from `suggestedPayload` exactly as they appear.\n";
    output += "   d. Use `browser_fill_form` with `turbo: true` and those exact keys.\n";
    output += "3. **LEAN DATA**: Use `browser_screenshot` with `embedImage: false` + `analyze: true` for AI visual descriptions.\n\n";
    
    output += "This server provides a REST API as a fallback: http://localhost:1000/api/tools/{tool_name}\n\n";
    output += "## Most Used Tools (Bootstrap)\n\n";
    
    const bootstrap = ['browser_open', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_analyze', 'browser_sessions'];
    for (const name of bootstrap) {
      const tool = toolsRegistry.find(t => t.name === name);
      if (tool) output += `- **${tool.name}**: ${tool.description}\n`;
    }
    
    output += "\n## Full Documentation\nRead the detailed guide: http://localhost:1000/mcp/tool-guide\n";
    output += "Tool definitions: http://localhost:1000/api/tools/definitions/mcp\n";
    
    res.setHeader("Content-Type", "text/plain");
    res.send(output);
  });

  app.get("/.well-known/ai-plugin.json", (req, res) => {
    const port = config.port || 1000;
    res.json({
      schema_version: "v1",
      name_for_model: "browser_automation",
      name_for_human: "Browser Automation Server",
      description_for_model: "Full control over a headed browser. Click, type, scroll, screenshot, export PDF, and extract UI designs.",
      description_for_human: "Automate your browser activities with AI.",
      auth: { type: "none" },
      api: { type: "openapi", url: `http://localhost:${port}/api/tools/definitions/openai` },
      logo_url: `http://localhost:${port}/static/logo.png`,
      contact_email: "support@example.com",
      legal_info_url: `http://localhost:${port}/legal`
    });
  });

  app.get("/llms-full.txt", async (req, res) => {
    registerAllTools();
    let output = "# Browser Automation Universal Server\n\n";
    output += "⚠️ VERY IMPORTANT FOR AI AGENTS: DO NOT use `curl` or terminal commands. Use your NATIVE MCP Tool Interface directly!\n\n";
    output += "If you absolutely must use REST (non-MCP), the endpoint is: POST http://localhost:1000/api/tools/{tool_name} with JSON body.\n\n";
    output += "## Available Tools\n\n";
    
    for (const tool of toolsRegistry) {
      output += `### ${tool.name}\n${tool.description}\n\n`;
    }
    
    res.setHeader("Content-Type", "text/plain");
    res.send(output);
  });

  app.get("/health", async (_req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      const { workerService } = await import("./services/workerService.js");
      const { sessionStore } = await import("./services/sessionStore.js");
      const { wsService } = await import("./services/wsService.js");
      const { selfHealingSelector } = await import("./services/selfHealingSelector.js");
      const { aiDecisionService } = await import("./services/aiDecisionService.js");

      res.json({
        status: "success",
        action: "health",
        data: {
          ok: true,
          version: "4.0.0",
          uptime: process.uptime(),
          services: {
            redis: sessionStore.isRedisConnected,
            queue: queueService.isReady,
            worker: workerService.getStats().running,
            websocket: wsService.getStats(),
            aiDecision: aiDecisionService.isAvailable(),
            selfHealing: config.selfHealingEnabled
          }
        },
        error: ""
      });
    } catch (error) {
      res.json({
        status: "success",
        action: "health",
        data: { ok: true },
        error: ""
      });
    }
  });

  // ─── Queue Management REST API ───────────────────────────
  app.post("/api/queue/enqueue", async (req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      if (!queueService.isReady) {
        return res.status(503).json(failure("queue", "Queue not available. Set REDIS_URL in .env."));
      }
      const { action, params, priority } = req.body || {};
      if (!action) return res.status(400).json(failure("queue", "Missing required field: action"));
      const result = await queueService.enqueue(action, params || {}, { priority });
      res.json(success("queue_enqueue", result));
    } catch (error) {
      res.status(500).json(failure("queue", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/api/queue/status", async (_req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      const metrics = await queueService.getMetrics();
      res.json(success("queue_status", metrics));
    } catch (error) {
      res.status(500).json(failure("queue", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/api/queue/jobs", async (req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      const status = req.query.status || "all";
      const limit = Number(req.query.limit || 20);
      const result = await queueService.listJobs({ status, limit });
      res.json(success("queue_jobs", result));
    } catch (error) {
      res.status(500).json(failure("queue", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/api/queue/job/:jobId", async (req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      const result = await queueService.getJobStatus(req.params.jobId);
      res.json(success("job_status", result));
    } catch (error) {
      res.status(500).json(failure("queue", error instanceof Error ? error.message : String(error)));
    }
  });

  // ─── System Status REST API ──────────────────────────────
  app.get("/api/system/status", async (_req, res) => {
    try {
      const { queueService } = await import("./services/queueService.js");
      const { workerService } = await import("./services/workerService.js");
      const { sessionStore } = await import("./services/sessionStore.js");
      const { wsService } = await import("./services/wsService.js");
      const { selfHealingSelector } = await import("./services/selfHealingSelector.js");
      const { aiDecisionService } = await import("./services/aiDecisionService.js");
      const { browserService } = await import("./services/browserService.js");

      res.json(success("system_status", {
        queue: await queueService.getMetrics(),
        worker: workerService.getStats(),
        websocket: wsService.getStats(),
        redis: sessionStore.isRedisConnected,
        healing: selfHealingSelector.getStats(),
        aiDecision: aiDecisionService.isAvailable(),
        sessions: browserService.getSessions()?.length || 0
      }));
    } catch (error) {
      res.status(500).json(failure("system", error instanceof Error ? error.message : String(error)));
    }
  });

  // ─── Self-Healing Stats REST API ─────────────────────────
  app.get("/api/healing/stats", async (_req, res) => {
    try {
      const { selfHealingSelector } = await import("./services/selfHealingSelector.js");
      res.json(success("healing_stats", {
        stats: selfHealingSelector.getStats(),
        recentLog: selfHealingSelector.getHealingLog().slice(-20)
      }));
    } catch (error) {
      res.status(500).json(failure("healing", error instanceof Error ? error.message : String(error)));
    }
  });

  // ─── AI Decision REST API ────────────────────────────────
  app.post("/api/ai/plan", async (req, res) => {
    try {
      const { aiDecisionService } = await import("./services/aiDecisionService.js");
      const { goal, sessionId } = req.body || {};
      if (!goal) return res.status(400).json(failure("ai_plan", "Missing required field: goal"));

      let context = {};
      if (sessionId) {
        const { browserService } = await import("./services/browserService.js");
        const session = browserService.getSession(sessionId);
        if (session) {
          const state = await browserService.analyzePageState(session);
          context = { url: state.url, pageTitle: state.title, interactiveElements: state.elements };
        }
      }

      const plan = await aiDecisionService.planFromGoal(goal, context);
      res.json(success("ai_plan", plan));
    } catch (error) {
      res.status(500).json(failure("ai_plan", error instanceof Error ? error.message : String(error)));
    }
  });

  app.get("/api/sync/status", async (_req, res) => {
    try {
      const data = await projectSyncService.syncStatus();
      res.json(success("sync_status", data));
    } catch (error) {
      res.status(500).json(failure("sync_status", error));
    }
  });

  app.post("/api/sync/fix", async (req, res) => {
    try {
      const cleanupRootClutter = req.body?.cleanupRootClutter !== false;
      const data = await projectSyncService.syncFix({ cleanupRootClutter });
      res.json(success("sync_fix", data));
    } catch (error) {
      res.status(500).json(failure("sync_fix", error));
    }
  });

  // --- Universal REST API Discovery ---
  const zodToJsonSchema = (zodObj) => {
    if (!zodObj) return { type: "object", properties: {} };
    if (typeof zodObj === "object" && !(zodObj instanceof z.ZodType)) {
      const properties = {};
      const required = [];
      for (const [key, field] of Object.entries(zodObj)) {
        properties[key] = zodToJsonSchema(field);
        if (!(field instanceof z.ZodOptional)) required.push(key);
      }
      return { type: "object", properties, required };
    }
    if (zodObj instanceof z.ZodObject) {
      const properties = {};
      const required = [];
      for (const [key, field] of Object.entries(zodObj.shape)) {
        properties[key] = zodToJsonSchema(field);
        if (!(field instanceof z.ZodOptional)) required.push(key);
      }
      return { type: "object", properties, required };
    }
    if (zodObj instanceof z.ZodString) return { type: "string" };
    if (zodObj instanceof z.ZodNumber) return { type: "number" };
    if (zodObj instanceof z.ZodBoolean) return { type: "boolean" };
    if (zodObj instanceof z.ZodOptional) return zodToJsonSchema(zodObj._def.innerType);
    if (zodObj instanceof z.ZodEnum) return { type: "string", enum: zodObj._def.values };
    if (zodObj instanceof z.ZodArray) return { type: "array", items: zodToJsonSchema(zodObj._def.type) };
    if (zodObj instanceof z.ZodRecord) return { type: "object", additionalProperties: zodToJsonSchema(zodObj._def.valueType) };
    return { type: "string" };
  };

  app.get("/api/tools/definitions/mcp", (req, res) => {
    registerAllTools(); // Ensure registry is populated
    res.json(success("discovery", toolsRegistry.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema)
    }))));
  });

  app.get("/api/tools/definitions/openai", (req, res) => {
    registerAllTools();
    const tools = toolsRegistry.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.schema)
      }
    }));
    res.json(tools);
  });

  // --- Dynamic Universal REST API Endpoints ---
  app.post("/api/bridge/call", async (req, res) => {
    try {
      const body = req.body || {};
      const toolName = body.tool || body.toolName || body.name;
      if (!toolName) {
        return res.status(400).json(failure("bridge", "Missing required field: tool/toolName"));
      }

      const rawArgs = body.arguments || body.nativeArgs || body.args || body.params || {};
      const execution = await executeToolByName(toolName, rawArgs);
      return res.status(execution.statusCode).json(execution.payload);
    } catch (error) {
      return res.status(500).json(failure("bridge", error));
    }
  });

  app.get("/api/bridge/prompt", (_req, res) => {
    const port = config.port || 1000;
    res.json(success("bridge_prompt", {
      endpoint: `http://127.0.0.1:${port}/api/bridge/call`,
      requestShape: {
        tool: "browser_sessions",
        arguments: {}
      },
      notes: [
        "Use POST with JSON body.",
        "arguments/nativeArgs/args/params are all accepted.",
        "For WebFetch wrappers, keep format=text|markdown|html only."
      ]
    }));
  });

  app.all("/api/tools/:toolName", async (req, res) => {
    try {
      // Only allow GET and POST
      if (req.method !== "POST" && req.method !== "GET") {
        return res.status(405).json(failure("toolExecution", "Method Not Allowed"));
      }
      
      const { toolName } = req.params;
      console.log(`[REST] Executing tool (${req.method}): ${toolName}`);
      
      // For GET requests, we can try to parse query parameters as input if needed
      const rawArgs = req.method === "POST" ? (req.body || {}) : (req.query || {});
      const execution = await executeToolByName(toolName, rawArgs);
      res.status(execution.statusCode).json(execution.payload);
    } catch (error) {
      console.error(`[REST ERROR] ${req.params.toolName}:`, error);
      res.status(500).json(failure(req.params.toolName, error));
    }
  });

  app.get("/api/tools", (req, res) => {
    registerAllTools();
    res.json(success("listTools", toolsRegistry.map(t => t.name)));
  });

  app.get("/api/tools/:toolName/schema", (req, res) => {
    registerAllTools();
    const { toolName } = req.params;
    const tool = toolsRegistry.find(t => t.name === toolName);
    if (!tool) return res.status(404).json(failure("schema", `Tool not found: ${toolName}`));
    
    res.json({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema)
      }
    });
  });
  let mcpTransports = [];

  app.get("/mcp/sse", async (req, res) => {
    try {
      console.log("[MCP] New SSE connection request");
      
      // Create a fresh server instance for this connection
      const connectionServer = new McpServer(serverMetadata, {});
      registerAllTools(connectionServer);

      const transport = new SSEServerTransport("/mcp/messages", res);
      mcpTransports.push(transport);
      
      console.log("[MCP] Connecting transport...");
      await connectionServer.connect(transport);
      console.log("[MCP] Transport connected successfully");
      
      // Cleanup when connection closes
      req.on("close", () => {
        console.log("[MCP] SSE connection closed");
        mcpTransports = mcpTransports.filter(t => t !== transport);
      });
    } catch (error) {
      console.error("[MCP SSE ERROR]", error);
      if (!res.headersSent) {
        // Send actual error message for debugging
        res.status(500).json(failure("mcp", `Failed to connect MCP transport: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  });

  app.post("/mcp/messages", async (req, res) => {
    try {
      console.log("[MCP] Incoming message for session:", req.query.sessionId);
      const transport = mcpTransports.find(t => t.sessionId === req.query.sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(404).json(failure("mcp", "Session not found or expired"));
      }
    } catch (error) {
      console.error("[MCP Message ERROR]", error);
      res.status(500).json(failure("mcp", error));
    }
  });

  app.use("/api/browser", browserRoutes);
  app.use("/", browserRoutes);

  app.use((req, res) => {
    res.status(404).json(failure("route", `Route not found: ${req.method} ${req.originalUrl}`));
  });

  app.use((error, _req, res, _next) => {
    res.status(500).json(failure("server", error));
  });

  return app;
}
