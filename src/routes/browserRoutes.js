import { Router } from "express";
import { browserService } from "../services/browserService.js";
import { agentActivityService } from "../services/agentActivityService.js";
import { success, failure } from "../utils/response.js";

const router = Router();

async function runAgentAction(action, handler) {
  agentActivityService.start(action);
  try {
    return await handler();
  } finally {
    agentActivityService.end();
  }
}

router.get("/agent/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  agentActivityService.addClient(res);
  req.on("close", () => {
    agentActivityService.removeClient(res);
  });
});

router.get("/agent/state", (_req, res) => {
  return res.json(success("agentState", agentActivityService.getState()));
});

router.post("/open", async (req, res) => {
  try {
    const { sessionId, url, headless } = req.body || {};
    if (!url) return res.status(400).json(failure("open", "Missing required field: url"));
    const data = await runAgentAction("open", () => browserService.openUrl({ sessionId, url, headless }));
    return res.json(success("open", data));
  } catch (error) {
    return res.status(500).json(failure("open", error));
  }
});

router.post("/click", async (req, res) => {
  try {
    const { sessionId, selector, query } = req.body || {};
    if (!sessionId || (!selector && !query)) {
      return res.status(400).json(failure("click", "Missing required fields: sessionId and selector/query"));
    }
    const data = await runAgentAction("click", () => browserService.click({ sessionId, selector, query }));
    return res.json(success("click", data));
  } catch (error) {
    return res.status(500).json(failure("click", error));
  }
});

router.post("/type", async (req, res) => {
  try {
    const { sessionId, selector, query, text } = req.body || {};
    if (!sessionId || (!selector && !query) || text === undefined) {
      return res.status(400).json(failure("type", "Missing required fields: sessionId, selector/query, text"));
    }
    const data = await runAgentAction("type", () => browserService.type({ sessionId, selector, query, text: String(text) }));
    return res.json(success("type", data));
  } catch (error) {
    return res.status(500).json(failure("type", error));
  }
});

router.get("/screenshot", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const fileName = req.query.fileName;
    if (!sessionId) return res.status(400).json(failure("screenshot", "Missing required query: sessionId"));
    const data = await runAgentAction("screenshot", () => browserService.screenshot({ sessionId, fileName }));
    return res.json(success("screenshot", data));
  } catch (error) {
    return res.status(500).json(failure("screenshot", error));
  }
});

router.get("/analyze", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json(failure("analyze", "Missing required query: sessionId"));
    const data = await runAgentAction("analyze", () => browserService.analyze({ sessionId }));
    return res.json(success("analyze", data));
  } catch (error) {
    return res.status(500).json(failure("analyze", error));
  }
});

router.get("/errors", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json(failure("errors", "Missing required query: sessionId"));
    const data = browserService.getErrors({ sessionId });
    return res.json(success("errors", data));
  } catch (error) {
    return res.status(500).json(failure("errors", error));
  }
});

router.post("/scroll", async (req, res) => {
  try {
    const { sessionId, pixels } = req.body || {};
    if (!sessionId) return res.status(400).json(failure("scroll", "Missing required field: sessionId"));
    const data = await runAgentAction("scroll", () => browserService.scroll({ sessionId, pixels: Number(pixels || 600) }));
    return res.json(success("scroll", data));
  } catch (error) {
    return res.status(500).json(failure("scroll", error));
  }
});

router.post("/hover", async (req, res) => {
  try {
    const { sessionId, selector, query } = req.body || {};
    if (!sessionId || (!selector && !query)) {
      return res.status(400).json(failure("hover", "Missing required fields: sessionId and selector/query"));
    }
    const data = await runAgentAction("hover", () => browserService.hover({ sessionId, selector, query }));
    return res.json(success("hover", data));
  } catch (error) {
    return res.status(500).json(failure("hover", error));
  }
});

router.post("/wait", async (req, res) => {
  try {
    const { sessionId, selector, query, text, timeoutMs } = req.body || {};
    if (!sessionId) return res.status(400).json(failure("wait", "Missing required field: sessionId"));
    const data = await runAgentAction("wait", () => browserService.wait({ sessionId, selector, query, text, timeoutMs }));
    return res.json(success("wait", data));
  } catch (error) {
    return res.status(500).json(failure("wait", error));
  }
});

router.post("/select", async (req, res) => {
  try {
    const { sessionId, selector, query, value, label, index } = req.body || {};
    if (!sessionId || (!selector && !query)) {
      return res.status(400).json(failure("select", "Missing required fields: sessionId and selector/query"));
    }
    const data = await runAgentAction("select", () => browserService.select({ sessionId, selector, query, value, label, index }));
    return res.json(success("select", data));
  } catch (error) {
    return res.status(500).json(failure("select", error));
  }
});

router.post("/upload", async (req, res) => {
  try {
    const { sessionId, selector, query, filePath } = req.body || {};
    if (!sessionId || (!selector && !query) || !filePath) {
      return res.status(400).json(failure("upload", "Missing required fields: sessionId, selector/query, filePath"));
    }
    const data = await runAgentAction("upload", () => browserService.upload({ sessionId, selector, query, filePath }));
    return res.json(success("upload", data));
  } catch (error) {
    return res.status(500).json(failure("upload", error));
  }
});

router.post("/plan", async (req, res) => {
  try {
    const { sessionId, goal, payload } = req.body || {};
    if (!goal) return res.status(400).json(failure("plan", "Missing required field: goal"));
    const data = await runAgentAction("plan", () => browserService.planAndExecute({ sessionId, goal, payload: payload || {} }));
    return res.json(success("plan", data));
  } catch (error) {
    return res.status(500).json(failure("plan", error));
  }
});

router.post("/flow/:template", async (req, res) => {
  try {
    const { sessionId, payload } = req.body || {};
    const data = await runAgentAction("flow", () => browserService.executeFlowTemplate({ sessionId, template: req.params.template, payload: payload || {} }));
    return res.json(success("flow", data));
  } catch (error) {
    return res.status(500).json(failure("flow", error));
  }
});

router.get("/state", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json(failure("state", "Missing required query: sessionId"));
    const data = browserService.getSessionState({ sessionId });
    return res.json(success("state", data));
  } catch (error) {
    return res.status(500).json(failure("state", error));
  }
});

router.get("/sessions", async (_req, res) => {
  try {
    const data = browserService.getSessions();
    return res.json(success("sessions", { sessions: data }));
  } catch (error) {
    return res.status(500).json(failure("sessions", error));
  }
});

router.delete("/session/:sessionId", async (req, res) => {
  try {
    const data = await runAgentAction("close session", () => browserService.closeSession({ sessionId: req.params.sessionId }));
    return res.json(success("closeSession", data));
  } catch (error) {
    return res.status(500).json(failure("closeSession", error));
  }
});

export default router;
