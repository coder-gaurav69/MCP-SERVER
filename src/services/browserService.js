import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { agentActivityService } from "./agentActivityService.js";

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

  async getOrCreateSession(sessionId, options = {}) {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId);
    }

    const effectiveSessionId = sessionId || uuidv4();
    const headless = options.headless ?? config.defaultHeadless;
    const persist = options.persist ?? false;
    const userDataDir = persist ? path.resolve("user_data", effectiveSessionId) : null;
    // In headed mode, let the OS window size drive the viewport so Chromium can truly maximize.
    // A fixed Playwright viewport (e.g. 1920x1080) can make the app appear "not fully visible"
    // on Windows due to DPI scaling and non-maximized window bounds.
    const viewport = headless ? { width: 1920, height: 1080 } : null;
    const deviceScaleFactor = viewport ? 1 : undefined;

    if (persist) {
      await fs.mkdir(userDataDir, { recursive: true });
    }

    let browser;
    let context;
    let page;

    if (persist) {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        viewport,
        ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
        args: [
          "--disable-blink-features=AutomationControlled",
          "--start-maximized"
        ]
      });
      page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    } else {
      browser = await chromium.launch({
        headless,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--start-maximized"
        ]
      });
      context = await browser.newContext({
        viewport,
        ...(deviceScaleFactor ? { deviceScaleFactor } : {})
      });
      page = await context.newPage();
    }

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
        await fs.mkdir("downloads", { recursive: true });
        const suggested = download.suggestedFilename?.() || `download-${Date.now()}`;
        const safeName = suggested.replace(/[^\w.\-() ]/g, "_");
        const outPath = path.resolve("downloads", `${Date.now()}-${safeName}`);
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
    try {
      await session.page.exposeFunction("__mcpManualInteraction", () => {
        agentActivityService.notifyManualInteraction(session.id);
        this.appendScratchpad(session, "⚠ Manual user interaction detected");
      });

      await session.page.addInitScript(() => {
        window.__mcpAgentActive = false;
        let lastNotify = 0;
        const notify = () => {
          if (window.__mcpAgentActive) return;
          const now = Date.now();
          if (now - lastNotify > 2000 && window.__mcpManualInteraction) {
            lastNotify = now;
            window.__mcpManualInteraction();
          }
        };
        window.addEventListener("mousedown", notify, true);
        window.addEventListener("keydown", notify, true);
      });
    } catch (error) {
      // Silently ignore if already exposed
    }
  }

  async setAgentActive(session, active) {
    try {
      await session.page.evaluate((v) => { window.__mcpAgentActive = v; }, active);
    } catch { /* ignore */ }
  }

  async moveMouseFast(session, x, y) {
    const steps = 5;
    const from = session.lastMousePos;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      await session.page.mouse.move(
        from.x + (x - from.x) * t,
        from.y + (y - from.y) * t
      );
    }
    session.lastMousePos = { x, y };
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
    const candidates = this.buildSelectorCandidates({ selector, query, action });

    for (const candidate of candidates) {
      try {
        const locator = page.locator(candidate.selector);
        const visible = await this.isLocatorVisible(locator);
        if (visible) {
          return { selector: candidate.selector, strategy: candidate.strategy };
        }
      } catch {
        // Skip this candidate
      }
    }

    throw new Error(`Unable to resolve selector for: "${query || selector}"`);
  }

  async captureScreenshot(session, label) {
    await fs.mkdir(config.screenshotDir, { recursive: true });
    const safeLabel = (label || "shot").replace(/[^\w-]/g, "_");
    const fileName = `${Date.now()}-${safeLabel}.png`;
    const absolutePath = path.resolve(config.screenshotDir, fileName);
    try {
      await session.page.screenshot({ path: absolutePath, fullPage: false });
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
      const firstText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      const selectorHint = (el) => {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute("name")) return `[name='${el.getAttribute("name")}']`;
        if (el.className && typeof el.className === "string") return `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/)[0]}`;
        return el.tagName.toLowerCase();
      };

      const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']"))
        .slice(0, 50)
        .map((el) => ({ text: firstText(el), selector: selectorHint(el), visible: !!(el.offsetWidth || el.offsetHeight) }));

      const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 50)
        .map((el) => ({ text: firstText(el), href: el.getAttribute("href"), selector: selectorHint(el) }));

      const inputElements = Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 50);
      const inputs = inputElements.map((el, index) => {
        const id = el.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        return {
          index,
          selector: selectorHint(el),
          type: el.getAttribute("type") || el.tagName.toLowerCase(),
          name: el.getAttribute("name") || "",
          placeholder: el.getAttribute("placeholder") || "",
          label: label ? firstText(label) : "",
          required: el.hasAttribute("required")
        };
      });

      const forms = Array.from(document.querySelectorAll("form")).slice(0, 20).map((form, index) => ({
        index,
        id: form.id || "",
        method: (form.getAttribute("method") || "get").toLowerCase(),
        action: form.getAttribute("action") || "",
        inputCount: form.querySelectorAll("input, textarea, select").length,
        buttonCount: form.querySelectorAll("button, input[type='button'], input[type='submit']").length
      }));

      return {
        title: document.title,
        url: window.location.href,
        counts: {
          buttons: buttons.length,
          links: links.length,
          forms: forms.length,
          inputs: inputs.length
        },
        buttons,
        links,
        forms,
        inputs
      };
    });
  }

  async openUrl({ sessionId, url, headless, persist }) {
    const session = await this.getOrCreateSession(sessionId, { headless, persist });
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
  }

  async click({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await this.setAgentActive(session, true);
    const resolved = await this.resolveSelector(session, { selector, query, action: "click" });

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });

    const box = await locator.boundingBox();
    if (box) {
      await this.moveMouseFast(session, box.x + box.width / 2, box.y + box.height / 2);
    }

    await locator.click({ timeout: config.defaultTimeoutMs });
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

    const box = await locator.boundingBox();
    if (box) {
      await this.moveMouseFast(session, box.x + box.width / 2, box.y + box.height / 2);
    }

    await locator.click({ timeout: config.defaultTimeoutMs });
    await locator.fill("");
    await locator.fill(String(text));
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
          await this.moveMouseFast(session, box.x + box.width / 2, box.y + box.height / 2);
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
          await locator.fill("");
          await locator.fill(String(value));
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

  async screenshot({ sessionId, fileName, fullPage = false }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    await fs.mkdir(config.screenshotDir, { recursive: true });
    const safeName = fileName || `screenshot-${Date.now()}.png`;
    const absolutePath = path.resolve(config.screenshotDir, safeName);
    await session.page.screenshot({ path: absolutePath, fullPage });
    const metadata = {
      sessionId: session.id,
      path: absolutePath,
      url: session.page.url(),
      timestamp: new Date().toISOString()
    };
    session.screenshotHistory.push(metadata);
    this.logAction(session, { action: "screenshot", result: "success", metadata });
    return { sessionId: session.id, path: absolutePath, metadata };
  }

  async analyze({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const summary = await this.analyzePageState(session);
    this.logAction(session, { action: "analyze", result: "success", metadata: { url: summary.url } });
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
      await this.moveMouseFast(session, box.x + box.width / 2, box.y + box.height / 2);
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
  }

  async select({ sessionId, selector, query, value, label, index }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (value === undefined && label === undefined && index === undefined) throw new Error("Missing selection target: value, label, or index");
    const resolved = await this.resolveSelector(session, { selector, query, action: "select" });
    const option = value !== undefined ? { value: String(value) } : label !== undefined ? { label: String(label) } : { index: Number(index) };

    const locator = session.page.locator(resolved.selector).first();
    await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
    await locator.selectOption(option);

    this.appendScratchpad(session, `Selected option in "${query || selector}": ${JSON.stringify(option)}`);
    this.logAction(session, { action: "select", selector: resolved.selector, result: "success", metadata: { option } });
    session.actionHistory.push({ action: "select", target: query || selector, timestamp: new Date().toISOString() });

    return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, option };
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
        await session.page.goto(link, { waitUntil: "domcontentloaded", timeout: 8000 });
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

  async closeSession({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await session.context.close();
    if (session.browser) {
      await session.browser.close();
    }
    this.sessions.delete(sessionId);
    return { sessionId };
  }

  async closeAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession({ sessionId: id })));
  }
}

export const browserService = new BrowserService();
