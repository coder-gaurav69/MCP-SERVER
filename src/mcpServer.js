/**
 * ⚠ IMPORTANT FOR AI AGENTS (Cursor, Roo, Claude):
 * This is an MCP STDIO server. 
 * - NEVER attempt to use 'curl' to interact with this server.
 * - ALWAYS use native MCP tool calls (e.g., browser_open).
 * - Transport is STDIN/STDOUT, NOT HTTP for tool execution.
 * - Management Dashboard (optional) runs on Port 1000.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { browserService } from "./services/browserService.js";
import { createApp } from "./app.js";
import { config } from "./config.js";

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDirPath = path.dirname(moduleFilePath);
const TOOL_GUIDE_URI = "mcp://browser-automation/tool-guide";
const TOOL_GUIDE_PATH = path.resolve(moduleDirPath, "../MCP_TOOL_GUIDE.md");

const readToolGuide = () => fs.readFile(TOOL_GUIDE_PATH, "utf8");

export const server = new McpServer(
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

server.registerResource(
  "browser-automation-tool-guide",
  TOOL_GUIDE_URI,
  {
    title: "Browser Automation MCP Tool Guide",
    description: "Read this first to understand the browser automation MCP tools and usage rules.",
    mimeType: "text/markdown"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: await readToolGuide()
      }
    ]
  })
);

const tool = (name, description, schema, handler) => {
  let validSchema;
  try {
    validSchema = z.object(schema ?? {});
  } catch (error) {
    throw new Error(
      `Tool ${name} has an invalid input schema: ${error instanceof Error ? error.message : String(error)
      }`
    );
  }
  
  server.registerTool(name, {
    description,
    inputSchema: validSchema
  }, async (params) => {
    try {
      const data = await handler(params ?? {});
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
  "browser_tool_guide",
  "Read this first. Returns the canonical one-file guide for available tools and usage rules.",
  z.object({}),
  async () => ({ resourceUri: TOOL_GUIDE_URI, guide: await readToolGuide() })
);

tool(
  "browser_open",
  "Open a URL in the browser (creates session if needed). Set persist=true to keep cookies/logins across sessions.",
  {
    sessionId: z.string().optional(),
    url: z.string(),
    headless: z.boolean().optional(),
    persist: z.boolean().optional()
  },
  (params) => browserService.openUrl(params)
);

tool(
  "open_browser",
  "Compatibility alias for browser_open. Opens a URL in the browser; prefer browser_open in new clients.",
  {
    sessionId: z.string().optional(),
    url: z.string(),
    headless: z.boolean().optional(),
    persist: z.boolean().optional()
  },
  (params) => browserService.openUrl(params)
);

tool(
  "browser_close_session",
  "Close a session and its browser. Set cleanup=true to delete this session's screenshot folder (and files), downloads for the session, and persist user_data for that session.",
  {
    sessionId: z.string(),
    cleanup: z.boolean().optional()
  },
  ({ sessionId, cleanup }) => browserService.closeSession({ sessionId, cleanup })
);

tool("browser_sessions", "List all active browser sessions.", {}, () => browserService.getSessions());

// ─── Interaction (Single) ──────────────────────────────

tool(
  "browser_click",
  "Click an element by CSS selector or natural-language query. Use 'settlePolicy' to control post-click wait.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector for exact target"),
    query: z.string().optional().describe("Natural language query (e.g., 'login button')"),
    settlePolicy: z.enum(["lazy", "normal", "strict"]).optional().default("normal").describe("Wait policy: 'lazy' (fast), 'normal' (standard), 'strict' (waits for more network idle).")
  },
  ({ sessionId, selector, query, settlePolicy }) => browserService.click({ sessionId, selector, query, settlePolicy })
);

tool(
  "browser_type",
  "Type text into an input element. Automatic clearing of existing content is performed first.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector for the input"),
    query: z.string().optional().describe("Natural language query for the input (e.g., 'email field')"),
    text: z.string().describe("The text to type into the field")
  },
  ({ sessionId, selector, query, text }) => browserService.type({ sessionId, selector, query, text })
);

tool(
  "browser_hover",
  "Hover the mouse pointer over an element.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector for the target"),
    query: z.string().optional().describe("Natural language query for the target")
  },
  ({ sessionId, selector, query }) => browserService.hover({ sessionId, selector, query })
);

tool(
  "browser_scroll",
  "Scroll the page vertically. Positive value scrolls down, negative scrolls up.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    pixels: z.number().optional().default(600).describe("Pixels to scroll (+ down, - up)")
  },
  ({ sessionId, pixels }) => browserService.scroll({ sessionId, pixels })
);

tool(
  "browser_select",
  "Select an option in a <select> element or custom dropdown. Supports labels ('Option One'), internal values ('opt1'), or 0-based index. Use 'browser_analyze' first to see available options.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector for the select/dropdown element"),
    query: z.string().optional().describe("Natural language query to find the element (e.g., 'customer dropdown')"),
    value: z.string().optional().describe("The internal 'value' attribute of the option."),
    label: z.string().optional().describe("The visible text label of the option."),
    index: z.number().optional().describe("0-based index of the option.")
  },
  ({ sessionId, selector, query, value, label, index }) =>
    browserService.select({ sessionId, selector, query, value, label, index })
);

tool(
  "browser_upload",
  "Upload a file into a file input element.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector for the file input"),
    query: z.string().optional().describe("Natural language query to find the file input"),
    filePath: z.string().describe("Absolute path to the file on the local file system")
  },
  ({ sessionId, selector, query, filePath }) => browserService.upload({ sessionId, selector, query, filePath })
);

tool(
  "browser_wait",
  "Wait for a specific element, text, or fixed duration (ms). Use to handle dynamic loading.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    selector: z.string().optional().describe("CSS selector to wait for"),
    query: z.string().optional().describe("Natural language query for the element to wait for"),
    text: z.string().optional().describe("Specific text content to wait for on the page"),
    timeoutMs: z.number().optional().describe("Max time to wait in milliseconds (default: 10000)")
  },
  ({ sessionId, selector, query, text, timeoutMs }) =>
    browserService.wait({ sessionId, selector, query, text, timeoutMs })
);

tool(
  "browser_generate_pdf",
  "Generate a high-fidelity PDF of the current page. Perfect for invoices, reports, or archiving.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    fileName: z.string().optional().describe("Name for the PDF file (default: export-<timestamp>.pdf)"),
    format: z.enum(["A4", "Letter", "Legal", "Tabloid"]).optional().default("A4").describe("Paper format"),
    landscape: z.boolean().optional().default(false).describe("Whether to use landscape orientation"),
    printBackground: z.boolean().optional().default(true).describe("Whether to include background colors/images")
  },
  (args) => browserService.generatePdf(args)
);

tool(
  "browser_press_key",
  "Press a single key or a combination (Enter, Tab, Escape, Control+C) on the keyboard.",
  {
    sessionId: z.string().describe("Session ID from browser_open"),
    key: z.string().describe("The name of the key (e.g., 'Enter', 'Tab', 'ArrowDown') or shortcut"),
    count: z.number().optional().default(1).describe("Number of times to press the key"),
    delay: z.number().optional().default(100).describe("Delay between presses in milliseconds")
  },
  (args) => browserService.pressKey(args)
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
  "Analyze current page DOM including interactive elements (buttons, links, forms). For <select> elements, it returns the first 15 available options. Use this before using 'browser_select' or 'browser_fill_form'.",
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
  "browser_element_styles",
  "Computed CSS + layout for one element (selector or natural-language query). Use to recreate styling / pixel-close clones.",
  {
    sessionId: z.string(),
    selector: z.string().optional(),
    query: z.string().optional(),
    maxOuterHtml: z.number().optional(),
    maxTextLength: z.number().optional()
  },
  ({ sessionId, selector, query, maxOuterHtml, maxTextLength }) =>
    browserService.extractElementStyles({ sessionId, selector, query, maxOuterHtml, maxTextLength })
);

tool(
  "browser_page_style_map",
  "Sample visible DOM nodes with computed styles (capped). Lighter than inspecting every element manually.",
  {
    sessionId: z.string(),
    maxNodes: z.number().optional()
  },
  ({ sessionId, maxNodes }) => browserService.pageStyleMap({ sessionId, maxNodes })
);

tool(
  "browser_test_page",
  "Run a quality/health check: broken images, missing alt tags, console errors, network errors, SEO meta.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.testPageQuality({ sessionId })
);

tool(
  "browser_extract_blueprint",
  "Extract a high-fidelity JSON blueprint of a page or component (hierarchical tree of tags, styles, and assets). Use this for pixel-perfect UI cloning.",
  {
    sessionId: z.string(),
    selector: z.string().optional().describe("Root element to extract (default: 'body')"),
    maxDepth: z.number().optional().describe("Max recursive depth (default: 10)")
  },
  ({ sessionId, selector, maxDepth }) => browserService.extractBlueprint({ sessionId, selector, maxDepth })
);

tool(
  "browser_get_palette",
  "Extract the dominant color palette and typography (font families) used on the current page. Helps recreate the design system.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.getGlobalPalette({ sessionId })
);

tool(
  "browser_errors",
  "Get all console and network errors collected so far.",
  { sessionId: z.string() },
  ({ sessionId }) => browserService.getErrors({ sessionId })
);

{
  const screenshotSchema = z.object({
    sessionId: z.string(),
    fileName: z.string().optional(),
    fullPage: z.boolean().optional(),
    embedImage: z
      .boolean()
      .optional()
      .default(true)
      .describe("When true (default), returns an MCP image content block (PNG) so the client can show it inline."),
    saveLocal: z
      .boolean()
      .optional()
      .default(false)
      .describe("When true, also saves the screenshot to the server's local disk. Default is false to keep your drive clean.")
  });
  server.registerTool(
    "browser_screenshot",
    {
      description: "Take a screenshot. By default, it returns the image directly to your chat (embedImage=true) and DOES NOT save it to disk (saveLocal=false).",
      inputSchema: screenshotSchema
    },
    async (args) => {
      const { sessionId, fileName, fullPage, embedImage, saveLocal } = args ?? {};
      try {
        const data = await browserService.screenshot({
          sessionId,
          fileName,
          fullPage,
          embedImage: embedImage !== undefined ? !!embedImage : true,
          saveLocal: !!saveLocal
        });
        const { imageBase64, ...rest } = data;
        const textPayload = {
          ok: true,
          data: { ...rest, imageAttached: !!imageBase64 }
        };
        const content = [jsonText(textPayload)];
        if (imageBase64) {
          content.push({ type: "image", data: imageBase64, mimeType: "image/png" });
        }
        return { content };
      } catch (error) {
        return {
          isError: true,
          content: jsonText({
            ok: false,
            error: error instanceof Error ? error.message : String(error || "Unknown error")
          })
        };
      }
    }
  );
}

tool(
  "browser_auto_explore",
  "Explore via nav discovery, then visit each route. Set navigateByClick=true to open links by clicking from the start URL (better for SPAs) instead of only using goto.",
  {
    sessionId: z.string(),
    maxRoutes: z.number().optional(),
    navigateByClick: z.boolean().optional()
  },
  ({ sessionId, maxRoutes, navigateByClick }) =>
    browserService.autoExplore({ sessionId, maxRoutes, navigateByClick: !!navigateByClick })
);

tool(
  "browser_capture_links",
  "DEPRECATED: Use browser_auto_explore instead for better results. Navigate to internal link routes and capture screenshots.",
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

tool(
  "browser_configure",
  "Toggle performance and security settings for the current session.",
  {
    sessionId: z.string(),
    turboMode: z.boolean().optional().describe("When true, skips animations and natural mouse movements for maximum speed."),
    interactionLock: z.boolean().optional().describe("When true, blocks manual user interaction with the browser during AI operations.")
  },
  ({ sessionId, turboMode, interactionLock }) => {
    const session = browserService.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (turboMode !== undefined) {
      // Note: In a real implementation we might want this in config or session state
      // For now we'll assume it updates the global config or we could extend session object
      import("./config.js").then(m => {
        if (turboMode !== undefined) m.config.turboMode = turboMode;
        if (interactionLock !== undefined) m.config.interactionLock = interactionLock;
      });
    }
    return { ok: true, status: { turboMode, interactionLock } };
  }
);


// Only connect to Stdio if this file is run directly
const isMainModule = () => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = path.resolve(process.argv[1]).toLowerCase();
    const modulePath = path.resolve(moduleFilePath).toLowerCase();
    return scriptPath === modulePath;
  } catch (e) {
    return false;
  }
};

if (isMainModule()) {
  const transport = new StdioServerTransport();

  // Also start the HTTP dashboard/SSE server on port 1000
  const app = createApp();
  const httpServer = app.listen(config.port, config.host, () => {
    // Write to stderr so we don't pollute MCP stdio transport (which uses stdout)
    console.error(`[INFO] Dashboard & REST API listening on http://${config.host}:${config.port}`);
    console.error(`[INFO] Transport mode: Stdio (primary) + HTTP (secondary)`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WARNING] Port ${config.port} is already in use by another instance! Skipping HTTP Dashboard... but MCP Stdio will continue to work perfectly.`);
    } else {
      console.error(`[ERROR] HTTP Server Error:`, err);
    }
  });

  // Final cleanup on process exit
  const cleanup = async () => {
    try {
      console.error("\nShutting down, cleaning up sessions...");
      await browserService.closeAll();
      httpServer.close();
      process.exit(0);
    } catch (err) {
      console.error("Cleanup error:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  server.connect(transport).catch(console.error);
}
