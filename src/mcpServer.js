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
import { visionService } from "./services/visionService.js";
import { scratchpadService } from "./services/scratchpadService.js";
import { createApp } from "./app.js";
import { config } from "./config.js";

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDirPath = path.dirname(moduleFilePath);
const TOOL_GUIDE_URI = "mcp://browser-automation/tool-guide";
const TOOL_GUIDE_PATH = path.resolve(moduleDirPath, "../MCP_TOOL_GUIDE.md");

const readToolGuide = () => fs.readFile(TOOL_GUIDE_PATH, "utf8");

/**
 * Metadata for identifying the server.
 */
export const serverMetadata = {
  name: "user-browser-automation-mcp-server",
  version: "3.0.0"
};

/**
 * Global registry of all browser automation tools.
 * Populated by registerAllTools().
 */
export const toolsRegistry = [];

/**
 * Registers all resources and tools onto the provided McpServer instance.
 */
export const registerAllTools = (serverInstance) => {
  const jsonText = (value) => [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }
  ];

  const tool = (name, description, schema, handler) => {
    // 1. Add to universal registry (if not already there)
    if (!toolsRegistry.find((t) => t.name === name)) {
      toolsRegistry.push({ name, description, schema, handler });
    }

    // 2. Register to the MCP server instance (if provided)
    if (serverInstance) {
      let validSchema;
      try {
        // Schema can be a raw object or a Zod object
        validSchema = (schema instanceof z.ZodType) ? schema : z.object(schema ?? {});
      } catch (error) {
        throw new Error(
          `Tool ${name} has an invalid input schema: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      serverInstance.registerTool(
        name,
        {
          description,
          inputSchema: validSchema
        },
        async (params) => {
          try {
            // Unwrap common client wrappers (e.g., Roo Code/Cliner often use nativeArgs or arguments)
            const toolArgs = params?.nativeArgs || params?.arguments || params || {};
            
            const data = await handler(toolArgs);
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
        }
      );
    }
  };

  // ─── Resources ─────────────────────────────────────────────
  
  if (serverInstance) {
    serverInstance.registerResource(
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
  }


  // ═══════════════════════════════════════════════════════════
  // ─── Guide ─────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_tool_guide",
    "Read this first. Returns the canonical one-file guide for available tools and usage rules.",
    z.object({}),
    async () => ({ resourceUri: TOOL_GUIDE_URI, guide: await readToolGuide() })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Session & Navigation ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_open",
    `MANDATORY DEFAULT: Open a URL in the EXTERNAL headed browser for real-time user feedback. 
Use this for EVERY URL-related task. The user wants to see the browser window move and act. 
✨ AI BEST PRACTICE: 
1. ALWAYS call browser_sessions first to check for existing sessions. 
2. Set persist=true to keep cookies/logins. 
3. If navigation fails, try increasing timeout with browser_wait before retrying.`,
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

  tool("browser_sessions", "List all active browser sessions. ALWAYS call this before browser_open to check if a session already exists.", {}, () => browserService.getSessions());

  tool(
    "browser_reconnect",
    "Reconnect to a session that may have become unresponsive. Re-injects the interaction monitor. Use this instead of closing and recreating a session.",
    {
      sessionId: z.string().describe("Session ID to reconnect")
    },
    ({ sessionId }) => browserService.reconnectSession({ sessionId })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Interaction (Single) ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_click",
    `Click an element by CSS selector or natural-language query. 
✨ AI BEST PRACTICE: 
1. Always call browser_analyze before this to find the most stable CSS selector. 
2. If this is a 'Submit' button for a form, consider using 'browser_fill_form' to fill the form BEFORE clicking submit!
3. If click has no visible effect, try browser_wait or use settlePolicy='strict'. 
4. Verify the result with browser_screenshot.`,
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
    "Type text into an input element. Automatic clearing of existing content is performed first.\n⚠️ AI BEST PRACTICE: If you are filling a form with multiple fields, DO NOT use browser_type repeatedly. Use 'browser_fill_form' instead to fill all fields in ONE fast operation.",
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
    "Hover the mouse pointer over an element. Use browser_vision_hover for AI-analyzed hover effect detection.",
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

  // ═══════════════════════════════════════════════════════════
  // ─── Batch Operations (FAST) ───────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_fill_form",
    "HIGH PRIORITY: Fill multiple form fields in ONE call. Pass fields as a key-value object: { 'First Name field': 'John', 'Email address': 'john@example.com' }. This is HIGHLY RECOMMENDED over calling browser_type multiple times as it executes 5x faster.",
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

  // ═══════════════════════════════════════════════════════════
  // ─── Inspection & Testing ──────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_analyze",
    `Analyze current page DOM including interactive elements (buttons, links, forms). 
✨ AI BEST PRACTICE: 
Run this tool before ANY interaction (click, type, fill_form) to discover valid selectors and page structure. It returns the most reliable identifiers for other tools.`,
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

    const screenshotHandler = async (args) => {
      const { sessionId, fileName, fullPage, embedImage, saveLocal } = args ?? {};
      const data = await browserService.screenshot({
        sessionId,
        fileName,
        fullPage,
        embedImage: embedImage !== undefined ? !!embedImage : true,
        saveLocal: !!saveLocal
      });
      return data;
    };

    // 1. Add to universal registry
    if (!toolsRegistry.find((t) => t.name === "browser_screenshot")) {
      toolsRegistry.push({
        name: "browser_screenshot",
        description: "Take a screenshot. ALWAYS take a screenshot after making changes to verify them visually.",
        schema: screenshotSchema,
        handler: screenshotHandler
      });
    }

    // 2. Register to MCP instance with special formatting for images
    if (serverInstance) {
      serverInstance.registerTool(
        "browser_screenshot",
        {
          description: "Take a screenshot. By default, it returns the image directly to your chat (embedImage=true) and DOES NOT save it to disk (saveLocal=false). ALWAYS take a screenshot after making changes to verify them visually.",
          inputSchema: screenshotSchema
        },
        async (args) => {
          try {
            const data = await screenshotHandler(args);
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

  // ═══════════════════════════════════════════════════════════
  // ─── Deep Clone & Pixel-Perfect Tools ──────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_deep_clone",
    `Extract EVERYTHING needed to pixel-perfect clone a webpage: ALL CSS rules (including :hover, :focus, :active, @keyframes, @media), font-faces, asset URLs (images, SVGs, icons, background images), external stylesheet links, external font links, meta tags, and a full DOM tree with computed styles. Also takes a full-page reference screenshot. Use this as your FIRST step when cloning a website.`,
    {
      sessionId: z.string(),
      selector: z.string().optional().describe("Root element to extract (default: 'body')")
    },
    ({ sessionId, selector }) => browserService.deepClone({ sessionId, selector })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Vision AI Tools (Gemini Flash) ────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_vision_analyze",
    `Take a screenshot and send it to AI (Gemini Flash) for visual analysis. The AI can describe layout, colors, fonts, spacing, hover effects, animations — anything visible. Use this when DOM inspection is not enough. Requires GEMINI_API_KEY in .env.`,
    {
      sessionId: z.string(),
      prompt: z.string().optional().describe("Custom analysis prompt (default: general page analysis)"),
      fullPage: z.boolean().optional().default(false)
    },
    async ({ sessionId, prompt, fullPage }) => {
      const session = browserService.getSession(sessionId);
      if (!session) throw new Error("Session not found");

      const buffer = await session.page.screenshot({ fullPage: !!fullPage });
      const result = await visionService.analyzeScreenshot(buffer, prompt);

      return {
        sessionId,
        url: session.page.url(),
        visionAvailable: true,
        ...result
      };
    }
  );

  tool(
    "browser_vision_compare",
    `Compare the current page screenshot with a reference image file. Returns a similarity score (0-100) and detailed list of visual differences. Use this to verify your clone matches the original. Requires GEMINI_API_KEY.`,
    {
      sessionId: z.string(),
      referenceImagePath: z.string().describe("Absolute path to the reference screenshot (e.g., from browser_deep_clone)"),
      fullPage: z.boolean().optional().default(true)
    },
    async ({ sessionId, referenceImagePath, fullPage }) => {
      const session = browserService.getSession(sessionId);
      if (!session) throw new Error("Session not found");

      const currentBuffer = await session.page.screenshot({ fullPage: !!fullPage });
      const referenceBuffer = await fs.readFile(referenceImagePath);
      const result = await visionService.compareScreenshots(referenceBuffer, currentBuffer);

      return {
        sessionId,
        url: session.page.url(),
        referenceImagePath,
        ...result
      };
    }
  );

  tool(
    "browser_vision_hover",
    `Hover an element, capture before/after screenshots, and use AI to describe exactly what visual changes occur (color shifts, shadows, scale, transitions). Returns suggested CSS :hover rules. Perfect for replicating hover effects. Requires GEMINI_API_KEY.`,
    {
      sessionId: z.string(),
      selector: z.string().optional().describe("CSS selector for the element to hover"),
      query: z.string().optional().describe("Natural language query for the element to hover")
    },
    async ({ sessionId, selector, query }) => {
      const hoverData = await browserService.captureHoverEffect({ sessionId, selector, query });
      const result = await visionService.analyzeHoverEffect(
        hoverData.beforeBuffer,
        hoverData.afterBuffer,
        query || selector
      );

      return {
        sessionId,
        selector: hoverData.selector,
        strategy: hoverData.strategy,
        ...result
      };
    }
  );

  tool(
    "browser_vision_design_system",
    `Extract the visual design system from a screenshot using AI: colors (primary, secondary, accent, background), typography (fonts, sizes, weights), spacing, border radius, shadows, layout type. Requires GEMINI_API_KEY.`,
    {
      sessionId: z.string(),
      fullPage: z.boolean().optional().default(false)
    },
    async ({ sessionId, fullPage }) => {
      const session = browserService.getSession(sessionId);
      if (!session) throw new Error("Session not found");

      const buffer = await session.page.screenshot({ fullPage: !!fullPage });
      const result = await visionService.extractVisualDesignSystem(buffer);

      return { sessionId, url: session.page.url(), ...result };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Scratchpad (Agent Testing Area) ───────────────────────
  // ═══════════════════════════════════════════════════════════

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
    "browser_scratchpad_write",
    `Write/create a file in the isolated scratchpad directory (.scratchpad/). Use this for ALL temporary files, test code, drafts, and experiments. These files NEVER appear in the user's project. The scratchpad is auto-cleaned when the session closes.`,
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to create (e.g., 'test.html', 'draft.css', 'notes.md')"),
      content: z.string().describe("File content to write")
    },
    ({ sessionId, filename, content }) => scratchpadService.writeFile(sessionId, filename, content)
  );

  tool(
    "browser_scratchpad_read",
    "Read a file from the scratchpad.",
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to read")
    },
    ({ sessionId, filename }) => scratchpadService.readFile(sessionId, filename)
  );

  tool(
    "browser_scratchpad_list",
    "List all files in the scratchpad for a session.",
    { sessionId: z.string() },
    ({ sessionId }) => scratchpadService.listFiles(sessionId)
  );

  tool(
    "browser_scratchpad_delete",
    "Delete a file from the scratchpad.",
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to delete")
    },
    ({ sessionId, filename }) => scratchpadService.deleteFile(sessionId, filename)
  );

  tool(
    "browser_scratchpad_preview",
    `Serve a scratchpad HTML file via the local HTTP server and open it in the browser for visual testing. This lets you preview test pages without touching the user's project.`,
    {
      sessionId: z.string(),
      filename: z.string().describe("HTML filename in the scratchpad to preview")
    },
    async ({ sessionId, filename }) => {
      const previewUrl = scratchpadService.getPreviewUrl(sessionId, filename);
      // Open in the same session's browser
      const result = await browserService.openUrl({ sessionId, url: previewUrl });
      return { ...result, previewUrl, filename };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Configuration ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

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
      if (turboMode !== undefined) config.turboMode = turboMode;
      if (interactionLock !== undefined) config.interactionLock = interactionLock;
      return { ok: true, status: { turboMode: config.turboMode, interactionLock: config.interactionLock } };
    }
  );
};

