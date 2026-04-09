import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod/v3";

import { browserService } from "./services/browserService.js";

const server = new McpServer(
  {
    name: "user-browser-automation-mcp-server",
    version: "2.0.0"
  },
  {}
);

const jsonText = (value) => [
  {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
  }
];

const tool = (name, description, schema, handler) => {
  if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (value === undefined) {
        throw new Error(`Tool ${name} has undefined schema for key: ${key}`);
      }
    }
  }
  try {
    // Validates schema shape and catches mixed/invalid Zod objects early.
    normalizeObjectSchema(schema ?? {});
  } catch (error) {
    throw new Error(
      `Tool ${name} has an invalid input schema: ${error instanceof Error ? error.message : String(error)
      }`
    );
  }
  server.tool(name, description, schema ?? {}, async (args) => {
    try {
      const data = await handler(args ?? {});
      return { content: jsonText({ ok: true, data }) };
    } catch (error) {
      return {
        isError: true,
        content: jsonText({
          ok: false,
          error: error instanceof Error ? error.message : String(error || "Unknown error")
        })
      };
    }
  });
};

// ─── Session & Navigation ──────────────────────────────

tool(
  "browser_open",
  "Open a URL in the browser (creates session if needed). Set persist=true to keep cookies/logins across sessions.",
  {
    sessionId: z.string().optional(),
    url: z.string(),
    headless: z.boolean().optional(),
    persist: z.boolean().optional()
  },
  ({ sessionId, url, headless, persist }) => browserService.openUrl({ sessionId, url, headless, persist })
);

tool(
  "browser_close_session",
  "Close a session and its browser.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.closeSession({ sessionId })
);

tool("browser_sessions", "List all active browser sessions.", {}, () => browserService.getSessions());

// ─── Interaction (Single) ──────────────────────────────

tool(
  "browser_click",
  "Click an element by CSS selector or natural-language query.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional()
  },
  ({ sessionId, selector, query }) => browserService.click({ sessionId, selector, query })
);

tool(
  "browser_type",
  "Type text into an input element. Use browser_fill_form instead for multiple fields.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional(),
    text: z.string()
  },
  ({ sessionId, selector, query, text }) => browserService.type({ sessionId, selector, query, text })
);

tool(
  "browser_hover",
  "Hover over an element.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional()
  },
  ({ sessionId, selector, query }) => browserService.hover({ sessionId, selector, query })
);

tool(
  "browser_scroll",
  "Scroll the page vertically by pixels (positive=down, negative=up).",
  {
    sessionId: z.string(),
    pixels: z.number().optional()
  },
  ({ sessionId, pixels }) => browserService.scroll({ sessionId, pixels })
);

tool(
  "browser_select",
  "Select an option in a <select> element.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().optional()
  },
  ({ sessionId, selector, query, value, label, index }) =>
    browserService.select({ sessionId, selector, query, value, label, index })
);

tool(
  "browser_upload",
  "Upload a file into a file input.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional(),
    filePath: z.string()
  },
  ({ sessionId, selector, query, filePath }) => browserService.upload({ sessionId, selector, query, filePath })
);

tool(
  "browser_wait",
  "Wait for a selector/text to appear, or just sleep for timeoutMs.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional(),
    text: z.string().optional(),
    timeoutMs: z.number().optional()
  },
  ({ sessionId, selector, query, text, timeoutMs }) =>
    browserService.wait({ sessionId, selector, query, text, timeoutMs })
);

// ─── Batch Operations (FAST) ───────────────────────────

tool(
  "browser_fill_form",
  "Fill multiple form fields in ONE call. Pass fields as an object: { 'email field': 'test@example.com', 'password field': 'secret' }. This is MUCH faster than calling browser_type for each field.",
  {
    sessionId: z.string(),
    fields: z.record(z.string())
  },
  ({ sessionId, fields }) => browserService.fillForm({ sessionId, fields })
);

tool(
  "browser_flow",
  "Execute a built-in flow template (login/signup/formSubmission) with all fields at once.",
  {
    sessionId: z.string().optional(),
    template: z.enum(["login", "signup", "formSubmission"]),
    payload: z.record(z.any()).optional()
  },
  ({ sessionId, template, payload }) =>
    browserService.executeFlowTemplate({ sessionId, template, payload: payload || {} })
);

tool(
  "browser_plan",
  "Generate and execute a multi-step plan for a goal (e.g. 'login', 'signup').",
  {
    sessionId: z.string().optional(),
    goal: z.string(),
    payload: z.record(z.any()).optional()
  },
  ({ sessionId, goal, payload }) => browserService.planAndExecute({ sessionId, goal, payload: payload || {} })
);

// ─── Inspection & Testing ──────────────────────────────

tool(
  "browser_analyze",
  "Analyze current page DOM (buttons, links, forms, inputs). Use this to understand page structure before interacting.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.analyze({ sessionId })
);

tool(
  "browser_inspect",
  "Full page inspection: DOM analysis + recent console/network errors + scratchpad. No screenshot taken (use browser_screenshot separately if needed).",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.inspectPage({ sessionId })
);

tool(
  "browser_test_page",
  "Run a quality/health check: broken images, missing alt tags, console errors, network errors, SEO meta.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.testPageQuality({ sessionId })
);

tool(
  "browser_errors",
  "Get all console and network errors collected so far.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.getErrors({ sessionId })
);

tool(
  "browser_screenshot",
  "Take a screenshot. Viewport only by default (fast). Set fullPage=true for full page.",
  {
    sessionId: z.string(),
    fileName: z.string().optional(),
    fullPage: z.boolean().optional()
  },
  ({ sessionId, fileName, fullPage }) => browserService.screenshot({ sessionId, fileName, fullPage })
);

tool(
  "browser_capture_links",
  "Navigate to internal link routes and capture screenshots of each. Returns to original page after.",
  {
    sessionId: z.string(),
    maxRoutes: z.number().optional()
  },
  ({ sessionId, maxRoutes }) => browserService.captureLinkRoutes({ sessionId, maxRoutes })
);

// ─── Scratchpad ────────────────────────────────────────

tool(
  "browser_update_scratchpad",
  "Overwrite the session scratchpad with new content. The scratchpad also auto-updates during actions.",
  {
    sessionId: z.string(),
    content: z.string()
  },
  ({ sessionId, content }) => browserService.updateScratchpad({ sessionId, content })
);

tool(
  "browser_state",
  "Get full session state: action history, scratchpad, logs, screenshots.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.getSessionState({ sessionId })
);

const transport = new StdioServerTransport();
await server.connect(transport);
