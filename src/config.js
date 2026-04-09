const toBoolean = (value, fallback = true) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
};

export const config = {
  port: Number(process.env.PORT || 3000),
  defaultHeadless: toBoolean(process.env.HEADLESS, true),
  defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 10000),
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  screenshotDir: process.env.SCREENSHOT_DIR || "screenshots"
};
