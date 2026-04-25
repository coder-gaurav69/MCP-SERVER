import "dotenv/config";
import path from "node:path";

const toBoolean = (value, fallback = true) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
};

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 1000),
  defaultHeadless: toBoolean(process.env.HEADLESS, false),
  defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 10000),
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  // In headed mode, Playwright can either use a fixed viewport or let the OS window drive it (viewport: null).
  // These defaults ensure the Chromium window opens at a consistent desktop size so responsive UIs don't hide content.
  browserWindowWidth: Number(process.env.BROWSER_WINDOW_WIDTH || 1920),
  browserWindowHeight: Number(process.env.BROWSER_WINDOW_HEIGHT || 1080),
  // Use a real system browser for "normal" rendering on Windows.
  // Options commonly supported by Playwright: "chrome", "msedge". If empty, uses bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL || "",
  // Force Chromium/Chrome device scale factor (helps when Windows display scaling makes UI look "zoomed" or clipped).
  // Typical values: 1, 0.9, 0.8, 1.25, 1.5
  // NOTE: keep empty by default; only use if explicitly set (mostly useful for headless consistency).
  browserScaleFactor: process.env.BROWSER_SCALE_FACTOR ? Number(process.env.BROWSER_SCALE_FACTOR) : null,
  screenshotDir: process.env.SCREENSHOT_DIR || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "screenshots"),
  /** When true, screenshots are stored under screenshots/<sessionId>/ and removed entirely on cleanup. */
  sessionScreenshotSubdirs: toBoolean(process.env.SESSION_SCREENSHOT_SUBDIRS, true),
  downloadsDir: process.env.DOWNLOADS_DIR || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "downloads"),
  userDataDir: process.env.USER_DATA_DIR || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "user_data"),
  autoCleanup: toBoolean(process.env.AUTO_CLEANUP, false),
  defaultViewport: {
    width: Number(process.env.VIEWPORT_WIDTH || 1920),
    height: Number(process.env.VIEWPORT_HEIGHT || 1080)
  },
  stealthMode: toBoolean(process.env.STEALTH_MODE, true),
  turboMode: toBoolean(process.env.TURBO_MODE, false),
  interactionLock: toBoolean(process.env.INTERACTION_LOCK, true),

  // ─── Vision AI (Gemini Flash) ────────────────────────────
  visionEnabled: toBoolean(process.env.VISION_ENABLED, true),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  visionModel: process.env.VISION_MODEL || "gemini-2.0-flash",
  visionMaxTokens: Number(process.env.VISION_MAX_TOKENS || 4096),

  // ─── Figma API ───────────────────────────────────────────
  figmaApiToken: process.env.FIGMA_API_TOKEN || "",
  figmaApiBaseUrl: process.env.FIGMA_API_BASE_URL || "https://api.figma.com/v1",

  // ─── Agent Scratchpad ────────────────────────────────────
  scratchpadDir: process.env.SCRATCHPAD_DIR || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "ai_workspace"),

  // ─── Session Persistence ─────────────────────────────────
  /** When true, browser_open will reuse an existing session for the same domain instead of creating a new one. */
  sessionReuse: toBoolean(process.env.SESSION_REUSE, true),

  // ─── Redis + Queue ──────────────────────────────────────
  /** Redis connection URL. Leave empty to use in-memory fallback. */
  redisUrl: process.env.REDIS_URL || "",
  /** Number of concurrent jobs the worker can process. */
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),

  // ─── Logging ────────────────────────────────────────────
  logsDir: process.env.LOGS_DIR || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "logs"),

  // ─── AI Decision Layer ──────────────────────────────────
  /** Enable AI-powered self-healing selectors and NL→automation planning. */
  aiDecisionEnabled: toBoolean(process.env.AI_DECISION_ENABLED, true),
  /** Enable self-healing selectors (DOM heuristic + AI fallback). */
  selfHealingEnabled: toBoolean(process.env.SELF_HEALING_ENABLED, true),

  // ─── Web Search ──────────────────────────────────────────
  searchMaxResults: Number(process.env.SEARCH_MAX_RESULTS || 10),
  searchTimeoutMs: Number(process.env.SEARCH_TIMEOUT_MS || 15000),

  // ─── MCP Data ───────────────────────────────────────────
  mcpDataDir: process.env.MCP_DATA_DIR || ".mcp_data"
};