/**
 * Standard server instance (exported for Stdio and shared logic).
 */
export const server = new McpServer(serverMetadata, {});

/**
 * Entry point for starting the server in Stdio mode (and the HTTP dashboard).
 */
export const runServer = async () => {
  // Register tools on the primary instance
  registerAllTools(server);

  const transport = new StdioServerTransport();

  // Also start the HTTP dashboard/SSE server on port 1000
  const app = createApp();
  const httpServer = app.listen(config.port, config.host, () => {
    // Write to stderr so we don't pollute MCP stdio transport (which uses stdout)
    console.error(`[INFO] Dashboard & REST API listening on http://${config.host}:${config.port}`);
    console.error(`[INFO] Transport mode: Stdio (primary) + HTTP (secondary)`);
    console.error(`[INFO] Vision AI: ${visionService.isAvailable() ? "ENABLED ✓" : "DISABLED (set GEMINI_API_KEY in .env)"}`);
    console.error(`[INFO] Scratchpad: ${config.scratchpadDir}`);
    console.error(`[INFO] Session Reuse: ${config.sessionReuse ? "ON" : "OFF"}`);
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[WARNING] Port ${config.port} is already in use by another instance! Skipping HTTP Dashboard... but MCP Stdio tools will continue to work perfectly. TIP: Change PORT in your .env file to run multiple dashboards.`);
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

  await server.connect(transport);
};

// Only connect to Stdio if this file is run directly
const isMainModule = () => {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = path.resolve(process.argv[1]).toLowerCase();
    const modulePath = path.resolve(moduleFilePath).toLowerCase();
    // Allow direct run or run via the mcp-server.js wrapper
    return scriptPath === modulePath || scriptPath.endsWith('mcp-server.js');
  } catch (e) {
    return false;
  }
};

// Initialize tools on load so the registry is available for REST even before runServer is called
registerAllTools();

if (isMainModule()) {
  runServer().catch(console.error);
}
