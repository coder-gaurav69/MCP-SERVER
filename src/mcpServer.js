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

import { browserService, setBrowserServiceWs } from "./services/browserService.js";
import { visionService } from "./services/visionService.js";
import { scratchpadService } from "./services/scratchpadService.js";
import { figmaService } from "./services/figmaService.js";
import { figmaGeneratorService } from "./services/figmaGeneratorService.js";
import { webSearchService } from "./services/webSearchService.js";
import { projectSyncService } from "./services/projectSyncService.js";
import { aiDecisionService } from "./services/aiDecisionService.js";
import { queueService } from "./services/queueService.js";
import { workerService } from "./services/workerService.js";
import { selfHealingSelector } from "./services/selfHealingSelector.js";
import { sessionStore } from "./services/sessionStore.js";
import { wsService } from "./services/wsService.js";
import { createServiceLogger } from "./services/loggerService.js";
import { createApp } from "./app.js";
import { config } from "./config.js";

const bootLog = createServiceLogger("boot");

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
                error: (error instanceof Error ? error.message : String(error || "Unknown error")) + 
                       (error.message.includes("Target closed") ? "\n\n💡 TIP: Browser crashed. Purging stale session. Please try browser_open again." : "")
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
    `Open a URL in the EXTERNAL headed browser.
⚠️ CRITICAL RULES:
1. For the FIRST visit to a new website: use browser_open with the full URL.
2. For navigating WITHIN the same website: DO NOT call browser_open with fabricated routes (e.g. /about, /services). The system will REJECT URLs that don't have a matching link on the current page.
3. Instead, use browser_click with the visible link text (e.g. query="About" or query="Contact").
4. After opening a page, check 'availableLinks' in the response to see what pages you can visit next.
5. If you get status=link_not_found, it means that URL does not exist as a link on the page. Use browser_click instead.`,
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

  tool(
    "browser_cleanup",
    "FORCE-CLEAR ALL SESSIONS. Use this ONLY as a last resort if you get stuck in a loop of browser errors. It wipes all sessions and starts fresh.",
    {},
    () => browserService.closeAll()
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
  // ─── Smart Exploration ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_explore_site",
    `Smart site explorer. Discovers ALL real navigation links on the current page, then clicks each one (with visible mouse movement) and takes screenshots. Returns a map of all discovered pages.
⚠️ USE THIS instead of manually calling browser_open repeatedly with guessed URLs.
This tool does the work of exploring the entire site in one call.`,
    {
      sessionId: z.string().describe("Session ID from browser_open"),
      screenshotEach: z.boolean().optional().default(true).describe("Take a screenshot of each page visited")
    },
    async ({ sessionId, screenshotEach }) => {
      const session = browserService.getSession(sessionId);
      if (!session) throw new Error("Session not found");

      const links = await browserService.discoverNavLinks(session);
      const internalLinks = links.filter(l => l.isInternal);
      const visited = [];
      const startUrl = session.page.url();

      for (const link of internalLinks) {
        try {
          // Click using browser_click (humanoid movement)
          await browserService.click({ sessionId, query: link.text });
          await new Promise(r => setTimeout(r, 500));

          const pageUrl = session.page.url();
          const pageTitle = await session.page.title();
          
          let screenshotPath = null;
          if (screenshotEach) {
            const fileName = `explore-${link.text.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}.png`;
            const result = await browserService.screenshot({ sessionId, saveLocal: true, fileName });
            screenshotPath = result.path;
          }
          
          visited.push({
            linkText: link.text,
            url: pageUrl,
            title: pageTitle,
            screenshot: screenshotPath,
            status: "success"
          });
        } catch (err) {
          visited.push({
            linkText: link.text,
            url: link.fullUrl,
            status: "failed",
            error: err.message
          });
        }
      }

      return {
        sessionId,
        startUrl,
        pagesExplored: visited.length,
        pages: visited,
        allLinks: links
      };
    }
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

  // ═══════════════════════════════════════════════════════════
  // ─── Figma Integration ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_figma_file",
    "Fetch a Figma file (by file key or full Figma URL). Returns document tree and metadata for AI-driven design implementation.",
    {
      fileKeyOrUrl: z.string().describe("Figma file key or full URL"),
      depth: z.number().optional().default(3).describe("How deep the document tree should be fetched"),
      ids: z.string().optional().describe("Optional comma-separated node IDs to focus"),
      version: z.string().optional().describe("Optional specific file version")
    },
    (args) => figmaService.getFile(args)
  );

  tool(
    "browser_figma_nodes",
    "Fetch specific node(s) from a Figma file. Use this for precise components/frames.",
    {
      fileKeyOrUrl: z.string().describe("Figma file key or full URL"),
      nodeIds: z.union([z.string(), z.array(z.string())]).describe("Node ID string (comma-separated) or array of IDs")
    },
    (args) => figmaService.getNodes(args)
  );

  tool(
    "browser_figma_design_context",
    "AI-ready design context from Figma: top frames + selected node style/layout details.",
    {
      fileKeyOrUrl: z.string().describe("Figma file key or full URL"),
      nodeIds: z.union([z.string(), z.array(z.string())]).optional().describe("Optional specific node IDs"),
      depth: z.number().optional().default(4)
    },
    (args) => figmaService.getDesignContext(args)
  );

  tool(
    "browser_figma_to_clone_plan",
    "Autopilot planner: converts Figma file/nodes into an actionable same-to-same implementation plan with execution order and verification checklist.",
    {
      fileKeyOrUrl: z.string().describe("Figma file key or full URL"),
      nodeIds: z.union([z.string(), z.array(z.string())]).optional().describe("Optional specific node IDs"),
      depth: z.number().optional().default(4).describe("Tree depth for extraction"),
      framework: z.string().optional().default("react-tailwind").describe("Target stack hint, e.g. react-tailwind, html-css, nextjs")
    },
    (args) => figmaService.buildClonePlan(args)
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
    "HIGH PRIORITY: Fill multiple form fields in ONE call. Pass fields as a key-value object: { 'First Name field': 'John', 'Email address': 'john@example.com' }. Set turbo=true for maximum speed (skips mouse animations). Recommended for complex forms.",
    {
      sessionId: z.string(),
      fields: z.record(z.string()),
      turbo: z.boolean().optional().describe("When true, executes at maximum speed by skipping mouse movements and using fast settling.")
    },
    ({ sessionId, fields, turbo }) => browserService.fillForm({ sessionId, fields, turbo })
  );

  tool(
    "browser_autofill",
    "AUTOPILOT: AI-driven autonomous form solver. Analyzes the current page, generates contextually appropriate data based on a high-level goal, and fills the form using the strict humanoid engine. No manual field mapping required.",
    {
      sessionId: z.string(),
      goal: z.string().optional().describe("High-level goal for data generation (e.g. 'fill as a patient', 'use dummy info')")
    },
    ({ sessionId, goal }) => browserService.autofill({ sessionId, goal })
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
    "browser_discover",
    "DEEP EXPLORATION: Find all interactive elements (links, buttons, inputs) with heuristics. Use this for mapping out a website or finding hidden navigation paths.",
    { sessionId: z.string() },
    ({ sessionId }) => browserService.discoverClickables(sessionId)
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
        .union([z.boolean(), z.enum(["lean"])])
        .optional()
        .default(true)
        .describe("When true (default), returns an MCP image content block. Set to false or 'lean' to suppress large image data and only get text analysis."),
      saveLocal: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, also saves the screenshot to the server's local disk. Default is false to keep your drive clean."),
      analyze: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, uses Vision AI (Gemini Flash 2) to provide a text description of the screenshot."),
      prompt: z
        .string()
        .optional()
        .describe("Custom prompt for Vision AI analysis (e.g., 'Check if the login form is visible')")
    });

    const screenshotHandler = async (args) => {
      const { sessionId, fileName, fullPage, embedImage, saveLocal, analyze, prompt } = args ?? {};
      const data = await browserService.screenshot({
        sessionId,
        fileName,
        fullPage,
        embedImage: embedImage !== undefined ? !!embedImage : true,
        saveLocal: !!saveLocal,
        analyze: !!analyze,
        prompt
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
          description: "Take a screenshot. By default, it returns the image directly to your chat (embedImage=true). Set analyze=true to also get an AI-driven visual description of the page state.",
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

  tool(
    "browser_smart_scrape",
    "GOD-LEVEL SCRAPING: Automatically detect and extract structured data (lists, tables, product cards) from the current page. Smarter than basic DOM extraction.",
    {
      sessionId: z.string().describe("Session ID from browser_open"),
      query: z.string().optional().describe("Hint for what to scrape (e.g. 'product list')"),
      maxItems: z.number().optional().default(20).describe("Max items to extract")
    },
    (args) => browserService.smartScrape(args)
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Vision AI Tools (Gemini Flash) ────────────────────────
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
    `Write/create a file in the isolated AI workspace. Use this for ALL generated scripts, tests, pages, drafts, and experiments. Never create temporary files in the project root.`,
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to create (e.g., 'test.html', 'draft.css', 'notes.md')"),
      category: z.enum(["scripts", "tests", "pages", "artifacts", "notes", "tmp"]).optional().default("tmp").describe("Workspace folder for this file. Use scripts for automation code, tests for test files, pages for HTML previews, artifacts for generated outputs, notes for planning."),
      content: z.string().describe("File content to write")
    },
    ({ sessionId, filename, category, content }) => scratchpadService.writeFile(sessionId, filename, content, category)
  );

  tool(
    "browser_scratchpad_read",
    "Read a file from the scratchpad.",
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to read"),
      category: z.enum(["scripts", "tests", "pages", "artifacts", "notes", "tmp"]).optional().default("tmp")
    },
    ({ sessionId, filename, category }) => scratchpadService.readFile(sessionId, filename, category)
  );

  tool(
    "browser_scratchpad_list",
    "List all files in the scratchpad for a session.",
    {
      sessionId: z.string(),
      category: z.enum(["scripts", "tests", "pages", "artifacts", "notes", "tmp"]).optional()
    },
    ({ sessionId, category }) => scratchpadService.listFiles(sessionId, category)
  );

  tool(
    "browser_scratchpad_delete",
    "Delete a file from the scratchpad.",
    {
      sessionId: z.string(),
      filename: z.string().describe("Filename to delete"),
      category: z.enum(["scripts", "tests", "pages", "artifacts", "notes", "tmp"]).optional().default("tmp")
    },
    ({ sessionId, filename, category }) => scratchpadService.deleteFile(sessionId, filename, category)
  );

  tool(
    "browser_scratchpad_preview",
    `Serve a scratchpad HTML file via the local HTTP server and open it in the browser for visual testing. This lets you preview test pages without touching the user's project.`,
    {
      sessionId: z.string(),
      filename: z.string().describe("HTML filename in the scratchpad to preview"),
      category: z.enum(["pages", "artifacts", "tmp"]).optional().default("pages")
    },
    async ({ sessionId, filename, category }) => {
      const previewUrl = scratchpadService.getPreviewUrl(sessionId, filename, category);
      // Open in the same session's browser
      const result = await browserService.openUrl({ sessionId, url: previewUrl });
      return { ...result, previewUrl, filename, category };
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

  // ═══════════════════════════════════════════════════════════
  // ─── Project Sync & Root Safety ────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_project_sync_status",
    "Check project sync health: managed .mcp_data directories + root clutter detection.",
    {},
    async () => projectSyncService.syncStatus()
  );

  tool(
    "browser_project_sync_fix",
    "Auto-fix project sync issues: ensures managed directories and optionally removes known AI temp clutter from root.",
    {
      cleanupRootClutter: z.boolean().optional().default(true)
    },
    async ({ cleanupRootClutter }) => projectSyncService.syncFix({ cleanupRootClutter })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── AI Decision Layer ────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_ai_plan",
    "AI-POWERED: Convert a natural language goal into executable automation steps. Example: 'login with email test@test.com and password 123'. Returns a sequence of browser_* tool calls. Requires GEMINI_API_KEY.",
    {
      sessionId: z.string().optional().describe("Session ID for page context"),
      goal: z.string().describe("Natural language goal (e.g. 'fill the signup form with name John')"),
      execute: z.boolean().optional().default(false).describe("When true, executes the plan immediately instead of just returning it")
    },
    async ({ sessionId, goal, execute }) => {
      let context = {};
      if (sessionId) {
        const session = browserService.getSession(sessionId);
        if (session) {
          const state = await browserService.analyzePageState(session);
          context = {
            url: state.url,
            pageTitle: state.title,
            interactiveElements: state.elements
          };
        }
      }

      const plan = await aiDecisionService.planFromGoal(goal, context);

      if (!execute) {
        return { plan, executed: false, tip: "Set execute=true to run this plan automatically" };
      }

      // Execute the plan
      const results = [];
      for (const step of plan.steps) {
        try {
          const params = { ...step.params, sessionId: step.params.sessionId || sessionId || "auto" };
          const tool = toolsRegistry.find(t => t.name === step.tool);
          if (tool) {
            const result = await tool.handler(params);
            results.push({ tool: step.tool, status: "success", result });
          } else {
            results.push({ tool: step.tool, status: "skipped", reason: "Tool not found" });
          }
        } catch (err) {
          results.push({ tool: step.tool, status: "failed", error: err.message });
        }
      }

      return { plan, executed: true, results };
    }
  );

  tool(
    "browser_ai_suggest_selector",
    "AI-POWERED: Find the best CSS selector for an element described in natural language. Uses current page DOM for context.",
    {
      sessionId: z.string().describe("Session ID"),
      description: z.string().describe("Natural language description of the element (e.g. 'the blue submit button')")
    },
    async ({ sessionId, description }) => {
      const session = browserService.getSession(sessionId);
      if (!session) throw new Error("Session not found");

      const state = await browserService.analyzePageState(session);
      const suggestion = await aiDecisionService.suggestSelector(description, state.elements);

      return { sessionId, description, ...suggestion };
    }
  );

  tool(
    "browser_analyze_enhanced",
    "ENHANCED page analysis: Returns interactive elements WITH AI-generated semantic labels (e.g. 'Login email input', 'Submit button'). Set aiLabels=true for AI enhancement. Requires GEMINI_API_KEY.",
    {
      sessionId: z.string(),
      aiLabels: z.boolean().optional().default(false).describe("When true, uses AI to add semantic labels to each element")
    },
    ({ sessionId, aiLabels }) => browserService.analyzeEnhanced({ sessionId, aiLabels })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Queue & Worker Management ───────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_queue_job",
    "Enqueue a browser automation job for async processing. Requires Redis. Returns a jobId for tracking.",
    {
      action: z.string().describe("Tool name to execute (e.g. 'browser_click')"),
      params: z.record(z.any()).describe("Parameters for the tool"),
      priority: z.number().optional().default(0).describe("Job priority (lower = higher priority)")
    },
    async ({ action, params, priority }) => {
      if (!queueService.isReady) {
        throw new Error("Queue not available. Set REDIS_URL in .env to enable job queues.");
      }
      return queueService.enqueue(action, params, { priority });
    }
  );

  tool(
    "browser_job_status",
    "Check the status of a queued job by its jobId.",
    {
      jobId: z.string().describe("Job ID returned from browser_queue_job")
    },
    ({ jobId }) => queueService.getJobStatus(jobId)
  );

  tool(
    "browser_queue_status",
    "Get queue health metrics: waiting, active, completed, failed job counts.",
    {},
    () => queueService.getMetrics()
  );

  tool(
    "browser_list_jobs",
    "List recent queued jobs with their statuses.",
    {
      status: z.enum(["all", "completed", "failed", "active", "waiting"]).optional().default("all"),
      limit: z.number().optional().default(20)
    },
    ({ status, limit }) => queueService.listJobs({ status, limit })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Monitoring & Debug ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_healing_stats",
    "Get self-healing selector statistics: success rate, strategies used, and recent healing log.",
    {},
    () => ({
      stats: selfHealingSelector.getStats(),
      recentLog: selfHealingSelector.getHealingLog().slice(-10)
    })
  );

  tool(
    "browser_system_status",
    "Full system health: queue metrics, worker stats, WebSocket clients, Redis status, session store, healing stats.",
    {},
    async () => ({
      queue: await queueService.getMetrics(),
      worker: workerService.getStats(),
      websocket: wsService.getStats(),
      redis: sessionStore.isRedisConnected,
      healing: selfHealingSelector.getStats(),
      aiDecision: aiDecisionService.isAvailable(),
      sessions: browserService.getSessions()?.length || 0
    })
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Web Search & Content Extraction (FREE) ───────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "web_search",
    `Search the web for information using DuckDuckGo (FREE, no API key needed). Returns titles, URLs, and snippets for the query. Use this to research topics, find documentation, or look up information.`,
    {
      query: z.string().describe("Search query (e.g. 'React form handling best practices')"),
      maxResults: z.number().optional().default(10).describe("Maximum number of results to return")
    },
    ({ query, maxResults }) => webSearchService.search(query, maxResults)
  );

  tool(
    "web_extract",
    `Extract clean text content from a URL. Strips HTML, scripts, and styles. Returns title, description, clean text, and optionally structured data (headings, links, images). FREE, no API key needed.`,
    {
      url: z.string().describe("URL to extract content from"),
      maxLength: z.number().optional().default(10000).describe("Maximum text length to return"),
      structured: z.boolean().optional().default(false).describe("When true, also extracts headings, links, and images as structured data")
    },
    ({ url, maxLength, structured }) => webSearchService.extractContent(url, { maxLength, structured })
  );

  tool(
    "web_search_extract",
    `Search + Extract in one call: search the web, then fetch and parse the top N results. Returns enriched results with full page content. FREE, no API key needed.`,
    {
      query: z.string().describe("Search query"),
      topN: z.number().optional().default(3).describe("How many top results to fetch full content from"),
      maxContentLength: z.number().optional().default(3000).describe("Max content per page")
    },
    ({ query, topN, maxContentLength }) => webSearchService.searchAndExtract(query, topN, maxContentLength)
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Figma Design Generator (FREE, rule-based) ────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "figma_generate_design",
    `Generate a Figma-compatible design layout from a page description. NO API key or paid service needed — uses rule-based generation. Detects page type (login, signup, dashboard) and generates a premium dark-mode design with proper tokens, layout nodes, and CSS implementation hints.`,
    {
      description: z.string().describe("Page description (e.g. 'login page', 'admin dashboard', 'signup form')"),
      title: z.string().optional().describe("Custom page title override"),
      subtitle: z.string().optional().describe("Custom subtitle override")
    },
    ({ description, title, subtitle }) => {
      const result = figmaGeneratorService.generateDesign(description, { title, subtitle });
      return {
        ...result,
        implementationTasks: figmaGeneratorService.toImplementationPlan(result.layout)
      };
    }
  );

  // ═══════════════════════════════════════════════════════════
  // ─── Temp File Cleanup ────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  tool(
    "browser_cleanup_temp",
    `Clean up temporary files from .mcp_data/temp/ and other AI-generated clutter. Call this after completing a job to keep the project clean.`,
    {
      cleanRoot: z.boolean().optional().default(true).describe("Also clean root directory clutter")
    },
    async ({ cleanRoot }) => {
      const tempResult = await projectSyncService.cleanupTempFiles();
      let rootResult = { removed: [] };
      if (cleanRoot) {
        rootResult = await projectSyncService.syncFix({ cleanupRootClutter: true });
      }
      return {
        tempFilesRemoved: tempResult.removed,
        rootFilesRemoved: rootResult.removedFiles || [],
        status: "clean"
      };
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
  await projectSyncService.ensureManagedDirs();
  // Auto-clean any junk files that AI agents may have created in root
  await projectSyncService.autoCleanOnStartup();

  // ─── Boot New Services ─────────────────────────────────
  bootLog.info("Booting production services...");

  // 1. Session Store (Redis-backed or in-memory)
  await sessionStore.connect();
  bootLog.info(`Session Store: ${sessionStore.isRedisConnected ? "Redis" : "In-Memory"}`);

  // 2. Queue Service
  const queueReady = await queueService.init();
  bootLog.info(`Queue Service: ${queueReady ? "Redis/BullMQ" : "Disabled (no Redis)"}`);

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
    console.error(`[INFO] AI Decision: ${aiDecisionService.isAvailable() ? "ENABLED ✓" : "DISABLED"}`);
    console.error(`[INFO] Self-Healing: ${config.selfHealingEnabled ? "ENABLED ✓" : "DISABLED"}`);
    console.error(`[INFO] Queue: ${queueReady ? "ENABLED ✓" : "DISABLED (set REDIS_URL in .env)"}`);
    console.error(`[INFO] WebSocket: ws://${config.host}:${config.port}/ws`);
    console.error(`[INFO] Scratchpad: ${config.scratchpadDir}`);
    console.error(`[INFO] Session Reuse: ${config.sessionReuse ? "ON" : "OFF"}`);
  });

  // 3. Attach WebSocket to HTTP server
  wsService.attach(httpServer);
  setBrowserServiceWs(wsService);
  bootLog.info("WebSocket service attached");

  // 4. Start Worker (if queue available)
  if (queueReady) {
    await workerService.start({ browserService, queueService, wsService });
    bootLog.info("Worker service started");
  }

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
      console.error("\nShutting down, cleaning up...");
      await workerService.shutdown();
      await queueService.shutdown();
      await sessionStore.disconnect();
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

  bootLog.info("All services booted successfully");
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
