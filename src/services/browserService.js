import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { agentActivityService } from "./agentActivityService.js";
import { visionService } from "./visionService.js";
import { moveMouseHumanoid, typeHumanoid } from "../utils/humanoid.js";
import { selfHealingSelector } from "./selfHealingSelector.js";
import { sessionStore } from "./sessionStore.js";
import { createServiceLogger, logAction as logStructuredAction } from "./loggerService.js";

const svcLog = createServiceLogger("browser-service");

/** @type {import('./wsService.js').WsService|null} */
let _wsService = null;

/** Allow mcpServer boot to inject the WS instance after construction. */
export function setBrowserServiceWs(ws) { _wsService = ws; }

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

  /** Find an existing session on the same origin. Returns session or null. */
  async findSessionByDomain(url) {
    if (!url || !config.sessionReuse) return null;
    try {
      const targetOrigin = new URL(url).origin;

      // 1. Try Redis store first (Cross-process persistence)
      const redisMatch = await sessionStore.findByDomain(targetOrigin);
      if (redisMatch && this.sessions.has(redisMatch.id)) {
        return this.sessions.get(redisMatch.id);
      }

      // 2. Local fallback
      for (const [, session] of this.sessions) {
        try {
          const sessionOrigin = new URL(session.page.url()).origin;
          if (sessionOrigin === targetOrigin) return session;
        } catch { /* ignore dead sessions */ }
      }
    } catch { /* invalid url */ }
    return null;
  }

  async getOrCreateSession(sessionId, options = {}) {
    // If a REAL sessionId is passed that we already know about...
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      // ...check if it's still "alive". If not, PURGE it so we can recreate it.
      if (!this.isSessionAlive(session)) {
        console.error(`[SESSION] Purging dead session ${sessionId} before recreation.`);
        await this.closeSession({ sessionId, cleanup: false }).catch(() => { });
      } else {
        return session;
      }
    }

    // Treat these strings as "give me whatever is best" rather than literal IDs
    const isPlaceholderId = ["new", "fresh", "auto", "any", "current", "latest"].includes(String(sessionId || "").toLowerCase());

    // Smart session reuse: prefer existing session if any exists AND is alive
    if ((!sessionId || isPlaceholderId) && config.sessionReuse) {
      if (options.url) {
        const domainMatch = await this.findSessionByDomain(options.url);
        if (domainMatch && this.isSessionAlive(domainMatch)) {
          this.appendScratchpad(domainMatch, `♻ Reusing domain match session ${domainMatch.id} for ${options.url}`);
          return domainMatch;
        }
      }

      const allSessions = Array.from(this.sessions.values());
      for (let i = allSessions.length - 1; i >= 0; i--) {
        const s = allSessions[i];
        if (this.isSessionAlive(s)) {
          this.appendScratchpad(s, `♻ Reusing active live session ${s.id}`);
          return s;
        } else {
          // Cleanup dead session found during search
          this.sessions.delete(s.id);
          await sessionStore.remove(s.id);
        }
      }
    }
    // ... (rest of getOrCreateSession logic for creating a new session follows)

    const effectiveSessionId = (sessionId && !isPlaceholderId) ? sessionId : uuidv4();
    const headless =
      typeof options.headless === "boolean" ? options.headless : config.defaultHeadless;
    const persist = options.persist ?? false;
    const userDataDir = persist ? path.resolve(config.userDataDir, effectiveSessionId) : null;

    // Standard resolutions
    const width = config.defaultViewport.width;
    const height = config.defaultViewport.height;
    const scaleFactor = config.browserScaleFactor === null ? null : Number(config.browserScaleFactor);
    const browserChannel = String(config.browserChannel || "").trim();

    // IMPORTANT (Windows): in headed mode, using `viewport: null` makes the viewport follow
    // the real OS window size, preventing "missing/cut off" UI due to responsive breakpoints.
    const viewport = headless ? { width, height } : null;
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
      ...(headless ? ["--force-device-scale-factor=1"] : []),
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

    // Re-inject interaction lock on page navigations (covers SPA pushState/replaceState)
    page.on("framenavigated", async (frame) => {
      if (frame === page.mainFrame() && config.interactionLock) {
        try {
          await this.setAgentActive(session, session._agentActive || false);
        } catch { /* page may be mid-navigation */ }
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

  isSessionAlive(session) {
    if (!session || !session.page || !session.context) return false;

    // Check if the page is closed
    if (session.page.isClosed()) return false;

    // For non-persistent contexts, check if the browser is still connected
    if (session.browser && !session.browser.isConnected()) return false;

    return true;
  }

  getSession(sessionId) {
    if (!sessionId) return null;

    // Support placeholder IDs for convenience in tools/CLI
    const isPlaceholder = ["auto", "any", "current", "latest"].includes(String(sessionId).toLowerCase());
    if (isPlaceholder && this.sessions.size > 0) {
      // Find the most recently active LIVE session
      const allSessions = Array.from(this.sessions.values());
      for (let i = allSessions.length - 1; i >= 0; i--) {
        const s = allSessions[i];
        if (this.isSessionAlive(s)) return s;
        // Optimization: purge dead sessions found during search
        this.sessions.delete(s.id);
      }
      return null;
    }

    if (!this.sessions.has(sessionId)) return null;
    const session = this.sessions.get(sessionId);

    // Anti-frustration: if specific session is dead, purge it now so user can recreate
    if (!this.isSessionAlive(session)) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  logAction(session, { action, selector = "", result = "success", retryCount = 0, metadata = {} }) {
    const entry = {
      sessionId: session.id,
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

    // Real-time broadcast
    if (_wsService) _wsService.actionLog(entry);
    logStructuredAction(entry);
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
      .replace(/[^\w\s\-[\]]/g, " ") // Preserve brackets
      .replace(/\s+/g, " ")
      .trim();
  }

  toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
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
          const isMainFrame = window.self === window.top;
          if (!isMainFrame) return;
          if (document.getElementById('__mcpAgentOverlay')) return;

          /* ── Stylesheet ─────────────────────────────────────────── */
          const style = document.createElement('style');
          style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

            /* ── Animated gradient border ── */
            @keyframes mcp-border-flow {
              0%   { background-position: 0% 50%; }
              50%  { background-position: 100% 50%; }
              100% { background-position: 0% 50%; }
            }

            /* ── Scanning line ── */
            @keyframes mcp-scan-line {
              0%   { top: -2px; opacity: 0; }
              10%  { opacity: 1; }
              90%  { opacity: 1; }
              100% { top: 100%; opacity: 0; }
            }

            /* ── Pill slide-up entrance ── */
            @keyframes mcp-pill-enter {
              0%   { opacity: 0; transform: translateX(-50%) translateY(30px) scale(0.96); }
              100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
            }

            /* ── Breathing glow for status dot ── */
            @keyframes mcp-breathe {
              0%, 100% { box-shadow: 0 0 6px 2px rgba(99,102,241,0.5), 0 0 18px 4px rgba(99,102,241,0.25); transform: scale(1); }
              50%      { box-shadow: 0 0 10px 4px rgba(139,92,246,0.7), 0 0 30px 8px rgba(139,92,246,0.35); transform: scale(1.15); }
            }

            /* ── Typing dots ── */
            @keyframes mcp-dot-bounce {
              0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
              40%            { opacity: 1;   transform: translateY(-4px); }
            }

            /* ── Shake on blocked interaction ── */
            @keyframes mcp-shake-small {
              0%, 100% { transform: translateX(-50%); }
              20%      { transform: translateX(calc(-50% - 5px)); }
              40%      { transform: translateX(calc(-50% + 5px)); }
              60%      { transform: translateX(calc(-50% - 3px)); }
              80%      { transform: translateX(calc(-50% + 3px)); }
            }
            .mcp-shake-small { animation: mcp-shake-small 0.35s cubic-bezier(.36,.07,.19,.97) both; }

            /* ── Red flash on blocked interaction ── */
            @keyframes mcp-border-pulse {
              0%, 100% { border-color: rgba(239, 68, 68, 0); }
              50%      { border-color: rgba(239, 68, 68, 0.7); }
            }
            .mcp-pulse-active { animation: mcp-border-pulse 0.45s ease-in-out; }

            /* ── Ghost cursor ── */
            #mcp-ghost-cursor {
              position: fixed;
              width: 22px; height: 22px;
              background: radial-gradient(circle, rgba(129, 140, 248, 0.8) 0%, rgba(167, 139, 250, 0.4) 100%);
              border: 1px solid rgba(255,255,255,0.8);
              border-radius: 50%;
              pointer-events: none;
              z-index: 2147483647;
              transform: translate(-50%, -50%);
              transition: left 0.1s linear, top 0.1s linear, opacity 0.3s ease;
              box-shadow: 
                0 0 15px rgba(99,102,241,0.6),
                0 0 30px rgba(99,102,241,0.2),
                inset 0 0 8px rgba(255,255,255,0.5);
              opacity: 0;
            }
            #mcp-ghost-cursor::after {
              content: '';
              position: absolute;
              top: 50%; left: 50%;
              width: 6px; height: 6px;
              background: #fff;
              border-radius: 50%;
              transform: translate(-50%, -50%);
              box-shadow: 0 0 10px #fff;
            }
            /* Trail effect */
            .mcp-cursor-trail {
              position: fixed;
              width: 8px; height: 8px;
              background: rgba(167, 139, 250, 0.4);
              border-radius: 50%;
              pointer-events: none;
              z-index: 2147483646;
              transform: translate(-50%, -50%);
              animation: mcp-trail-fade 0.5s ease-out forwards;
            }
            @keyframes mcp-trail-fade {
              0% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
              100% { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
            }
          `;
          document.head.appendChild(style);

          /* ── Overlay (root container — blocks interaction) ─────── */
          const overlay = document.createElement('div');
          overlay.id = '__mcpAgentOverlay';
          overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            z-index: 2147483645;
            display: ${window.__mcpAgentActive ? 'block' : 'none'};
            pointer-events: none;
            transition: opacity 0.45s cubic-bezier(0.4,0,0.2,1);
            opacity: ${window.__mcpAgentActive ? '1' : '0'};
            user-select: none;
          `;

          /* ── Subtle vignette (edge-only blur + tint) ── */
          const vignette = document.createElement('div');
          vignette.style.cssText = `
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            background: radial-gradient(ellipse at center, transparent 50%, rgba(30,27,75,0.08) 100%);
            backdrop-filter: blur(3px);
            -webkit-backdrop-filter: blur(3px);
            mask-image: radial-gradient(ellipse at center, transparent 65%, black 100%);
            -webkit-mask-image: radial-gradient(ellipse at center, transparent 65%, black 100%);
            pointer-events: none; z-index: 1;
          `;
          overlay.appendChild(vignette);

          /* ── Animated gradient border frame ── */
          const borderFrame = document.createElement('div');
          borderFrame.style.cssText = `
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none; z-index: 2;
          `;
          // Four edge strips that form a glowing animated border
          const edges = [
            { css: 'top:0;left:0;width:100%;height:3px;' },
            { css: 'bottom:0;left:0;width:100%;height:3px;' },
            { css: 'top:0;left:0;width:3px;height:100%;' },
            { css: 'top:0;right:0;width:3px;height:100%;' }
          ];
          edges.forEach(e => {
            const strip = document.createElement('div');
            strip.style.cssText = `
              position:absolute; ${e.css}
              background: linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa, #6366f1, #8b5cf6);
              background-size: 300% 300%;
              animation: mcp-border-flow 4s linear infinite;
              opacity: 0.7;
              border-radius: 2px;
            `;
            borderFrame.appendChild(strip);
          });
          overlay.appendChild(borderFrame);

          /* ── Corner glow accents ── */
          const corners = [
            'top:0;left:0;background:radial-gradient(circle at 0% 0%,rgba(99,102,241,0.25) 0%,transparent 60%);',
            'top:0;right:0;background:radial-gradient(circle at 100% 0%,rgba(139,92,246,0.2) 0%,transparent 60%);',
            'bottom:0;left:0;background:radial-gradient(circle at 0% 100%,rgba(139,92,246,0.2) 0%,transparent 60%);',
            'bottom:0;right:0;background:radial-gradient(circle at 100% 100%,rgba(99,102,241,0.25) 0%,transparent 60%);'
          ];
          corners.forEach(c => {
            const glow = document.createElement('div');
            glow.style.cssText = `position:absolute;width:180px;height:180px;pointer-events:none;z-index:3;${c}`;
            overlay.appendChild(glow);
          });

          /* ── Scanning line ── */
          const scanLine = document.createElement('div');
          scanLine.style.cssText = `
            position: absolute; left: 0; width: 100%; height: 2px;
            background: linear-gradient(90deg, transparent 0%, rgba(129,140,248,0.5) 30%, rgba(167,139,250,0.7) 50%, rgba(129,140,248,0.5) 70%, transparent 100%);
            box-shadow: 0 0 15px 3px rgba(129,140,248,0.3);
            pointer-events: none; z-index: 4;
            animation: mcp-scan-line 4s ease-in-out infinite;
          `;
          overlay.appendChild(scanLine);

          /* ── Premium Control-Center Pill ── */
          const pill = document.createElement('div');
          pill.id = '__mcpAgentPill';
          pill.style.cssText = `
            position: fixed; bottom: 32px; left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, rgba(15,15,35,0.92) 0%, rgba(30,27,75,0.88) 100%);
            backdrop-filter: blur(24px) saturate(1.8);
            -webkit-backdrop-filter: blur(24px) saturate(1.8);
            border: 1px solid rgba(129,140,248,0.2);
            color: #fff;
            padding: 14px 28px 14px 22px;
            border-radius: 100px;
            box-shadow:
              0 0 0 1px rgba(129,140,248,0.08),
              0 8px 32px rgba(0,0,0,0.45),
              0 2px 8px rgba(99,102,241,0.15),
              inset 0 1px 0 rgba(255,255,255,0.06);
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            display: flex; align-items: center; gap: 14px;
            z-index: 5;
            animation: mcp-pill-enter 0.5s cubic-bezier(0.16,1,0.3,1) both;
            transition: box-shadow 0.3s ease, border-color 0.3s ease;
          `;

          // Inner glow line on top of pill
          const pillGlow = document.createElement('div');
          pillGlow.style.cssText = `
            position: absolute; top: 0; left: 20%; right: 20%; height: 1px;
            background: linear-gradient(90deg, transparent, rgba(167,139,250,0.5), transparent);
            border-radius: 1px;
          `;
          pill.appendChild(pillGlow);

          // Status dot with breathing animation
          const statusDot = document.createElement('div');
          statusDot.style.cssText = `
            width: 10px; height: 10px;
            background: linear-gradient(135deg, #818cf8, #a78bfa);
            border-radius: 50%;
            animation: mcp-breathe 2.5s ease-in-out infinite;
            flex-shrink: 0;
          `;
          pill.appendChild(statusDot);

          // Separator
          const sep = document.createElement('div');
          sep.style.cssText = `width:1px;height:24px;background:rgba(255,255,255,0.08);flex-shrink:0;`;
          pill.appendChild(sep);

          // Agent icon (SVG sparkle)
          const iconWrap = document.createElement('div');
          iconWrap.style.cssText = `display:flex;align-items:center;flex-shrink:0;`;
          iconWrap.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="url(#ag-grad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="ag-grad" x1="0" y1="0" x2="24" y2="24"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#c084fc"/></linearGradient></defs><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z"/><path d="M19 15l1.04 3.13L23.18 19l-3.14.87L19 23l-1.04-3.13L14.82 19l3.14-.87L19 15z" opacity="0.6"/></svg>';
          pill.appendChild(iconWrap);

          // Text content
          const textWrap = document.createElement('div');
          textWrap.style.cssText = `display:flex;flex-direction:column;gap:2px;`;
          const titleEl = document.createElement('span');
          titleEl.style.cssText = `font-size:14px;font-weight:600;letter-spacing:-0.02em;color:#e0e7ff;line-height:1.2;`;
          titleEl.textContent = 'Antigravity Agent Active';
          const subEl = document.createElement('span');
          subEl.style.cssText = `font-size:11.5px;font-weight:400;color:#94a3b8;letter-spacing:0.01em;line-height:1.3;`;
          subEl.textContent = 'Interaction paused while agent is working';
          textWrap.appendChild(titleEl);
          textWrap.appendChild(subEl);
          pill.appendChild(textWrap);

          // Animated typing dots
          const dotsWrap = document.createElement('div');
          dotsWrap.style.cssText = `display:flex;gap:4px;align-items:center;margin-left:4px;`;
          for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.style.cssText = `
              width:5px;height:5px;border-radius:50%;
              background:#818cf8;
              animation: mcp-dot-bounce 1.4s ease-in-out infinite;
              animation-delay: ${i * 0.2}s;
            `;
            dotsWrap.appendChild(dot);
          }
          pill.appendChild(dotsWrap);
          overlay.appendChild(pill);

          /* ── Pulse border (for blocked-interaction flash) ─────── */
          const pulseBorder = document.createElement('div');
          pulseBorder.id = '__mcpAgentPulseBorder';
          pulseBorder.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            border: 3px solid transparent; box-sizing: border-box;
            pointer-events: none; z-index: 2147483646;
            transition: border-color 0.3s ease;
            border-radius: 2px;
          `;

          /* ── Ghost cursor ── */
          const ghostCursor = document.createElement('div');
          ghostCursor.id = 'mcp-ghost-cursor';
          document.documentElement.appendChild(ghostCursor);

          /* ── Mount ── */
          document.documentElement.appendChild(overlay);
          document.documentElement.appendChild(pulseBorder);
        };

        window.__mcpUpdateAgentActive = (active) => {
          window.__mcpAgentActive = active;
          const overlay = document.getElementById('__mcpAgentOverlay');
          const cursor = document.getElementById('mcp-ghost-cursor');

          // Apply document-level locking for the real user
          if (active) {
            document.documentElement.style.cursor = 'not-allowed';
            document.documentElement.style.userSelect = 'none';
            document.documentElement.style.overflow = 'hidden';
          } else {
            document.documentElement.style.cursor = '';
            document.documentElement.style.userSelect = '';
            document.documentElement.style.overflow = '';
          }

          if (overlay) {
            if (active) {
              overlay.style.display = 'block';
              if (cursor) cursor.style.opacity = '1';
              setTimeout(() => overlay.style.opacity = '1', 10);
            } else {
              overlay.style.opacity = '0';
              if (cursor) cursor.style.opacity = '0';
              setTimeout(() => overlay.style.display = 'none', 300);
            }
          }
        };

        window.__mcpUpdateGhostCursor = (x, y) => {
          const cursor = document.getElementById('mcp-ghost-cursor');
          if (cursor) {
            cursor.style.left = `${x}px`;
            cursor.style.top = `${y}px`;

            // Add trail
            const trail = document.createElement('div');
            trail.className = 'mcp-cursor-trail';
            trail.style.left = `${x}px`;
            trail.style.top = `${y}px`;
            document.documentElement.appendChild(trail);
            setTimeout(() => trail.remove(), 500);
          }
        };

        const intercept = (e) => {
          // Check session storage real-time in case it changed in another frame
          if (window.__mcpAgentActive || isStickyActive()) {
            // Allow MCP/Playwright synthetic events (isTrusted: false) - only block real user events
            if (!e.isTrusted) {
              return; // Let MCP/AI agent actions through
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Visual feedback
            const border = document.getElementById('__mcpAgentPulseBorder');
            const pill = document.getElementById('__mcpAgentPill');

            if (pill) {
              pill.classList.remove('mcp-shake-small');
              void pill.offsetWidth;
              pill.classList.add('mcp-shake-small');
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

    await moveMouseHumanoid(
      session.page,
      from,
      { x, y },
      async (curX, curY) => {
        await session.page.evaluate(({ x, y }) => {
          if (window.__mcpUpdateGhostCursor) window.__mcpUpdateGhostCursor(x, y);
        }, { x: curX, y: curY });
      }
    );

    session.lastMousePos = { x, y };
  }

  async waitForSettle(session, policy = "normal") {
    const timeout = policy === "lazy" ? 50 : policy === "strict" ? 2000 : 500;

    // Domain-specific cold start protection
    const url = session.page.url();
    const isSlowDomain = url.includes("onrender.com") || url.includes("vercel.app") || url.includes("render.com");
    // OnRender is slow to wake up, but once it starts, we don't need a huge wait per action.
    // We only force a long wait if the page title suggests it's still "loading/waking up".
    const effectiveTimeout = timeout;

    if (config.turboMode && policy !== "strict" && !isSlowDomain) {
      try {
        await session.page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 50));
      } catch { /* ignore */ }
      return;
    }

    /**
     * Intelligent wait for page stability.
     * 1. Waits for initial load.
     * 2. Waits for network idle.
     * 3. Uses MutationObserver to ensure the DOM has stopped shifting for at least 500ms.
     */
    try {
      await session.page.waitForLoadState("load", { timeout: 10000 }).catch(() => { });
      await session.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => { });

      // Stabilization: Wait for DOM mutations to stabilize (no changes for 500ms)
      await session.page.waitForFunction(() => {
        return new Promise((resolve) => {
          let lastMutation = Date.now();
          const observer = new MutationObserver(() => {
            lastMutation = Date.now();
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });

          const check = setInterval(() => {
            if (Date.now() - lastMutation > 500) {
              clearInterval(check);
              observer.disconnect();
              resolve(true);
            }
          }, 100);

          setTimeout(() => {
            clearInterval(check);
            observer.disconnect();
            resolve(true);
          }, 5000); // Max stabilization wait
        });
      }, { timeout: 6000 }).catch(() => { });

      await new Promise(r => setTimeout(r, effectiveTimeout));
    } catch { /* ignore */ }
  }

  async setAgentActive(session, active) {
    // If we're activating, do it immediately and cancel any pending deactivation
    if (active) {
      if (session._agentLockTimer) {
        clearTimeout(session._agentLockTimer);
        session._agentLockTimer = null;
      }
      await this._sendAgentActiveState(session, true);
    } else {
      // If we're deactivating, wait a bit to avoid flickering between rapid tool calls
      if (session._agentLockTimer) clearTimeout(session._agentLockTimer);
      session._agentLockTimer = setTimeout(async () => {
        await this._sendAgentActiveState(session, false);
        session._agentLockTimer = null;
      }, 4000); // 4 seconds covers standard AI agent thinking time
    }
  }

  async _sendAgentActiveState(session, active) {
    session._agentActive = active;
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

  /**
   * Wraps an async function with interaction lock.
   * Ensures setAgentActive(true/false) is always toggled via try/finally.
   */
  async withAgentLock(session, fn) {
    await this.setAgentActive(session, true);
    try {
      return await fn();
    } finally {
      await this.setAgentActive(session, false);
    }
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

    // Special handling for bracketed names like data[0][item_name]
    if (q.includes("[") && q.includes("]")) {
      const cleanName = q.replace(/['"]/g, "");
      candidates.push({ strategy: "exact-name", selector: `[name='${cleanName}']`, type: "css" });
      // Also try escaping brackets if needed, though Playwright handles raw strings in [name='...'] well
      const escaped = cleanName.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      candidates.push({ strategy: "escaped-name", selector: `[name='${escaped}']`, type: "css" });
    }

    const textSelector = tokens.join(" ") || q;
    if (textSelector) {
      // 1. For non-interaction actions, or if action is not type/select, keep standard ordering
      if (action !== "type" && action !== "upload" && action !== "select") {
        candidates.push({ strategy: "text", selector: `text=${textSelector}`, type: "text" });
      }

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
        const fuzzy = `translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ:','abcdefghijklmnopqrstuvwxyz  ')`;
        candidates.push({
          strategy: "label-input",
          selector: `xpath=//label[contains(${fuzzy},'${textSelector}')]/following::*[self::input or self::textarea or self::select][1]`,
          type: "xpath"
        });
        candidates.push({
          strategy: "near-text-input",
          selector: `xpath=//*[contains(${fuzzy},'${textSelector}')]/following::*[self::input or self::textarea or self::select][1]`,
          type: "xpath"
        });
        candidates.push({
          strategy: "parent-input",
          selector: `xpath=//*[contains(${fuzzy},'${textSelector}')]/parent::*//*[self::input or self::textarea or self::select][1]`,
          type: "xpath"
        });

        // Table Column Header Strategy: Find input in a cell under a <th> containing the text
        candidates.push({
          strategy: "table-col-input",
          selector: `xpath=//table//th[contains(${fuzzy},'${textSelector}')]/ancestor::table//tr//td[count(//table//th[contains(${fuzzy},'${textSelector}')]/preceding-sibling::th)+1]//*[self::input or self::textarea or self::select]`,
          type: "xpath"
        });
      }

      // Add standard text match as a lower-priority fallback for typing
      if (action === "type" || action === "upload" || action === "select") {
        candidates.push({ strategy: "text", selector: `text=${textSelector}`, type: "text" });
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

  /**
   * Resolves a natural language query or CSS selector to a stable Playwright locator.
   * Uses a multi-layered strategy: 
   * 1. Direct CSS match (highest priority)
   * 2. Semantic matches (ID, name, data-testid)
   * 3. Human-centric matches (labels, placeholders, aria-labels)
   * 4. Positional/Relational matches (e.g. input near label)
   */
  async resolveSelector(session, { selector, query, action }) {
    const page = session.page;

    // Support typing/clicking with NO selector (current focus)
    if (!selector && !query) {
      return { strategy: "focus", selector: "focused" };
    }

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
    if (candidates.length === 0) {
      // Fallback for query-only if candidates failed but we have a query
      if (query) return { selector: `text=${query}`, strategy: "fallback-text" };
      return { strategy: "focus", selector: "focused" };
    }

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
        throw new Error(`Unable to resolve selector for: "${query || selector}". AI TIP: Try calling 'browser_analyze' first to see available interactive elements, or use 'browser_wait' if you think the page is still loading.`);
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

    // ─── Self-Healing Fallback ──────────────────────────────
    if (config.selfHealingEnabled) {
      const originalSelector = selector || `text=${query}`;
      const healResult = await selfHealingSelector.heal(page, originalSelector, query, action);
      if (healResult.healed) {
        svcLog.info("Self-healing recovered selector", {
          original: originalSelector,
          healed: healResult.selector,
          strategy: healResult.strategy
        });
        if (_wsService) _wsService.healingEvent(healResult);
        return { selector: healResult.selector, strategy: `self-healed:${healResult.strategy}` };
      }
    }

    throw new Error(`Unable to resolve selector for: "${query || selector}". AI TIP: Try calling 'browser_analyze' first to see available interactive elements, or use 'browser_wait' if you think the page is still loading.`);
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

      // 1. Label Mapping (id -> labelText)
      const labelMap = {};
      Array.from(document.querySelectorAll('label')).forEach(label => {
        const forId = label.getAttribute('for');
        if (forId) {
          labelMap[forId] = (label.innerText || label.textContent || "").trim();
        } else {
          // Check for nested inputs
          const input = label.querySelector('input, select, textarea');
          if (input && input.id) labelMap[input.id] = (label.innerText || label.textContent || "").trim();
        }
      });

      const forms = [];
      const interactive = Array.from(document.querySelectorAll("button, a, input, textarea, select, [role='button'], [onclick]"))
        .filter(isVisible)
        .slice(0, 100) // Slightly larger cap
        .map((el) => {
          const tagName = el.tagName.toLowerCase();
          const id = el.id;

          // Determine the best "Human Label" for this field
          let label = labelMap[id] || "";
          if (!label) {
            // Find closest parent label if any
            const parentLabel = el.closest('label');
            if (parentLabel) label = (parentLabel.innerText || parentLabel.textContent || "").trim();
          }

          const info = {
            tag: tagName,
            label: label || undefined,
            text: firstText(el),
            selector: selectorHint(el),
            name: el.getAttribute("name") || undefined,
            type: el.getAttribute("type") || undefined,
            placeholder: el.getAttribute("placeholder") || undefined,
            aria: el.getAttribute("aria-label") || undefined,
            required: el.hasAttribute("required") || undefined,
            value: (el.value !== undefined && tagName !== 'select') ? String(el.value).slice(0, 100) : undefined
          };

          if (tagName === 'select') {
            info.options = Array.from(el.options).slice(0, 15).map(o => o.textContent.trim());
            info.currentValue = el.value;
          }

          return info;
        });

      // 2. Form Grouping & Suggested Payload Generation
      const formElements = Array.from(document.querySelectorAll('form')).map((formEl, index) => {
        const inputs = Array.from(formEl.querySelectorAll('input, select, textarea'))
          .filter(isVisible)
          .filter(i => !['submit', 'button', 'reset', 'hidden'].includes(i.getAttribute('type')));

        const suggestedPayload = {};
        inputs.forEach(input => {
          const bestKey = labelMap[input.id] || input.getAttribute('placeholder') || input.getAttribute('name') || input.id || "Unknown Field";
          suggestedPayload[bestKey] = input.value || "value";
        });

        const submitButtons = Array.from(formEl.querySelectorAll('button, input[type="submit"]'))
          .map(b => ({ text: firstText(b), selector: selectorHint(b) }));

        return {
          id: formEl.id || `form-${index}`,
          action: formEl.getAttribute("action") || undefined,
          fieldCount: inputs.length,
          suggestedPayload,
          submitButtons
        };
      });

      return {
        title: document.title,
        url: window.location.href,
        interactiveCount: interactive.length,
        forms: formElements,
        elements: interactive
      };
    });
  }

  /**
   * Advanced heuristic-based discovery of interactive elements.
   * Useful for autonomous exploration and site mapping.
   */
  async discoverClickables(session) {
    return session.page.evaluate(() => {
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
      };

      const items = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [onclick]'))
        .filter(isVisible)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || "").trim().slice(0, 50),
          role: el.getAttribute('role') || undefined,
          id: el.id || undefined,
          href: el.tagName === 'A' ? el.getAttribute('href') : undefined,
          selector: el.id ? `#${el.id}` : el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : undefined
        }));

      return {
        count: items.length,
        items: items.slice(0, 50) // Capped for AI readability
      };
    });
  }

  async openUrl({ sessionId, url, headless, persist }) {
    const session = await this.getOrCreateSession(sessionId, { headless, persist, url });
    await this.setAgentActive(session, true);
    try {
      await session.page.goto(url, {
        waitUntil: "load", // Changed from domcontentloaded for better initial reliability
        timeout: config.defaultTimeoutMs
      });

      // Wait for the page to stop shifting (Stabilize)
      await this.waitForSettle(session, "strict");
      let title = await session.page.title();

      const isColdStartProxy = (t) => {
        const lower = t.toLowerCase();
        return lower.includes("application loading") ||
          lower.includes("starting up") ||
          lower.includes("waking up");
      };

      if (isColdStartProxy(title)) {
        this.appendScratchpad(session, `Detected cold start proxy ("${title}"). Waiting for application to wake up...`);
        try {
          await session.page.waitForFunction(
            () => {
              const lower = document.title.toLowerCase();
              return !(lower.includes("application loading") || lower.includes("starting up") || lower.includes("waking up"));
            },
            { timeout: 60000, polling: 2000 }
          );

          await session.page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => { });
          await this.waitForSettle(session);
          title = await session.page.title();
          this.appendScratchpad(session, `Application woke up. New title: "${title}"`);
        } catch (e) {
          this.appendScratchpad(session, `Timeout waiting for application to wake up.`);
        }
      }

      this.appendScratchpad(session, `Opened: ${url} → "${title}"`);
      this.logAction(session, { action: "open", selector: url, result: "success", metadata: { url } });
      session.actionHistory.push({ action: "open", target: url, timestamp: new Date().toISOString() });
      return {
        sessionId: session.id,
        url: session.page.url(),
        title,
        status: "success",
        tip: "AI TIP: Run 'browser_analyze' next to see what you can interact with on this page."
      };
    } finally {
      await this.setAgentActive(session, false);
    }
  }

  async hover({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.withAgentLock(session, async () => {
      const resolved = await this.resolveSelector(session, { selector, query, action: "hover" });
      const locator = session.page.locator(resolved.selector).first();
      await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

      const box = await locator.boundingBox();
      if (box) {
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        await this.moveMouseNatural(session, { x: centerX, y: centerY });

        // Humanoid idle hover
        const { hoverHumanoid } = await import("../utils/humanoid.js");
        await hoverHumanoid(session.page, { x: centerX, y: centerY }, async (curX, curY) => {
          await session.page.evaluate(({ x, y }) => {
            if (window.__mcpUpdateGhostCursor) window.__mcpUpdateGhostCursor(x, y);
          }, { x: curX, y: curY });
        });
      }

      await locator.hover({ timeout: config.defaultTimeoutMs });
      this.appendScratchpad(session, `Hovered: "${query || selector}"`);
      return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy };
    });
  }

  async smartScrape({ sessionId, query, maxItems = 20 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    this.appendScratchpad(session, `🚀 God-level Smart Scrape initiated for: "${query || 'Current View'}"`);

    return this.withAgentLock(session, async () => {
      const data = await session.page.evaluate(({ query, maxItems }) => {
        const results = [];

        // Helper to find list containers
        const findContainers = () => {
          const all = document.querySelectorAll('div, section, ul, table, tbody');
          return Array.from(all).filter(el => {
            const children = Array.from(el.children);
            if (children.length < 3) return false;

            // Check if children look similar (tags or classes)
            const tags = children.map(c => c.tagName);
            const mostCommonTag = tags.sort((a, b) => tags.filter(v => v === a).length - tags.filter(v => v === b).length).pop();
            const tagCount = tags.filter(t => t === mostCommonTag).length;

            return tagCount / tags.length > 0.7;
          });
        };

        const containers = findContainers();

        // Pick the best container or use body
        const container = containers[0] || document.body;
        const items = Array.from(container.children).slice(0, maxItems);

        items.forEach(item => {
          const itemData = {};

          // Extract text from common elements
          const headings = item.querySelectorAll('h1, h2, h3, h4, h5, h6, .title, .name');
          if (headings.length > 0) itemData.title = headings[0].innerText.trim();

          const prices = item.querySelectorAll('.price, [class*="price"], [id*="price"]');
          if (prices.length > 0) itemData.price = prices[0].innerText.trim();

          const links = item.querySelectorAll('a');
          if (links.length > 0) itemData.url = links[0].href;

          const imgs = item.querySelectorAll('img');
          if (imgs.length > 0) itemData.image = imgs[0].src;

          // Generic fallback: all meaningful text
          if (Object.keys(itemData).length === 0) {
            itemData.text = item.innerText.trim().split('\n')[0].slice(0, 100);
          }

          results.push(itemData);
        });

        return {
          title: document.title,
          url: window.location.href,
          itemCount: results.length,
          items: results
        };
      }, { query, maxItems });

      this.appendScratchpad(session, `✅ Scraped ${data.itemCount} items.`);
      return data;
    });
  }

  async click({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.withAgentLock(session, async () => {
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

      try {
        await locator.click({ timeout: config.defaultTimeoutMs });
      } catch (err) {
        if (err.message.includes("intercepts pointer events") || err.message.includes("is not stable")) {
          this.appendScratchpad(session, `  ⚠ Click intercepted, retrying with force:true...`);
          await locator.click({ timeout: config.defaultTimeoutMs, force: true });
        } else {
          throw err;
        }
      }

      await this.waitForSettle(session);
      this.appendScratchpad(session, `Clicked: "${query || selector}" → ${resolved.strategy}`);
      this.logAction(session, { action: "click", selector: resolved.selector, result: "success", metadata: { query, strategy: resolved.strategy } });
      session.actionHistory.push({ action: "click", target: query || selector, timestamp: new Date().toISOString() });

      return {
        sessionId: session.id,
        selector: resolved.selector,
        strategy: resolved.strategy
      };
    });
  }

  async type({ sessionId, selector, text, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return this.withAgentLock(session, async () => {
      const resolved = await this.resolveSelector(session, { selector, query, action: "type" });

      // Handle focus-based typing
      if (resolved.strategy === "focus") {
        this.appendScratchpad(session, `Typing into focused element: "${String(text).slice(0, 20)}..."`);
        await session.page.keyboard.type(String(text), { delay: config.turboMode ? 0 : 30 });
        return { sessionId: session.id, strategy: "focus", typedLength: text.length };
      }

      const locator = session.page.locator(resolved.selector).first();
      await locator.waitFor({ state: "visible", timeout: 8000 });

      // Check if readonly or disabled
      const isReady = await locator.evaluate(el => {
        return !el.readOnly && !el.disabled && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.hasAttribute('contenteditable'));
      });

      if (!isReady) {
        const status = await locator.evaluate(el => el.readOnly ? "readonly" : el.disabled ? "disabled" : "not-editable");
        this.appendScratchpad(session, `Skipped typing into ${status} field: "${query || selector}"`);
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

      if (config.turboMode) {
        await locator.fill(String(text));
      } else {
        await typeHumanoid(locator, String(text));
        await new Promise(r => setTimeout(r, 400));
      }

      // Force trigger events for dynamic UIs (React/Vue/etc)
      await locator.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      });

      await this.waitForSettle(session);

      this.appendScratchpad(session, `Typed into "${query || selector}": "${String(text).slice(0, 30)}..."`);
      this.logAction(session, { action: "type", selector: resolved.selector, result: "success", metadata: { query, strategy: resolved.strategy, textLength: text.length } });
      session.actionHistory.push({ action: "type", target: query || selector, timestamp: new Date().toISOString() });

      return {
        sessionId: session.id,
        selector: resolved.selector,
        strategy: resolved.strategy,
        typedLength: text.length
      };
    });
  }

  async fillForm({ sessionId, fields, turbo = null }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!fields || typeof fields !== "object") throw new Error("fields must be an object like { 'email field': 'test@example.com', ... }");

    const isTurbo = turbo !== null ? this.toBoolean(turbo) : config.turboMode;

    await this.setAgentActive(session, true);
    this.appendScratchpad(session, `Filling form with ${Object.keys(fields).length} fields (turbo=${isTurbo})`);

    const results = [];
    const fieldEntries = Object.entries(fields);

    // 🚀 STEP 1: Batch Selector Resolution (The "Thinking" Phase)
    // Resolve all selectors in parallel at the start to eliminate pauses between movements
    this.appendScratchpad(session, `  ⏳ Resolving all fields...`);
    const resolutionResults = await Promise.all(
      fieldEntries.map(async ([query, value]) => {
        try {
          const resolved = await this.resolveSelector(session, { query, action: "type" });
          return { query, value, resolved, error: null };
        } catch (error) {
          return { query, value, resolved: null, error: error.message };
        }
      })
    );

    // 🚀 STEP 2: Sequential Interaction (The "Action" Phase)
    for (const { query, value, resolved, error } of resolutionResults) {
      if (error) {
        results.push({ field: query, status: "failed", error });
        continue;
      }

      try {
        const locator = session.page.locator(resolved.selector).first();

        // Dynamic timeout based on mode
        const waitTimeout = isTurbo ? 1000 : 3000;
        await locator.waitFor({ state: "visible", timeout: waitTimeout });

        // Ensure field is in view and ready for interaction
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });

        // Visual feedback (Humanoid mode)
        if (!isTurbo) {
          const box = await locator.boundingBox();
          if (box) {
            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;
            // Slightly faster mouse for batch forms
            await this.moveMouseNatural(session, { x: centerX, y: centerY });
            await this.showRipple(session, centerX, centerY);
          }
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
          } else {
            throw new Error(`No matching option for "${strVal}"`);
          }
        } else if (inputType === "date") {
          await locator.fill(String(value));
        } else if (inputType === "checkbox" || inputType === "radio") {
          const checked = await locator.isChecked();
          const shouldCheck = ["true", "1", "yes", "on"].includes(String(value).toLowerCase());
          if (checked !== shouldCheck) await locator.click({ force: true });
        } else if (inputType === "file") {
          await locator.setInputFiles(String(value));
        } else {
          const isEditable = await locator.evaluate(el => !el.readOnly && !el.disabled);
          if (isEditable) {
            // Clear existing text first
            await locator.fill("");

            if (!isTurbo) {
              // Human-like typing
              await locator.click({ force: true }).catch(() => { });
              await typeHumanoid(locator, String(value));
              await new Promise(r => setTimeout(r, 150));
            } else {
              // Rapid fill
              await locator.fill(String(value));
            }

            // Force trigger events
            await locator.evaluate(el => {
              ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
            });
            this.appendScratchpad(session, `  ✓ ${query} = "${String(value).slice(0, 15)}..."`);
          } else {
            this.appendScratchpad(session, `  ⚠ ${query} is read-only, skipped.`);
            throw new Error(`Field is readonly or disabled`);
          }
        }

        results.push({ field: query, status: "filled", strategy: resolved.strategy });
      } catch (err) {
        results.push({ field: query, status: "failed", error: err.message });
      }
    }

    // Only settle once at the end
    await this.waitForSettle(session, isTurbo ? "lazy" : "normal");

    this.logAction(session, { action: "fillForm", result: "success", metadata: { fieldCount: fieldEntries.length, turbo: isTurbo } });
    session.actionHistory.push({ action: "fillForm", target: `${fieldEntries.length} fields`, timestamp: new Date().toISOString() });

    return {
      sessionId: session.id,
      results,
      filledCount: results.filter(r => r.status === "filled").length,
      failedCount: results.filter(r => r.status === "failed").length
    };
  }

  async screenshot({ sessionId, fileName, fullPage = false, embedImage = true, saveLocal = false, analyze = false, prompt = "" }) {
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

    let analysis = "";
    if (analyze && visionService.isAvailable()) {
      const visionResult = await visionService.analyzeScreenshot(buffer, prompt);
      analysis = visionResult.analysis;
    }

    // Optimization: If analysis or local save is requested, suppress the large base64 string
    // to prevent clogging the AI's/user's terminal output.
    const shouldEmbed = analyze || saveLocal ? (embedImage === true && embedImage !== "lean") : !!embedImage;

    const resultPayload = {
      sessionId: session.id,
      url: session.page.url(),
      path: absolutePath,
      imageBase64: shouldEmbed ? buffer.toString("base64") : null,
      analysis,
      timestamp: new Date().toISOString()
    };

    if (saveLocal) {
      session.screenshotHistory.push(resultPayload);
    }

    // Real-time broadcast
    if (_wsService) _wsService.screenshotTaken(session.id, resultPayload);

    this.logAction(session, {
      action: "screenshot",
      result: "success",
      metadata: { ...resultPayload, saveLocal, imageBase64: !!resultPayload.imageBase64 }
    });

    return resultPayload;
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
    return this.withAgentLock(session, async () => {
      await session.page.mouse.wheel(0, pixels);
      this.appendScratchpad(session, `Scrolled ${pixels}px`);
      this.logAction(session, { action: "scroll", result: "success", metadata: { pixels } });
      session.actionHistory.push({ action: "scroll", target: String(pixels), timestamp: new Date().toISOString() });
      return { sessionId: session.id, pixels };
    });
  }

  // Redundant hover removed in favor of humanoid implementation at line 1407.


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
    const normalizedLandscape = this.toBoolean(landscape, false);
    const normalizedPrintBackground = this.toBoolean(printBackground, true);
    const cleanRawName = String(rawName).replace(/[^\w.\-() ]/g, "_");
    const safeName = cleanRawName.endsWith(".pdf") ? cleanRawName : `${cleanRawName}.pdf`;
    const absolutePath = path.resolve(root, safeName);

    await session.page.pdf({
      path: absolutePath,
      format,
      landscape: normalizedLandscape,
      printBackground: normalizedPrintBackground,
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
    return this.withAgentLock(session, async () => {
      for (let i = 0; i < count; i++) {
        await session.page.keyboard.press(key, { delay });
      }
      this.appendScratchpad(session, `Pressed key: ${key} (x${count})`);
      this.logAction(session, { action: "pressKey", result: "success", metadata: { key, count } });
      return { sessionId: session.id, key, count };
    });
  }

  async upload({ sessionId, selector, query, filePath }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!filePath) throw new Error("Missing required field: filePath");
    return this.withAgentLock(session, async () => {
      const resolved = await this.resolveSelector(session, { selector, query, action: "upload" });
      const absoluteFilePath = path.resolve(filePath);

      const locator = session.page.locator(resolved.selector).first();
      await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
      await locator.setInputFiles(absoluteFilePath);

      this.appendScratchpad(session, `Uploaded file: "${absoluteFilePath}"`);
      this.logAction(session, { action: "upload", selector: resolved.selector, result: "success", metadata: { filePath: absoluteFilePath } });
      session.actionHistory.push({ action: "upload", target: query || selector, timestamp: new Date().toISOString() });

      return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, filePath: absoluteFilePath };
    });
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
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
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
    await sessionStore.remove(sessionId);
    return { sessionId, cleanedUp: !!shouldCleanup };
  }

  // ─── Session Recovery ─────────────────────────────────

  async reconnectSession({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    // Check if the page is still alive
    let alive = false;
    try {
      await session.page.title();
      alive = true;
    } catch { /* page crashed or closed */ }

    if (!alive) {
      // Try to recover by creating a new page in the same context
      try {
        session.page = await session.context.newPage();
        await this.injectInteractionMonitor(session);
        this.appendScratchpad(session, "⚡ Session reconnected — new page created");
      } catch (err) {
        throw new Error(`Cannot reconnect session: ${err.message}`);
      }
    } else {
      // Re-inject monitor in case it was lost
      await this.injectInteractionMonitor(session);
      this.appendScratchpad(session, "✓ Session is alive and monitor re-injected");
    }

    return {
      sessionId: session.id,
      alive,
      currentUrl: session.page.url(),
      actionCount: session.actionHistory.length
    };
  }

  // ─── Deep Clone — Pixel-Perfect Extraction ───────────

  async deepClone({ sessionId, selector = "body" }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const keys = COMPUTED_STYLE_PROPERTY_KEYS;

    const extraction = await session.page.evaluate(async ({ selector, styleKeys }) => {
      const root = document.querySelector(selector);
      if (!root) return null;

      // 1. Extract ALL stylesheet rules (including :hover, :focus, @keyframes, @media)
      const allCSS = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            allCSS.push(rule.cssText);
          }
        } catch { /* cross-origin stylesheet, skip */ }
      }

      // 2. Extract @font-face declarations
      const fontFaces = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule instanceof CSSFontFaceRule) {
              fontFaces.push(rule.cssText);
            }
          }
        } catch { /* skip */ }
      }

      // 3. Extract all asset URLs
      const assets = {
        images: [],
        backgroundImages: [],
        svgs: [],
        icons: []
      };

      // Images
      document.querySelectorAll("img[src]").forEach(img => {
        assets.images.push({ src: img.src, alt: img.alt || "", width: img.naturalWidth, height: img.naturalHeight });
      });

      // Background images
      const allEls = document.querySelectorAll("*");
      for (const el of Array.from(allEls).slice(0, 2000)) {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") {
          const urls = bg.match(/url\(["']?([^"')]+)["']?\)/g);
          if (urls) urls.forEach(u => assets.backgroundImages.push(u));
        }
      }

      // Inline SVGs
      document.querySelectorAll("svg").forEach((svg, i) => {
        if (i < 50) assets.svgs.push(svg.outerHTML.slice(0, 5000));
      });

      // Icons
      document.querySelectorAll('link[rel*="icon"]').forEach(link => {
        assets.icons.push({ rel: link.rel, href: link.href, sizes: link.sizes?.value || "" });
      });

      // 4. Extract pseudo-state CSS rules (:hover, :focus, :active)
      const pseudoRules = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.selectorText && /:hover|:focus|:active|:visited|::before|::after/.test(rule.selectorText)) {
              pseudoRules.push(rule.cssText);
            }
          }
        } catch { /* skip */ }
      }

      // 5. Extract @keyframes animations
      const animations = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule instanceof CSSKeyframesRule) {
              animations.push(rule.cssText);
            }
          }
        } catch { /* skip */ }
      }

      // 6. Extract meta + links
      const meta = {};
      document.querySelectorAll("meta").forEach(m => {
        const name = m.getAttribute("name") || m.getAttribute("property") || "";
        if (name) meta[name] = m.content || "";
      });

      const externalCSS = [];
      document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
        externalCSS.push(link.href);
      });

      const externalFonts = [];
      document.querySelectorAll('link[href*="fonts"]').forEach(link => {
        externalFonts.push(link.href);
      });

      // 7. Build DOM tree with computed styles
      const getSafeStyle = (el) => {
        const cs = getComputedStyle(el);
        const styles = {};
        for (const k of styleKeys) {
          const val = cs.getPropertyValue(k);
          if (val && val !== "initial" && val !== "none" && val !== "normal") {
            styles[k] = val;
          }
        }
        return styles;
      };

      const walk = (el, depth) => {
        if (depth > 12) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;

        const node = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          className: typeof el.className === "string" ? el.className : undefined,
          text: el.children.length === 0 ? (el.innerText || "").trim().slice(0, 300) : undefined,
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          styles: getSafeStyle(el),
          attributes: {},
          children: []
        };

        for (const attr of el.attributes) {
          if (["src", "href", "placeholder", "alt", "type", "value", "role", "aria-label", "data-testid"].includes(attr.name)) {
            node.attributes[attr.name] = attr.value;
          }
        }

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
        meta,
        externalCSS,
        externalFonts,
        allCSS: allCSS.slice(0, 5000),
        pseudoRules: pseudoRules.slice(0, 500),
        animations: animations.slice(0, 100),
        fontFaces: fontFaces.slice(0, 50),
        assets,
        domTree: walk(root, 0)
      };
    }, { selector, styleKeys: keys });

    if (!extraction) {
      throw new Error(`Selector "${selector}" not found on page`);
    }

    // Take a reference screenshot for later comparison
    const referenceScreenshot = await session.page.screenshot({ fullPage: true });
    const screenshotRoot = this.sessionScreenshotRoot(session.id);
    await fs.mkdir(screenshotRoot, { recursive: true });
    const refPath = path.resolve(screenshotRoot, `deepclone-reference-${Date.now()}.png`);
    await fs.writeFile(refPath, referenceScreenshot);

    this.appendScratchpad(session, `Deep clone extracted: ${extraction.allCSS.length} CSS rules, ${extraction.pseudoRules.length} pseudo rules, ${extraction.animations.length} animations`);
    this.logAction(session, { action: "deepClone", result: "success", metadata: { selector } });

    return {
      sessionId: session.id,
      referenceScreenshotPath: refPath,
      extraction
    };
  }

  // ─── Hover Effect Capture (for Vision AI) ────────────

  async captureHoverEffect({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    return this.withAgentLock(session, async () => {
      const resolved = await this.resolveSelector(session, { selector, query, action: "hover" });
      const locator = session.page.locator(resolved.selector).first();
      await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

      // Take BEFORE screenshot
      const beforeBuffer = await session.page.screenshot({ fullPage: false });

      // Hover the element
      const box = await locator.boundingBox();
      if (box) {
        await this.moveMouseNatural(session, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      await locator.hover();
      await new Promise(r => setTimeout(r, 500)); // Wait for CSS transitions

      // Take AFTER screenshot
      const afterBuffer = await session.page.screenshot({ fullPage: false });

      this.appendScratchpad(session, `Captured hover effect on "${query || selector}"`);

      return {
        sessionId: session.id,
        selector: resolved.selector,
        strategy: resolved.strategy,
        beforeBuffer,
        afterBuffer
      };
    });
  }

  async closeAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession({ sessionId: id })));
  }

  /** Enhanced analyze with optional AI semantic labels. */
  async analyzeEnhanced({ sessionId, aiLabels = false }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    const summary = await this.analyzePageState(session);

    if (aiLabels && config.aiDecisionEnabled) {
      try {
        const { aiDecisionService } = await import("./aiDecisionService.js");
        if (aiDecisionService.isAvailable()) {
          summary.elements = await aiDecisionService.enhanceElementLabels(
            summary.elements,
            summary.title
          );
          summary.aiEnhanced = true;
        }
      } catch (err) {
        svcLog.warn("AI label enhancement failed", { error: err.message });
        summary.aiEnhanced = false;
      }
    }

    this.logAction(session, { action: "analyzeEnhanced", result: "success", metadata: { url: summary.url, aiLabels } });
    return { sessionId: session.id, ...summary };
  }
}

export const browserService = new BrowserService();
