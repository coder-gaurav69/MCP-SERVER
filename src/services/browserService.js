import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { agentActivityService } from "./agentActivityService.js";

/** Kebab-case names for `getComputedStyle(...).getPropertyValue(...)` (clone / codegen helpers). */
const COMPUTED_STYLE_PROPERTY_KEYS = [
  "display", "position", "top", "right", "bottom", "left", "z-index",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-width", "border-style", "border-color", "border-radius", "border-top-width",
  "box-sizing", "overflow", "overflow-x", "overflow-y",
  "flex", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self", "flex-grow", "flex-shrink", "gap",
  "grid-template-columns", "grid-template-rows", "column-gap", "row-gap",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-align", "text-decoration", "text-transform", "white-space", "word-break",
  "color", "background-color", "background-image", "background-size", "background-position", "background-repeat", "opacity",
  "box-shadow", "transform", "transition", "visibility", "cursor", "object-fit"
];

class BrowserService {
  constructor() {
    this.sessions = new Map();
    this.flowTemplates = {
      login: [
        { action: "type", target: "email field", valueFrom: "email" },
        { action: "type", target: "username field", valueFrom: "username", optional: true },
        { action: "type", target: "password field", valueFrom: "password" },
        { action: "click", target: "login button" }
      ],
      signup: [
        { action: "type", target: "name field", valueFrom: "name" },
        { action: "type", target: "email field", valueFrom: "email" },
        { action: "type", target: "password field", valueFrom: "password" },
        { action: "type", target: "confirm password field", valueFrom: "confirmPassword", optional: true },
        { action: "click", target: "signup button" }
      ],
      formSubmission: [
        { action: "typeMany", valueFrom: "fields" },
        { action: "click", target: "submit button" }
      ]
    };
  }

