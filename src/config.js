import "dotenv/config";

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
  screenshotDir: process.env.SCREENSHOT_DIR || "screenshots",
  /** When true, screenshots are stored under screenshots/<sessionId>/ and removed entirely on cleanup. */
  sessionScreenshotSubdirs: toBoolean(process.env.SESSION_SCREENSHOT_SUBDIRS, true),
  downloadsDir: process.env.DOWNLOADS_DIR || "downloads",
  autoCleanup: toBoolean(process.env.AUTO_CLEANUP, false),
  defaultViewport: {
    width: Number(process.env.VIEWPORT_WIDTH || 1920),
    height: Number(process.env.VIEWPORT_HEIGHT || 1080)
  },
  stealthMode: toBoolean(process.env.STEALTH_MODE, true),
  turboMode: toBoolean(process.env.TURBO_MODE, true),
  interactionLock: toBoolean(process.env.INTERACTION_LOCK, true)
};