  safeScreenshotSessionSegment(sessionId) {
    const s = String(sessionId ?? "session")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 200);
    return s || "session";
  }

  /** Resolved directory for this session's PNGs; falls back to flat `screenshotDir` if subdirs disabled. */
  sessionScreenshotRoot(sessionId) {
    if (!config.sessionScreenshotSubdirs) {
      return path.resolve(config.screenshotDir);
    }
    const base = path.resolve(config.screenshotDir);
    const sub = path.join(base, this.safeScreenshotSessionSegment(sessionId));
    const resolvedSub = path.resolve(sub);
    const rel = path.relative(base, resolvedSub);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid screenshot directory");
    }
    return resolvedSub;
  }

  urlPathKey(href) {
    try {
      const u = new URL(href);
      return `${u.origin}${u.pathname}${u.search}`;
    } catch {
      return href;
    }
  }

  async navigateInternalByClick(session, targetHref) {
    const page = session.page;
    const targetKey = this.urlPathKey(targetHref);
    if (this.urlPathKey(page.url()) === targetKey) {
      return { navigatedVia: "already_there" };
    }

    const clicked = await page.evaluate((want) => {
      for (const a of document.querySelectorAll("a[href]")) {
        if (a.href !== want) continue;
        const r = a.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        a.click();
        return true;
      }
      return false;
    }, targetHref);

    if (!clicked) {
      await page.goto(targetHref, { waitUntil: "domcontentloaded", timeout: config.defaultTimeoutMs });
      await this.waitForSettle(session);
      return { navigatedVia: "goto_fallback" };
    }

    try {
      await page.waitForFunction(
        (expected) => {
          try {
            const u = new URL(window.location.href);
            const cur = `${u.origin}${u.pathname}${u.search}`;
            return cur === expected;
          } catch {
            return false;
          }
        },
        targetKey,
        { timeout: config.defaultTimeoutMs }
      );
    } catch {
      await page.waitForTimeout(400);
    }
    await this.waitForSettle(session);
    return { navigatedVia: "click" };
  }

  async getOrCreateSession(sessionId, options = {}) {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const effectiveSessionId = sessionId || uuidv4();
    const headless =
      typeof options.headless === "boolean" ? options.headless : config.defaultHeadless;
    const persist = options.persist ?? false;
    const userDataDir = persist ? path.resolve("user_data", effectiveSessionId) : null;

    // Standard resolutions
    const width = config.defaultViewport.width;
    const height = config.defaultViewport.height;
    const scaleFactor = config.browserScaleFactor === null ? null : Number(config.browserScaleFactor);
    const browserChannel = String(config.browserChannel || "").trim();

    // IMPORTANT (Windows): in headed mode, using `viewport: null` makes the viewport follow
    // the real OS window size, preventing "missing/cut off" UI due to responsive breakpoints.
    // Playwright: launchPersistentContext rejects pairing `deviceScaleFactor` with `viewport: null`;
    // use a fixed viewport for headed persistent sessions.
    const viewport = headless ? { width, height } : persist ? { width, height } : null;
    const deviceScaleFactor = headless ? 1 : undefined;

    if (persist) {
      await fs.mkdir(userDataDir, { recursive: true });
    }

    let browser;
    let context;
    let page;

    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      `--window-size=${width},${height}`,
      "--start-maximized",
      "--disable-features=CalculateNativeWinOcclusion",
      // Stealth & UI Perfection
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-default-browser-check",
      // In headed mode we avoid forcing scale; let OS scaling behave like a normal browser.
      ...(headless && Number.isFinite(scaleFactor) && scaleFactor > 0
        ? [`--force-device-scale-factor=${scaleFactor}`]
        : [])
    ];

    const realUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

    const launchOptsBase = {
      headless,
      args: launchArgs,
      ignoreDefaultArgs: config.stealthMode ? ["--enable-automation"] : [],
      ...(browserChannel ? { channel: browserChannel } : {})
    };

    if (persist) {
      try {
        context = await chromium.launchPersistentContext(userDataDir, {
          ...launchOptsBase,
          viewport,
          userAgent: config.stealthMode ? realUserAgent : undefined,
          ...(deviceScaleFactor ? { deviceScaleFactor } : {})
        });
      } catch (e) {
        // If requested channel isn't available, fall back to bundled Chromium.
        context = await chromium.launchPersistentContext(userDataDir, {
          headless,
          args: launchArgs,
          viewport,
          ...(deviceScaleFactor ? { deviceScaleFactor } : {})
        });
      }
      page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    } else {
      try {
        browser = await chromium.launch(launchOptsBase);
      } catch (e) {
        browser = await chromium.launch({ headless, args: launchArgs });
      }
      context = await browser.newContext({
        viewport,
        userAgent: config.stealthMode ? realUserAgent : undefined,
        ...(headless ? { screen: { width, height } } : {}),
        ...(deviceScaleFactor ? { deviceScaleFactor } : {})
      });
      page = await context.newPage();
    }

    // NOTE: In headed mode we intentionally do NOT call page.setViewportSize().
    // When viewport=null, Playwright binds viewport to the OS window. Forcing a viewport
    // can reintroduce clipping/scroll issues on Windows scaling setups.

    const session = {
      id: effectiveSessionId,
      browser: browser || null,
      context,
      page,
      scratchpad: "",
      consoleErrors: [],
      networkErrors: [],
      networkRequests: [],
      logs: [],
      actionHistory: [],
      screenshotHistory: [],
      downloadHistory: [],
      lastAction: null,
      currentUrl: "about:blank",
      createdAt: new Date().toISOString(),
      isPersisted: persist,
      userDataDir: userDataDir,
      lastMousePos: { x: 960, y: 540 }
    };

    await this.injectInteractionMonitor(session);

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        session.consoleErrors.push({
          text: msg.text(),
          location: msg.location(),
          timestamp: new Date().toISOString()
        });
      }
    });

    page.on("requestfailed", (request) => {
      session.networkErrors.push({
        url: request.url(),
        method: request.method(),
        failureText: request.failure()?.errorText || "Unknown request failure",
        timestamp: new Date().toISOString()
      });
    });

    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) {
        session.networkErrors.push({
          url: response.url(),
          method: response.request().method(),
          failureText: `HTTP ${status}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    page.on("download", async (download) => {
      try {
        await fs.mkdir(config.downloadsDir, { recursive: true });
        const suggested = download.suggestedFilename?.() || `download-${Date.now()}`;
        const safeName = suggested.replace(/[^\w.\-() ]/g, "_");
        const outPath = path.resolve(config.downloadsDir, `${Date.now()}-${safeName}`);
        await download.saveAs(outPath);
        session.downloadHistory.push({
          path: outPath,
          suggestedFilename: suggested,
          url: download.url?.() || "",
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        session.downloadHistory.push({
          path: "",
          suggestedFilename: "",
          url: download.url?.() || "",
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error || "Unknown download error")
        });
      }
    });

    this.sessions.set(effectiveSessionId, session);
    this.logAction(session, {
      action: "session.create",
      result: "success",
      metadata: { headless, persist }
    });
    return session;
  }

  getSession(sessionId) {
    if (!sessionId || !this.sessions.has(sessionId)) return null;
    return this.sessions.get(sessionId);
  }

  logAction(session, { action, selector = "", result = "success", retryCount = 0, metadata = {} }) {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      selector,
      result,
      retryCount,
      metadata
    };
    session.logs.push(entry);
    session.lastAction = entry;
    session.currentUrl = session.page.url();
  }

  appendScratchpad(session, note) {
    const timestamp = new Date().toISOString().slice(11, 19);
    session.scratchpad += `[${timestamp}] ${note}\n`;
  }

  async withRetry(fn, retries = config.maxRetries) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  normalizeQuery(text = "") {
    return String(text)
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async injectInteractionMonitor(session) {
    if (!config.interactionLock) return;
    try {
      await session.page.exposeFunction("__mcpManualInteraction", () => {
        agentActivityService.notifyManualInteraction(session.id);
        this.appendScratchpad(session, "⚠ Manual user interaction detected");
      });

      // Inject into ALL frames
      await session.page.addInitScript(() => {
        const isStickyActive = () => {
          try { return sessionStorage.getItem('__mcpAgentActive') === 'true'; } catch { return false; }
        };

        window.__mcpAgentActive = isStickyActive();

        const setupUI = () => {
          // Only create overlay in the main frame, but block events in all frames
          const isMainFrame = window.self === window.top;
          if (!isMainFrame) return;

          if (document.getElementById('__mcpAgentOverlay')) return;

          const overlay = document.createElement('div');
          overlay.id = '__mcpAgentOverlay';
          overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.05);
            z-index: 2147483645;
            display: ${window.__mcpAgentActive ? 'block' : 'none'};
            pointer-events: all;
            cursor: wait;
            transition: opacity 0.3s ease;
            opacity: ${window.__mcpAgentActive ? '1' : '0'};
            user-select: none;
          `;

          const pulseBorder = document.createElement('div');
          pulseBorder.id = '__mcpAgentPulseBorder';
          pulseBorder.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            border: 0px solid rgba(239, 68, 68, 0);
            pointer-events: none;
            z-index: 2147483646;
            transition: all 0.2s ease;
          `;

          const controlCenter = document.createElement('div');
          controlCenter.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(15, 23, 42, 0.95);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: white;
            padding: 12px 24px;
            border-radius: 9999px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            align-items: center;
            gap: 12px;
            transition: transform 0.1s ease;
          `;

          const style = document.createElement('style');
          style.textContent = `
            @keyframes mcp-blink { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
            @keyframes mcp-shake-small { 0%, 100% { transform: translateX(-50%); } 25% { transform: translateX(-52%); } 75% { transform: translateX(-48%); } }
            .mcp-shake-small { animation: mcp-shake-small 0.3s ease-in-out; }
            .mcp-pulse-active { border: 4px solid rgba(239, 68, 68, 0.5) !important; box-shadow: inset 0 0 50px rgba(239, 68, 68, 0.2); }
          `;
          document.head.appendChild(style);

          const pulse = document.createElement('div');
          pulse.style.cssText = `width: 12px; height: 12px; background: #3b82f6; border-radius: 50%; animation: mcp-blink 1.5s infinite ease-in-out;`;

          const textWrapper = document.createElement('div');
          textWrapper.style.cssText = `display: flex; flex-direction: column;`;
          const title = document.createElement('span');
          title.style.cssText = `font-size: 14px; font-weight: 600;`;
          title.textContent = 'Agent is working...';
          const subtitle = document.createElement('span');
          subtitle.style.cssText = `font-size: 11px; color: #94a3b8;`;
          subtitle.textContent = 'Interaction locked for stability';

          textWrapper.appendChild(title);
          textWrapper.appendChild(subtitle);
          controlCenter.appendChild(pulse);
          controlCenter.appendChild(textWrapper);
          overlay.appendChild(controlCenter);
          document.documentElement.appendChild(overlay);
          document.documentElement.appendChild(pulseBorder);
        };

        window.__mcpUpdateAgentActive = (active) => {
          window.__mcpAgentActive = active;
          const overlay = document.getElementById('__mcpAgentOverlay');
          if (overlay) {
            if (active) {
              overlay.style.display = 'block';
              setTimeout(() => overlay.style.opacity = '1', 10);
            } else {
              overlay.style.opacity = '0';
              setTimeout(() => overlay.style.display = 'none', 300);
            }
          }
        };

        const intercept = (e) => {
          // Check session storage real-time in case it changed in another frame
          if (window.__mcpAgentActive || isStickyActive()) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            // Visual feedback
            const overlay = document.getElementById('__mcpAgentOverlay');
            const border = document.getElementById('__mcpAgentPulseBorder');
            const controlCenter = overlay?.querySelector('div');
            
            if (controlCenter) {
              controlCenter.classList.remove('mcp-shake-small');
              void controlCenter.offsetWidth;
              controlCenter.classList.add('mcp-shake-small');
            }
            if (border) {
              border.classList.add('mcp-pulse-active');
              setTimeout(() => border.classList.remove('mcp-pulse-active'), 500);
            }

            if (window.__mcpManualInteraction) window.__mcpManualInteraction();
            return false;
          }
        };

        ['mousedown', 'click', 'mouseup', 'keydown', 'keypress', 'keyup', 'input', 'change', 'focus', 'blur', 'wheel', 'touchstart', 'contextmenu']
          .forEach(type => window.addEventListener(type, intercept, true));

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', setupUI);
        } else {
          setupUI();
        }
        
        // Ensure UI stays on top
        const observer = new MutationObserver(() => {
          const overlay = document.getElementById('__mcpAgentOverlay');
          if (overlay && overlay.parentNode !== document.documentElement) {
            document.documentElement.appendChild(overlay);
          }
        });
        observer.observe(document.documentElement, { childList: true });
      });
    } catch (error) { /* ignore */ }
  }

  async injectVisualFeedback(session) {
    try {
      await session.page.addStyleTag({
        content: `
          @keyframes mcp-ripple {
            0% { transform: scale(0); opacity: 0.8; }
            100% { transform: scale(4); opacity: 0; }
          }
          .mcp-ripple-container {
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none; z-index: 999999;
          }
          .mcp-ripple {
            position: absolute;
            width: 50px; height: 50px;
            background: rgba(255, 0, 0, 0.4);
            border-radius: 50%;
            border: 2px solid rgba(255,0,0,0.8);
            transform-origin: center;
            animation: mcp-ripple 0.6s ease-out forwards;
            pointer-events: none;
          }
        `
      });

      await session.page.evaluate(() => {
        if (!document.getElementById('mcp-ripple-container')) {
          const div = document.createElement('div');
          div.id = 'mcp-ripple-container';
          div.className = 'mcp-ripple-container';
          document.body.appendChild(div);
        }
      });
    } catch { /* ignore */ }
  }

  async showRipple(session, x, y) {
    try {
      await session.page.evaluate(({ x, y }) => {
        const container = document.getElementById('mcp-ripple-container');
        if (!container) return;
        const ripple = document.createElement('div');
        ripple.className = 'mcp-ripple';
        ripple.style.left = `${x - 25}px`;
        ripple.style.top = `${y - 25}px`;
        container.appendChild(ripple);
        setTimeout(() => ripple.remove(), 700);
      }, { x, y });
    } catch { /* ignore */ }
  }

  async moveMouseNatural(session, { x, y }) {
    const from = session.lastMousePos || { x: 0, y: 0 };
    const distance = Math.sqrt(Math.pow(x - from.x, 2) + Math.pow(y - from.y, 2));

    if (distance < 5) return;

    const steps = Math.min(Math.max(Math.floor(distance / 15), 5), 20);

    // Simple quadratic Bezier control point for a slight curve
    const control = {
      x: (from.x + x) / 2 + (Math.random() - 0.5) * distance * 0.3,
      y: (from.y + y) / 2 + (Math.random() - 0.5) * distance * 0.3
    };

    const getBezier = (t, p0, p1, p2) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const curX = getBezier(t, from.x, control.x, x);
      const curY = getBezier(t, from.y, control.y, y);
      await session.page.mouse.move(curX, curY);
      if (i % 2 === 0) await new Promise(r => setTimeout(r, 5)); // Micro-jitter
    }

    session.lastMousePos = { x, y };
  }

  async waitForSettle(session, policy = "normal") {
    const timeout = policy === "lazy" ? 100 : policy === "strict" ? 1500 : 500;
    
    if (config.turboMode && policy !== "strict") {
      try {
        // In Turbo Mode, we wait for networkidle but with a VERY short additional timeout
        await session.page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => { });
        await new Promise(r => setTimeout(r, policy === "lazy" ? 20 : 50));
      } catch { /* ignore */ }
      return;
    }

    try {
      await session.page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => { });
      await new Promise(r => setTimeout(r, timeout));
    } catch { /* ignore */ }
  }

  async setAgentActive(session, active) {
    try {
      await session.page.evaluate((v) => {
        window.__mcpAgentActive = v;
        try {
          if (v) {
            sessionStorage.setItem('__mcpAgentActive', 'true');
          } else {
            sessionStorage.removeItem('__mcpAgentActive');
          }
        } catch (e) { /* incognito or full storage */ }

        if (window.__mcpUpdateAgentActive) {
          window.__mcpUpdateAgentActive(v);
        }
      }, active);
    } catch { /* ignore */ }
  }


  tokenize(text = "") {
    const stopWords = new Set(["click", "type", "into", "in", "on", "the", "a", "an", "button", "field", "input", "to", "select"]);
    return this.normalizeQuery(text)
      .split(" ")
      .filter((token) => token && !stopWords.has(token));
  }

  buildSelectorCandidates({ selector, query, action }) {
    const candidates = [];
    const q = this.normalizeQuery(query || selector || "");
    const tokens = this.tokenize(q);

    if (selector) candidates.push({ strategy: "direct", selector, type: "css" });
    if (!q && !selector) return candidates;

    const primary = tokens[0] || q.split(" ")[0] || "";
    if (primary) {
      candidates.push({ strategy: "id", selector: `#${primary}`, type: "css" });
      candidates.push({ strategy: "name", selector: `[name='${primary}']`, type: "css" });
      candidates.push({ strategy: "data-testid", selector: `[data-testid='${primary}']`, type: "css" });
    }

    const textSelector = tokens.join(" ") || q;
    if (textSelector) {
      candidates.push({ strategy: "text", selector: `text=${textSelector}`, type: "text" });
      candidates.push({ strategy: "placeholder", selector: `[placeholder*='${textSelector}']`, type: "css" });
      candidates.push({ strategy: "aria-label", selector: `[aria-label*='${textSelector}']`, type: "css" });

      if (action === "click" || action === "hover") {
        candidates.push({
          strategy: "role-button",
          selector: `xpath=//*[self::button or @role='button' or self::a][contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${textSelector}')]`,
          type: "xpath"
        });
      }

      if (action === "type" || action === "upload" || action === "select") {
        candidates.push({
          strategy: "label-input",
          selector: `xpath=//label[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${textSelector}')]/following::*[self::input or self::textarea or self::select][1]`,
          type: "xpath"
        });
      }

      candidates.push({
        strategy: "generic-xpath-text",
        selector: `xpath=//*[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${textSelector}')]`,
        type: "xpath"
      });
    }

    return candidates;
  }

  async isLocatorVisible(locator) {
    const count = await locator.count();
    if (count === 0) return false;
    return locator.first().isVisible();
  }

  async resolveSelector(session, { selector, query, action }) {
    const page = session.page;

    // 1. Strictly prioritize the direct selector if provided
    if (selector) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) {
          return { selector, strategy: "direct" };
        }
      } catch { /* ignore and try candidates */ }
    }

    const candidates = this.buildSelectorCandidates({ selector, query, action });

    if (config.turboMode) {
      const resolutionPromises = candidates.map(async (candidate) => {
        try {
          const locator = page.locator(candidate.selector);
          const count = await locator.count();
          if (count > 0 && await locator.first().isVisible()) {
            return { selector: candidate.selector, strategy: candidate.strategy };
          }
        } catch { /* ignore */ }
        throw new Error("Not found");
      });

      try {
        return await Promise.any(resolutionPromises);
      } catch {
        // Fallback to query-only if candidates failed
        if (query) {
           try {
             return { selector: `text=${query}`, strategy: "fallback-text" };
           } catch { /* ignore */ }
        }
        throw new Error(`Unable to resolve selector for: "${query || selector}"`);
      }
    }

    for (const candidate of candidates) {
      try {
        const locator = page.locator(candidate.selector);
        if (await this.isLocatorVisible(locator)) {
          return { selector: candidate.selector, strategy: candidate.strategy };
        }
      } catch { /* ignore */ }
    }

    throw new Error(`Unable to resolve selector for: "${query || selector}"`);
  }

  async captureScreenshot(session, label) {
    const root = this.sessionScreenshotRoot(session.id);
    await fs.mkdir(root, { recursive: true });
    const safeLabel = (label || "shot").replace(/[^\w-]/g, "_");
    const fileName = `${Date.now()}-${safeLabel}.png`;
    const absolutePath = path.resolve(root, fileName);
    try {
      const buffer = await session.page.screenshot({ fullPage: false });
      await fs.writeFile(absolutePath, buffer);
      const record = {
        label,
        path: absolutePath,
        timestamp: new Date().toISOString(),
        url: session.page.url()
      };
      session.screenshotHistory.push(record);
      return record;
    } catch (error) {
      return { label, path: "", error: error.message };
    }
  }

  async analyzePageState(session) {
    return session.page.evaluate(() => {
      const firstText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50);
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
      };

      const selectorHint = (el) => {
        if (el.id) return `[id="${String(el.id).replace(/"/g, '\\"')}"]`;
        if (el.getAttribute("name")) return `[name='${String(el.getAttribute("name")).replace(/'/g, "\\'")}']`;
        const testId = el.getAttribute("data-testid") || el.getAttribute("data-qa");
        if (testId) return `[data-testid='${testId}']`;
        if (el.className && typeof el.className === "string") return `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/)[0]}`;
        return el.tagName.toLowerCase();
      };

      const interactive = Array.from(document.querySelectorAll("button, a, input, textarea, select, [role='button'], [onclick]"))
        .filter(isVisible)
        .slice(0, 80) // Cap for token efficiency
        .map((el) => {
          const tagName = el.tagName.toLowerCase();
          const info = {
            tag: tagName,
            text: firstText(el),
            selector: selectorHint(el),
            type: el.getAttribute("type") || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            aria: el.getAttribute("aria-label") || undefined,
            required: el.hasAttribute("required") || undefined,
            disabled: el.disabled || undefined,
            value: (el.value !== undefined && tagName !== 'select') ? String(el.value).slice(0, 100) : undefined
          };

          if (tagName === 'select') {
            info.options = Array.from(el.options).slice(0, 15).map(o => o.textContent.trim());
            info.currentValue = el.value;
          }

          return info;
        });

      return {
        title: document.title,
        url: window.location.href,
        interactiveCount: interactive.length,
        elements: interactive
      };
    });
  }

  async openUrl({ sessionId, url, headless, persist }) {
    const session = await this.getOrCreateSession(sessionId, { headless, persist });
    await this.setAgentActive(session, true);
    try {
      await session.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: config.defaultTimeoutMs
      });
      const title = await session.page.title();
      this.appendScratchpad(session, `Opened: ${url} → "${title}"`);
      this.logAction(session, { action: "open", selector: url, result: "success", metadata: { url } });
      session.actionHistory.push({ action: "open", target: url, timestamp: new Date().toISOString() });
      return {
        sessionId: session.id,
        url: session.page.url(),
        title
      };
    } finally {
      await this.setAgentActive(session, false);
    }
  }

  async click({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await this.setAgentActive(session, true);
    const resolved = await this.resolveSelector(session, { selector, query, action: "click" });

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

    if (!config.turboMode) {
      const box = await locator.boundingBox();
      if (box) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        await this.moveMouseNatural(session, { x: centerX, y: centerY });
        await this.showRipple(session, centerX, centerY);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    await locator.click({ timeout: config.defaultTimeoutMs, force: config.turboMode });
    await this.waitForSettle(session);
    await this.setAgentActive(session, false);
    this.appendScratchpad(session, `Clicked: "${query || selector}" → ${resolved.strategy}`);
    this.logAction(session, { action: "click", selector: resolved.selector, result: "success", metadata: { query, strategy: resolved.strategy } });
    session.actionHistory.push({ action: "click", target: query || selector, timestamp: new Date().toISOString() });

    return {
      sessionId: session.id,
      selector: resolved.selector,
      strategy: resolved.strategy
    };
  }

  async type({ sessionId, selector, text, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await this.setAgentActive(session, true);
    const resolved = await this.resolveSelector(session, { selector, query, action: "type" });

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

    // Check if readonly or disabled
    const isReady = await locator.evaluate(el => {
      return !el.readOnly && !el.disabled && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.hasAttribute('contenteditable'));
    });

    if (!isReady) {
      const status = await locator.evaluate(el => el.readOnly ? "readonly" : el.disabled ? "disabled" : "not-editable");
      this.appendScratchpad(session, `Skipped typing into ${status} field: "${query || selector}"`);
      await this.setAgentActive(session, false);
      return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, status: "skipped", reason: status };
    }

    if (!config.turboMode) {
      const box = await locator.boundingBox();
      if (box) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        await this.moveMouseNatural(session, { x: centerX, y: centerY });
        await this.showRipple(session, centerX, centerY);
      }
    }

    await locator.click({ timeout: config.defaultTimeoutMs, force: config.turboMode });
    await locator.fill("");
    await locator.fill(String(text));
    await this.waitForSettle(session);
    await this.setAgentActive(session, false);

    this.appendScratchpad(session, `Typed into "${query || selector}": "${String(text).slice(0, 30)}..."`);
    this.logAction(session, { action: "type", selector: resolved.selector, result: "success", metadata: { query, strategy: resolved.strategy, textLength: text.length } });
    session.actionHistory.push({ action: "type", target: query || selector, timestamp: new Date().toISOString() });

    return {
      sessionId: session.id,
      selector: resolved.selector,
      strategy: resolved.strategy,
      typedLength: text.length
    };
  }

  async fillForm({ sessionId, fields }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!fields || typeof fields !== "object") throw new Error("fields must be an object like { 'email field': 'test@example.com', ... }");

    await this.setAgentActive(session, true);
    this.appendScratchpad(session, `Filling form with ${Object.keys(fields).length} fields`);

    const results = [];
    for (const [query, value] of Object.entries(fields)) {
      try {
        const resolved = await this.resolveSelector(session, { query, action: "type" });
        const locator = session.page.locator(resolved.selector).first();
        await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

        const box = await locator.boundingBox();
        if (box) {
          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;
          await this.moveMouseNatural(session, { x: centerX, y: centerY });
          await this.showRipple(session, centerX, centerY);
        }

        const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
        const inputType = await locator.evaluate(el => el.getAttribute("type") || "");

        if (tagName === "select") {
          const options = await locator.evaluate(el => {
            return Array.from(el.options).map(o => ({ value: o.value, label: o.textContent.trim() }));
          });
          const strVal = String(value);
          const match = options.find(o => o.label.toLowerCase() === strVal.toLowerCase() || o.value.toLowerCase() === strVal.toLowerCase());
          if (match) {
            await locator.selectOption({ value: match.value });
          } else if (options.length > 1) {
            await locator.selectOption({ index: 1 });
            this.appendScratchpad(session, `  ⚠ "${query}": "${strVal}" not found in options, picked first available`);
          } else {
            throw new Error(`No matching option for "${strVal}". Available: ${options.map(o => o.label).join(", ")}`);
          }
        } else if (inputType === "date") {
          await locator.fill(String(value));
        } else if (inputType === "checkbox" || inputType === "radio") {
          const checked = await locator.isChecked();
          const shouldCheck = ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
          if (checked !== shouldCheck) await locator.click();
        } else if (inputType === "file") {
          await locator.setInputFiles(String(value));
        } else {
          await locator.click({ timeout: config.defaultTimeoutMs });
          await this.waitForSettle(session, 100);
          await locator.fill("");
          if (config.turboMode) {
            await locator.fill(String(value));
          } else {
            await locator.pressSequentially(String(value), { delay: Math.floor(Math.random() * 40) + 20 });
            await new Promise(r => setTimeout(r, 300)); // Brief pause purely for visual feedback
          }
        }

        results.push({ field: query, status: "filled", strategy: resolved.strategy });
        this.appendScratchpad(session, `  ✓ ${query} = "${String(value).slice(0, 20)}"`);
      } catch (error) {
        results.push({ field: query, status: "failed", error: error.message });
        this.appendScratchpad(session, `  ✗ ${query} → FAILED: ${error.message}`);
      }
    }

    await this.setAgentActive(session, false);
    this.logAction(session, { action: "fillForm", result: "success", metadata: { fieldCount: Object.keys(fields).length } });
    session.actionHistory.push({ action: "fillForm", target: `${Object.keys(fields).length} fields`, timestamp: new Date().toISOString() });

    return {
      sessionId: session.id,
      results,
      filledCount: results.filter(r => r.status === "filled").length,
      failedCount: results.filter(r => r.status === "failed").length
    };
  }

  async screenshot({ sessionId, fileName, fullPage = false, embedImage = false, saveLocal = true }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const buffer = await session.page.screenshot({ fullPage });
    let absolutePath = "";

    if (saveLocal) {
      const root = this.sessionScreenshotRoot(session.id);
      await fs.mkdir(root, { recursive: true });
      const rawName = fileName || `screenshot-${Date.now()}.png`;
      const safeName = rawName.replace(/[^\w.\-() ]/g, "_");
      absolutePath = path.resolve(root, safeName);
      await fs.writeFile(absolutePath, buffer);
    }

    const metadata = {
      sessionId: session.id,
      path: absolutePath,
      url: session.page.url(),
      timestamp: new Date().toISOString()
    };

    if (saveLocal) {
      session.screenshotHistory.push(metadata);
    }

    this.logAction(session, {
      action: "screenshot",
      result: "success",
      metadata: { ...metadata, saveLocal }
    });

    const result = {
      sessionId: session.id,
      path: absolutePath,
      filePath: absolutePath,
      metadata,
      saveLocal
    };

    if (embedImage) {
      result.imageBase64 = buffer.toString("base64");
    }
    return result;
  }

  async analyze({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const summary = await this.analyzePageState(session);
    this.logAction(session, { action: "analyze", result: "success", metadata: { url: summary.url } });
    return { sessionId: session.id, ...summary };
  }

  async extractElementStyles({ sessionId, selector, query, maxOuterHtml = 2000, maxTextLength = 200 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!selector && !query) throw new Error("Provide selector or query");
    const resolved = await this.resolveSelector(session, { selector, query, action: "click" });
    const keys = COMPUTED_STYLE_PROPERTY_KEYS;

    const detail = await session.page.locator(resolved.selector).first().evaluate(
      (el, { keys, maxOuterHtml, maxTextLength }) => {
        const cs = getComputedStyle(el);
        const computed = {};
        for (const k of keys) computed[k] = cs.getPropertyValue(k);
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const a of [...el.attributes].slice(0, 40)) {
          attrs[a.name] = String(a.value).slice(0, 500);
        }
        return {
          tag: el.tagName.toLowerCase(),
          outerHTML: (el.outerHTML || "").slice(0, maxOuterHtml),
          textPreview: (el.innerText || el.textContent || "").trim().slice(0, maxTextLength),
          box: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left },
          attributes: attrs,
          computed
        };
      },
      { keys, maxOuterHtml, maxTextLength }
    );

    this.logAction(session, {
      action: "extractElementStyles",
      result: "success",
      metadata: { selector: resolved.selector, tag: detail.tag }
    });
    return {
      sessionId: session.id,
      url: session.page.url(),
      selector: resolved.selector,
      strategy: resolved.strategy,
      ...detail
    };
  }

  async pageStyleMap({ sessionId, maxNodes = 80 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const keys = COMPUTED_STYLE_PROPERTY_KEYS;
    const cap = Math.min(500, Math.max(5, Number(maxNodes) || 80));

    const summary = await session.page.evaluate(({ maxNodes, keys }) => {
      const nodes = [];
      const root = document.body;
      if (!root) {
        return { url: window.location.href, title: document.title, returned: 0, nodes: [] };
      }
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (nodes.length >= maxNodes) break;
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const computed = {};
        for (const k of keys) computed[k] = cs.getPropertyValue(k);
        nodes.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: typeof el.className === "string" ? el.className.slice(0, 160) : undefined,
          textPreview: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80),
          box: { x: r.x, y: r.y, w: r.width, h: r.height },
          computed
        });
      }
      return {
        url: window.location.href,
        title: document.title,
        returned: nodes.length,
        nodes
      };
    }, { maxNodes: cap, keys });

    this.logAction(session, {
      action: "pageStyleMap",
      result: "success",
      metadata: { count: summary.returned }
    });
    return { sessionId: session.id, ...summary };
  }

  async scroll({ sessionId, pixels = 600 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await session.page.mouse.wheel(0, pixels);
    this.appendScratchpad(session, `Scrolled ${pixels}px`);
    this.logAction(session, { action: "scroll", result: "success", metadata: { pixels } });
    session.actionHistory.push({ action: "scroll", target: String(pixels), timestamp: new Date().toISOString() });
    return { sessionId: session.id, pixels };
  }

  async hover({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const resolved = await this.resolveSelector(session, { selector, query, action: "hover" });

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

    const box = await locator.boundingBox();
    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      await this.moveMouseNatural(session, { x: centerX, y: centerY });
      await this.showRipple(session, centerX, centerY);
    }

    await locator.hover();
    this.appendScratchpad(session, `Hovered: "${query || selector}"`);
    this.logAction(session, { action: "hover", selector: resolved.selector, result: "success", metadata: { query } });
    session.actionHistory.push({ action: "hover", target: query || selector, timestamp: new Date().toISOString() });

    return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy };
  }

  async wait({ sessionId, selector, query, text, timeoutMs }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const timeout = Number(timeoutMs || config.defaultTimeoutMs);

    await this.setAgentActive(session, true);
    try {
      if (text) {
        await session.page.waitForFunction(
          (needle) => document.body && document.body.innerText.toLowerCase().includes(needle.toLowerCase()),
          text,
          { timeout }
        );
        this.appendScratchpad(session, `Waited for text: "${text}"`);
        return { sessionId: session.id, mode: "text", text, timeoutMs: timeout };
      }
      if (selector || query) {
        const resolved = await this.resolveSelector(session, { selector, query, action: "wait" });
        await session.page.locator(resolved.selector).first().waitFor({ state: "visible", timeout });
        this.appendScratchpad(session, `Waited for element: "${query || selector}"`);
        return { sessionId: session.id, mode: "selector", selector: resolved.selector, strategy: resolved.strategy, timeoutMs: timeout };
      }
      await session.page.waitForTimeout(timeout);
      this.appendScratchpad(session, `Waited ${timeout}ms`);
      return { sessionId: session.id, mode: "timeout", timeoutMs: timeout };
    } finally {
      await this.setAgentActive(session, false);
    }
  }

  async select({ sessionId, selector, query, value, label, index }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (value === undefined && label === undefined && index === undefined) {
      throw new Error("Missing selection target: value, label, or index");
    }

    const resolved = await this.resolveSelector(session, { selector, query, action: "select" });
    const locator = session.page.locator(resolved.selector).first();
    const timeout = config.defaultTimeoutMs;

    await locator.waitFor({ state: "visible", timeout });

    const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
    const option = value !== undefined ? { value: String(value) } : label !== undefined ? { label: String(label) } : { index: Number(index) };

    if (tagName === "select") {
      // Standard HTML Select
      try {
        await locator.selectOption(option, { timeout: 5000 });
      } catch (err) {
        // Fallback: If value was provided, try label
        if (value !== undefined) {
          try {
            await locator.selectOption({ label: String(value) }, { timeout: 2000 });
          } catch { throw err; }
        } else { throw err; }
      }
    } else {
      // Custom Dropdown (Div/Button based)
      this.appendScratchpad(session, `  Dropdown is custom (${tagName}), attempting click-and-search...`);
      
      // 1. Click to open
      await locator.click({ timeout: 2000 });
      await this.waitForSettle(session, "lazy");

      // 2. Look for the option in the DOM
      const searchText = label || value || "";
      if (searchText) {
        const optionLocator = session.page.locator(`text="${searchText}"`).first();
        if (await optionLocator.isVisible()) {
          await optionLocator.click({ timeout: 2000 });
        } else {
          // Try fuzzy search in likely dropdown containers
          const fuzzyLocator = session.page.locator(`[role="option"], li, div`).filter({ hasText: searchText }).last();
          await fuzzyLocator.click({ timeout: 2000 });
        }
      } else if (index !== undefined) {
        // Try to click the Nth child of the revealed container
        throw new Error("Index-based selection not yet supported for custom dropdowns. Use 'label' or 'value'.");
      }
    }

    await this.waitForSettle(session);
    this.appendScratchpad(session, `Selected option in "${query || selector}": ${JSON.stringify(option)}`);
    this.logAction(session, { action: "select", selector: resolved.selector, result: "success", metadata: { option } });
    session.actionHistory.push({ action: "select", target: query || selector, timestamp: new Date().toISOString() });

    return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, option };
  }

  async generatePdf({ sessionId, fileName, format = "A4", landscape = false, printBackground = true }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const root = this.sessionScreenshotRoot(session.id);
    await fs.mkdir(root, { recursive: true });
    const rawName = fileName || `export-${Date.now()}.pdf`;
    const safeName = rawName.endsWith(".pdf") ? rawName : `${rawName}.pdf`;
    const absolutePath = path.resolve(root, safeName);

    await session.page.pdf({
      path: absolutePath,
      format,
      landscape,
      printBackground,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" }
    });

    const metadata = {
      sessionId: session.id,
      path: absolutePath,
      url: session.page.url(),
      timestamp: new Date().toISOString()
    };
    
    this.appendScratchpad(session, `Generated PDF: ${safeName}`);
    this.logAction(session, { action: "generatePdf", result: "success", metadata });
    return { sessionId: session.id, path: absolutePath, filePath: absolutePath, metadata };
  }

  async pressKey({ sessionId, key, count = 1, delay = 100 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    for (let i = 0; i < count; i++) {
      await session.page.keyboard.press(key, { delay });
    }

    this.appendScratchpad(session, `Pressed key: ${key} (x${count})`);
    this.logAction(session, { action: "pressKey", result: "success", metadata: { key, count } });
    return { sessionId: session.id, key, count };
  }

  async upload({ sessionId, selector, query, filePath }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!filePath) throw new Error("Missing required field: filePath");
    const resolved = await this.resolveSelector(session, { selector, query, action: "upload" });
    const absoluteFilePath = path.resolve(filePath);

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
    await locator.setInputFiles(absoluteFilePath);

    this.appendScratchpad(session, `Uploaded file: "${absoluteFilePath}"`);
    this.logAction(session, { action: "upload", selector: resolved.selector, result: "success", metadata: { filePath: absoluteFilePath } });
    session.actionHistory.push({ action: "upload", target: query || selector, timestamp: new Date().toISOString() });

    return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, filePath: absoluteFilePath };
  }

  getGoalPlan(goal, payload = {}) {
    const normalized = this.normalizeQuery(goal);
    if (normalized.includes("login")) {
      return [
        payload.url ? { action: "open", params: { url: payload.url, headless: payload.headless } } : null,
        { action: "type", params: { query: "email field", text: payload.email || payload.username || "demo@example.com" } },
        { action: "type", params: { query: "password field", text: payload.password || "Password123!" } },
        { action: "click", params: { query: "login button" } }
      ].filter(Boolean);
    }
    if (normalized.includes("signup") || normalized.includes("sign up")) {
      return [
        payload.url ? { action: "open", params: { url: payload.url, headless: payload.headless } } : null,
        { action: "type", params: { query: "name field", text: payload.name || "Test User" } },
        { action: "type", params: { query: "email field", text: payload.email || "newuser@example.com" } },
        { action: "type", params: { query: "password field", text: payload.password || "Password123!" } },
        { action: "click", params: { query: "signup button" } }
      ].filter(Boolean);
    }
    return payload.steps || [];
  }

  async runPlannedAction(session, step) {
    switch (step.action) {
      case "open":
        return this.openUrl({ sessionId: session.id, ...step.params });
      case "click":
        return this.click({ sessionId: session.id, ...step.params });
      case "type":
        return this.type({ sessionId: session.id, ...step.params });
      case "scroll":
        return this.scroll({ sessionId: session.id, ...step.params });
      case "hover":
        return this.hover({ sessionId: session.id, ...step.params });
      case "wait":
        return this.wait({ sessionId: session.id, ...step.params });
      case "select":
        return this.select({ sessionId: session.id, ...step.params });
      case "upload":
        return this.upload({ sessionId: session.id, ...step.params });
      default:
        throw new Error(`Unsupported planner action: ${step.action}`);
    }
  }

  async planAndExecute({ sessionId, goal, payload = {} }) {
    const session = await this.getOrCreateSession(sessionId, { headless: payload.headless });
    const plan = this.getGoalPlan(goal, payload);
    this.appendScratchpad(session, `Planning goal: "${goal}" → ${plan.length} steps`);

    const execution = [];

    for (const step of plan) {
      try {
        const actionResult = await this.runPlannedAction(session, step);
        execution.push({ step, status: "success", result: actionResult });
      } catch (error) {
        execution.push({ step, status: "error", error: error.message });
        this.appendScratchpad(session, `Plan step failed: ${step.action} → ${error.message}`);
        break;
      }
    }

    this.logAction(session, { action: "planner.execute", result: "success", metadata: { goal, stepCount: plan.length } });
    return {
      sessionId: session.id,
      goal,
      plan,
      execution,
      finalUrl: session.page.url()
    };
  }

  async executeFlowTemplate({ sessionId, template, payload = {} }) {
    const session = await this.getOrCreateSession(sessionId, { headless: payload.headless });
    const flow = this.flowTemplates[template];
    if (!flow) throw new Error(`Unknown flow template: ${template}`);

    if (payload.url) {
      await this.openUrl({ sessionId: session.id, url: payload.url, headless: payload.headless });
    }

    this.appendScratchpad(session, `Executing flow template: "${template}"`);

    const results = [];
    for (const step of flow) {
      if (step.action === "typeMany") {
        const entries = Object.entries(payload[step.valueFrom] || {});
        for (const [field, value] of entries) {
          const typeResult = await this.type({ sessionId: session.id, query: `${field} field`, text: String(value) });
          results.push({ action: "type", field, result: typeResult });
        }
        continue;
      }

      const value = payload[step.valueFrom];
      if ((value === undefined || value === null) && step.action === "type") {
        if (step.optional) continue;
        throw new Error(`Missing flow payload value: ${step.valueFrom}`);
      }

      if (step.action === "type") {
        const typeResult = await this.type({ sessionId: session.id, query: step.target, text: String(value) });
        results.push({ action: step.action, target: step.target, result: typeResult });
      } else if (step.action === "click") {
        const clickResult = await this.click({ sessionId: session.id, query: step.target });
        results.push({ action: step.action, target: step.target, result: clickResult });
      }
    }

    this.logAction(session, { action: "flow.execute", result: "success", metadata: { template, stepCount: flow.length } });
    return { sessionId: session.id, template, results, finalUrl: session.page.url() };
  }

  getErrors({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return {
      sessionId: session.id,
      consoleErrors: session.consoleErrors,
      networkErrors: session.networkErrors,
      lastAction: session.lastAction
    };
  }

  getSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.id,
      createdAt: s.createdAt,
      currentUrl: s.page.url(),
      lastAction: s.lastAction,
      actionCount: s.actionHistory.length
    }));
  }

  getSessionState({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return {
      sessionId: session.id,
      currentUrl: session.page.url(),
      lastAction: session.lastAction,
      actionHistory: session.actionHistory,
      scratchpad: session.scratchpad,
      logs: session.logs,
      screenshotHistory: session.screenshotHistory,
      downloadHistory: session.downloadHistory
    };
  }

  async updateScratchpad({ sessionId, content }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    session.scratchpad = content;
    this.logAction(session, { action: "scratchpad.update", result: "success", metadata: { length: content.length } });
    return { sessionId: session.id, scratchpad: session.scratchpad };
  }

  async inspectPage({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const analysis = await this.analyzePageState(session);

    return {
      sessionId: session.id,
      url: session.page.url(),
      title: await session.page.title(),
      analysis,
      consoleErrors: session.consoleErrors.slice(-10),
      networkErrors: session.networkErrors.slice(-10),
      scratchpad: session.scratchpad
    };
  }

  async testPageQuality({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const qualityResult = await session.page.evaluate(() => {
      const brokenImages = Array.from(document.querySelectorAll("img")).filter(img => img.naturalWidth === 0 && img.src).map(img => img.src);
      const missingAlt = Array.from(document.querySelectorAll("img")).filter(img => !img.alt).map(img => img.src).slice(0, 10);
      const interactiveElements = document.querySelectorAll("button, a, input, select, textarea").length;
      const h1 = document.querySelector("h1")?.innerText || "No H1 found";
      const meta = document.querySelector('meta[name="description"]')?.content || "No meta description";

      return {
        brokenImages,
        missingAlt,
        interactiveElementsCount: interactiveElements,
        h1,
        metaDescription: meta
      };
    });

    const report = {
      sessionId: session.id,
      url: session.page.url(),
      timestamp: new Date().toISOString(),
      quality: qualityResult,
      consoleErrors: session.consoleErrors.slice(-5),
      networkErrors: session.networkErrors.slice(-5),
      consoleErrorCount: session.consoleErrors.length,
      networkErrorCount: session.networkErrors.length,
      isHealthy: qualityResult.brokenImages.length === 0 && session.consoleErrors.length === 0 && session.networkErrors.length === 0
    };

    this.appendScratchpad(session, `Quality test: ${report.isHealthy ? "HEALTHY ✓" : "ISSUES FOUND ✗"} (${report.consoleErrorCount} console, ${report.networkErrorCount} network errors)`);
    this.logAction(session, { action: "test.quality", result: report.isHealthy ? "success" : "issues_found" });
    return report;
  }

  async captureLinkRoutes({ sessionId, maxRoutes = 5 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const links = await session.page.evaluate(() => {
      const currentOrigin = window.location.origin;
      return Array.from(new Set(
        Array.from(document.querySelectorAll("a[href]"))
          .map(a => a.href)
          .filter(href => href.startsWith(currentOrigin) && !href.includes("#"))
      ));
    });

    const routesToCapture = links.slice(0, maxRoutes);
    const captures = [];
    const originalUrl = session.page.url();
    this.appendScratchpad(session, `Capturing ${routesToCapture.length} routes`);

    for (const link of routesToCapture) {
      try {
        await session.page.goto(link, { waitUntil: "domcontentloaded", timeout: config.defaultTimeoutMs });
        const shot = await this.captureScreenshot(session, `route`);
        const errors = session.consoleErrors.length;
        captures.push({ url: link, screenshot: shot.path, consoleErrors: errors });
        this.appendScratchpad(session, `  ✓ ${link}`);
      } catch (err) {
        captures.push({ url: link, error: err.message });
        this.appendScratchpad(session, `  ✗ ${link} → ${err.message}`);
      }
    }

    await session.page.goto(originalUrl, { waitUntil: "domcontentloaded" });

    return { sessionId: session.id, totalLinksFound: links.length, captures };
  }

  async discoverUIRoutes(session) {
    this.appendScratchpad(session, "Discovering routes via UI interaction...");
    const page = session.page;
    const discovered = new Set();

    // 1. Identify navigation containers with expanded selectors
    const navSelectors = [
      'nav',
      'header',
      'aside',
      '[role="navigation"]',
      '.navbar',
      '.sidebar',
      '.menu',
      '.nav',
      '.navigation',
      '.main-menu',
      '.top-nav',
      '.header-nav',
      '.site-nav',
      '.primary-nav',
      'ul.nav',
      'ul.menu'
    ];
    const navContainerHandles = await page.$$(navSelectors.join(','));

    // 2. Collect all visible links from nav containers
    for (const container of navContainerHandles) {
      const links = await container.$$eval('a[href]', (anchors) =>
        anchors.map(a => ({
          title: a.innerText.trim(),
          href: a.href
        }))
      );
      links.forEach(link => discovered.add(link));
      await container.dispose();
    }

    // 3. Find interactive hubs (dropdowns, menus)
    const interactiveSelectors = [
      'button',
      '[role="button"]',
      'a'
    ];
    const interactiveHandles = await page.$$(interactiveSelectors.join(','));
    const hubs = [];
    for (const handle of interactiveHandles) {
      const isNav = await handle.evaluate((el, navSelectors) => {
        const navContainers = document.querySelectorAll(navSelectors.join(','));
        return Array.from(navContainers).some(nav => nav.contains(el));
      }, navSelectors);
      if (!isNav) {
        await handle.dispose();
        continue;
      }
      const hasCaret = await handle.evaluate(el => {
        const text = (el.innerText || "").toLowerCase();
        return text.includes('⌄') || text.includes('v') || text.includes('arrow') || text.includes('menu');
      });
      const hasSvg = await handle.evaluate(el => !!el.querySelector('svg'));
      const hasDropdownClass = await handle.evaluate(el =>
        el.className.toLowerCase().includes('dropdown')
      );
      if (hasCaret || hasSvg || hasDropdownClass) {
        hubs.push(handle);
      } else {
        await handle.dispose();
      }
    }

    // 4. Interact with each hub (hover/click) to reveal submenus
    for (const hub of hubs.slice(0, 10)) {
      try {
        await hub.scrollIntoViewIfNeeded();
        await hub.hover();
        await page.waitForTimeout(300); // allow animation
        await hub.click();
        await page.waitForTimeout(500);

        // Collect newly visible links
        const newLinks = await page.$$eval('a[href]', (anchors) =>
          anchors
            .filter(a => a.offsetParent !== null)
            .map(a => ({
              title: a.innerText.trim(),
              href: a.href
            }))
        );
        newLinks.forEach(link => discovered.add(link));
      } catch (e) {
        // ignore interaction errors
      } finally {
        await hub.dispose();
      }
    }

    // 5. Convert Set to array and filter internal routes
    const results = Array.from(discovered);
    const currentOrigin = await page.evaluate(() => window.location.origin);
    const internalRoutes = results
      .filter(r => r.href.startsWith(currentOrigin) && !r.href.includes('#'))
      .map(r => ({ ...r, path: r.href.replace(currentOrigin, '') }));

    return internalRoutes;
  }

  async autoExplore({ sessionId, maxRoutes = 10, navigateByClick = false }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const routes = await this.discoverUIRoutes(session);
    this.appendScratchpad(session, `Found ${routes.length} potential routes via UI.`);

    const captures = [];
    const originalUrl = session.page.url();

    // De-duplicate by path
    const uniqueRoutes = [];
    const seenPaths = new Set();
    for (const r of routes) {
      if (!seenPaths.has(r.path)) {
        seenPaths.add(r.path);
        uniqueRoutes.push(r);
      }
    }

    const routesToVisit = uniqueRoutes.slice(0, maxRoutes);
    this.appendScratchpad(
      session,
      `Visiting ${routesToVisit.length} unique routes (${navigateByClick ? "click nav" : "direct goto"})...`
    );

    for (const route of routesToVisit) {
      try {
        let navigatedVia = "goto";
        if (navigateByClick) {
          await session.page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: config.defaultTimeoutMs });
          await this.waitForSettle(session);
          const nav = await this.navigateInternalByClick(session, route.href);
          navigatedVia = nav.navigatedVia;
        } else {
          await session.page.goto(route.href, { waitUntil: "domcontentloaded", timeout: config.defaultTimeoutMs });
        }
        const shot = await this.captureScreenshot(session, `explore_${route.title || "page"}`);
        captures.push({
          title: route.title,
          url: route.href,
          path: route.path,
          screenshot: shot.path,
          navigatedVia
        });
        this.appendScratchpad(session, `  ✓ Visited: ${route.title || route.path} (${navigatedVia})`);
      } catch (err) {
        captures.push({ title: route.title, url: route.href, error: err.message });
        this.appendScratchpad(session, `  ✗ Failed: ${route.title || route.path} → ${err.message}`);
      }
    }

    // Return to original page
    try {
      await session.page.goto(originalUrl, { waitUntil: "domcontentloaded" });
    } catch { /* ignore */ }

    return {
      sessionId: session.id,
      totalDiscovered: routes.length,
      visitedCount: captures.length,
      captures
    };
  }

  async extractBlueprint({ sessionId, selector = "body", maxDepth = 10 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const blueprint = await session.page.evaluate(async ({ selector, maxDepth, styleKeys }) => {
      const root = document.querySelector(selector);
      if (!root) return null;

      const getSafeStyle = (el) => {
        const cs = getComputedStyle(el);
        const styles = {};
        for (const k of styleKeys) {
          const val = cs.getPropertyValue(k);
          if (val && val !== "initial" && val !== "none" && val !== "normal" && val !== "0px none rgb(0, 0, 0)") {
            styles[k] = val;
          }
        }
        return styles;
      };

      const walk = (el, depth) => {
        if (depth > maxDepth) return null;
        
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;

        const node = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: el.className || undefined,
          box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          styles: getSafeStyle(el),
          attributes: {}
        };

        // Capture useful attributes
        for (const attr of el.attributes) {
          if (["src", "href", "placeholder", "alt", "type", "value"].includes(attr.name)) {
            node.attributes[attr.name] = attr.value;
          }
        }

        // Capture text if no children OR if it's a heading/button
        const isHeading = /^H[1-6]$/.test(el.tagName);
        const isButton = el.tagName === "BUTTON" || el.tagName === "A";
        if (el.children.length === 0 || isHeading || isButton) {
          const text = el.innerText?.trim();
          if (text) node.text = text.slice(0, 500);
        }

        // Recursive walk
        node.children = [];
        for (const child of el.children) {
          const childNode = walk(child, depth + 1);
          if (childNode) node.children.push(childNode);
        }

        return node;
      };

      return {
        url: window.location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        tree: walk(root, 0)
      };
    }, { selector, maxDepth, styleKeys: COMPUTED_STYLE_PROPERTY_KEYS });

    this.logAction(session, { action: "extractBlueprint", result: "success", metadata: { selector } });
    return { sessionId: session.id, blueprint };
  }

  async getGlobalPalette({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const palette = await session.page.evaluate(() => {
      const colors = new Set();
      const fonts = new Set();
      const bgColors = new Set();

      const all = document.querySelectorAll("*");
      for (const el of Array.from(all).slice(0, 1000)) {
        const cs = getComputedStyle(el);
        const c = cs.getPropertyValue("color");
        const bg = cs.getPropertyValue("background-color");
        const f = cs.getPropertyValue("font-family");

        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") colors.add(c);
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") bgColors.add(bg);
        if (f) fonts.add(f.split(",")[0].replace(/['"]/g, "").trim());
      }

      const frequency = (arr) => {
        const counts = {};
        arr.forEach(x => counts[x] = (counts[x] || 0) + 1);
        return Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
      };

      return {
        dominantTextColors: frequency(Array.from(colors)),
        dominantBackgrounds: frequency(Array.from(bgColors)),
        fontFamilies: frequency(Array.from(fonts))
      };
    });

    this.logAction(session, { action: "getGlobalPalette", result: "success" });
    return { sessionId: session.id, palette };
  }

  async cleanupSession(session) {
    this.appendScratchpad(session, "Cleaning up session artifacts...");

    const removeIfEmpty = async (dirPath) => {
      try {
        const abs = path.resolve(dirPath);
        const files = await fs.readdir(abs);
        if (files.length === 0) {
          await fs.rmdir(abs);
        }
      } catch { /* ignore */ }
    };

    // 1. Screenshots — remove whole session subfolder when enabled, plus any legacy loose files
    if (config.sessionScreenshotSubdirs) {
      try {
        await fs.rm(this.sessionScreenshotRoot(session.id), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    for (const record of session.screenshotHistory) {
      if (record.path) {
        try {
          await fs.unlink(record.path);
        } catch { /* ignore */ }
      }
    }

    // 2. Downloads
    for (const record of session.downloadHistory) {
      if (record.path) {
        try { await fs.unlink(record.path); } catch { /* ignore */ }
      }
    }

    // 3. User Data Dir
    if (session.userDataDir) {
      try {
        await fs.rm(session.userDataDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    // 4. Global root cleanup (if empty)
    await removeIfEmpty(config.screenshotDir);
    await removeIfEmpty(config.downloadsDir);
    await removeIfEmpty("user_data");
  }

  async closeSession({ sessionId, cleanup = null }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const shouldCleanup = cleanup !== null ? cleanup : config.autoCleanup;

    await session.context.close();
    if (session.browser) {
      await session.browser.close();
    }

    if (shouldCleanup) {
      await this.cleanupSession(session);
    }

    this.sessions.delete(sessionId);
    return { sessionId, cleanedUp: !!shouldCleanup };
  }

  async closeAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession({ sessionId: id })));
  }
}

export const browserService = new BrowserService();
