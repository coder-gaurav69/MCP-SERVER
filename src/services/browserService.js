import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";

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
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const session = {
      id: effectiveSessionId,
      browser,
      context,
      page,
      consoleErrors: [],
      networkErrors: [],
      logs: [],
      actionHistory: [],
      screenshotHistory: [],
      lastAction: null,
      currentUrl: "about:blank",
      createdAt: new Date().toISOString()
    };

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

    this.sessions.set(effectiveSessionId, session);
    this.logAction(session, {
      action: "session.create",
      result: "success",
      retryCount: 0,
      metadata: { headless }
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

  getSnapshotFingerprint(snapshot) {
    const title = snapshot.title || "";
    const url = snapshot.url || "";
    const countSignature = `${snapshot.counts?.buttons || 0}-${snapshot.counts?.inputs || 0}-${snapshot.counts?.forms || 0}-${snapshot.counts?.links || 0}`;
    return `${title}|${url}|${countSignature}`;
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
    const first = locator.first();
    return first.isVisible();
  }

  async resolveSelector(session, { selector, query, action }) {
    const page = session.page;
    const candidates = this.buildSelectorCandidates({ selector, query, action });
    const attempts = [];

    for (const candidate of candidates) {
      try {
        const locator = page.locator(candidate.selector);
        const visible = await this.isLocatorVisible(locator);
        attempts.push({ ...candidate, visible });
        if (visible) {
          return { selector: candidate.selector, strategy: candidate.strategy, attempts };
        }
      } catch (error) {
        attempts.push({ ...candidate, visible: false, error: error.message });
      }
    }

    throw new Error(`Unable to resolve selector/query. Attempts: ${JSON.stringify(attempts)}`);
  }

  async captureActionScreenshot(session, actionName, phase) {
    await fs.mkdir(config.screenshotDir, { recursive: true });
    const safeAction = actionName.replace(/[^\w-]/g, "_");
    const fileName = `${Date.now()}-${safeAction}-${phase}.png`;
    const absolutePath = path.resolve(config.screenshotDir, fileName);
    await session.page.screenshot({ path: absolutePath, fullPage: true });
    const record = {
      action: actionName,
      phase,
      path: absolutePath,
      timestamp: new Date().toISOString(),
      url: session.page.url()
    };
    session.screenshotHistory.push(record);
    return record;
  }

  async analyzePageState(session) {
    return session.page.evaluate(() => {
      const firstText = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
      const selectorHint = (el) => {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute("name")) return `[name='${el.getAttribute("name")}']`;
        if (el.className && typeof el.className === "string") return `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/)[0]}`;
        return el.tagName.toLowerCase();
      };

      const buttons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']"))
        .slice(0, 200)
        .map((el) => ({ text: firstText(el), selector: selectorHint(el), visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) }));

      const links = Array.from(document.querySelectorAll("a[href]"))
        .slice(0, 200)
        .map((el) => ({ text: firstText(el), href: el.getAttribute("href"), selector: selectorHint(el) }));

      const inputElements = Array.from(document.querySelectorAll("input, textarea, select")).slice(0, 200);
      const inputs = inputElements.map((el, index) => {
        const id = el.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${id}"]`) : null;
        return {
          index,
          selector: selectorHint(el),
          type: el.getAttribute("type") || el.tagName.toLowerCase(),
          name: el.getAttribute("name") || "",
          placeholder: el.getAttribute("placeholder") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          label: label ? firstText(label) : "",
          required: el.hasAttribute("required")
        };
      });

      const forms = Array.from(document.querySelectorAll("form")).slice(0, 100).map((form, index) => ({
        index,
        id: form.id || "",
        method: (form.getAttribute("method") || "get").toLowerCase(),
        action: form.getAttribute("action") || "",
        inputCount: form.querySelectorAll("input, textarea, select").length,
        buttonCount: form.querySelectorAll("button, input[type='button'], input[type='submit']").length
      }));

      const images = Array.from(document.querySelectorAll("img")).slice(0, 200).map((img) => ({
        src: img.getAttribute("src") || "",
        alt: img.getAttribute("alt") || "",
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
        broken: !!img.getAttribute("src") && img.naturalWidth === 0
      }));

      const interactiveMap = Array.from(document.querySelectorAll("button, a, input, textarea, select, [role='button']"))
        .slice(0, 300)
        .map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: firstText(el),
          selector: selectorHint(el)
        }));

      return {
        title: document.title,
        url: window.location.href,
        counts: {
          buttons: buttons.length,
          links: links.length,
          forms: forms.length,
          images: images.length,
          inputs: inputs.length,
          interactiveElements: interactiveMap.length
        },
        buttons,
        links,
        forms,
        images,
        inputs,
        interactiveMap
      };
    });
  }

  async validateAction(session, beforeState, options = {}) {
    const afterState = await this.analyzePageState(session);
    const beforeFingerprint = this.getSnapshotFingerprint(beforeState);
    const afterFingerprint = this.getSnapshotFingerprint(afterState);
    const urlChanged = beforeState.url !== afterState.url;
    const domMutated = beforeFingerprint !== afterFingerprint;
    const targetVisible = options.expectedSelector
      ? await session.page.locator(options.expectedSelector).first().isVisible().catch(() => false)
      : true;

    const success = urlChanged || domMutated || targetVisible;
    const reason = success
      ? "Action verified by URL change, DOM mutation, or element visibility"
      : "No observable change detected after action";

    return {
      success,
      reason,
      evidence: {
        beforeUrl: beforeState.url,
        afterUrl: afterState.url,
        urlChanged,
        domMutated,
        expectedSelector: options.expectedSelector || "",
        targetVisible,
        beforeCounts: beforeState.counts,
        afterCounts: afterState.counts
      }
    };
  }

  async executeActionWithValidation(session, actionName, executor, options = {}) {
    const beforeState = await this.analyzePageState(session);
    const beforeShot = await this.captureActionScreenshot(session, actionName, "before");
    const result = await executor();
    const validation = await this.validateAction(session, beforeState, options);
    const afterShot = await this.captureActionScreenshot(session, actionName, "after");
    return {
      ...result,
      validation,
      screenshots: {
        before: beforeShot.path,
        after: afterShot.path
      }
    };
  }

  async openUrl({ sessionId, url, headless }) {
    const session = await this.getOrCreateSession(sessionId, { headless });
    const result = await this.executeActionWithValidation(
      session,
      "open",
      async () => {
        await session.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: config.defaultTimeoutMs
        });
        return {
          sessionId: session.id,
          url: session.page.url(),
          title: await session.page.title()
        };
      }
    );
    this.logAction(session, { action: "open", selector: url, result: "success", retryCount: 0, metadata: { url } });
    session.actionHistory.push({ action: "open", target: url, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async click({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    let retryCount = 0;
    const resolved = await this.resolveSelector(session, { selector, query, action: "click" });
    const result = await this.executeActionWithValidation(
      session,
      "click",
      async () => {
        await this.withRetry(async (attempt) => {
          retryCount = attempt - 1;
          const locator = session.page.locator(resolved.selector).first();
          await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
          await locator.hover();
          await locator.click({ timeout: config.defaultTimeoutMs });
        });
        return {
          sessionId: session.id,
          selector: resolved.selector,
          strategy: resolved.strategy,
          attempts: resolved.attempts
        };
      },
      { expectedSelector: resolved.selector }
    );
    this.logAction(session, {
      action: "click",
      selector: resolved.selector,
      result: result.validation.success ? "success" : "validation_failed",
      retryCount,
      metadata: { query: query || "", strategy: resolved.strategy }
    });
    session.actionHistory.push({ action: "click", target: query || selector, selector: resolved.selector, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async type({ sessionId, selector, text, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    let retryCount = 0;
    const resolved = await this.resolveSelector(session, { selector, query, action: "type" });
    const result = await this.executeActionWithValidation(
      session,
      "type",
      async () => {
        await this.withRetry(async (attempt) => {
          retryCount = attempt - 1;
          const locator = session.page.locator(resolved.selector).first();
          await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
          await locator.click({ timeout: config.defaultTimeoutMs });
          await locator.fill("");
          await locator.type(text, { delay: 30 });
        });
        return {
          sessionId: session.id,
          selector: resolved.selector,
          strategy: resolved.strategy,
          typedLength: text.length,
          attempts: resolved.attempts
        };
      },
      { expectedSelector: resolved.selector }
    );
    this.logAction(session, {
      action: "type",
      selector: resolved.selector,
      result: result.validation.success ? "success" : "validation_failed",
      retryCount,
      metadata: { query: query || "", strategy: resolved.strategy, textLength: text.length }
    });
    session.actionHistory.push({ action: "type", target: query || selector, selector: resolved.selector, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async screenshot({ sessionId, fileName }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");

    await fs.mkdir(config.screenshotDir, { recursive: true });
    const safeName = fileName || `screenshot-${Date.now()}.png`;
    const absolutePath = path.resolve(config.screenshotDir, safeName);
    await session.page.screenshot({ path: absolutePath, fullPage: true });
    const metadata = {
      sessionId: session.id,
      action: "manual-screenshot",
      path: absolutePath,
      url: session.page.url(),
      timestamp: new Date().toISOString()
    };
    session.screenshotHistory.push(metadata);
    this.logAction(session, { action: "screenshot", selector: "", result: "success", retryCount: 0, metadata });
    return { sessionId: session.id, path: absolutePath, metadata };
  }

  async analyze({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const summary = await this.analyzePageState(session);
    this.logAction(session, { action: "analyze", result: "success", retryCount: 0, metadata: { url: summary.url } });
    return { sessionId: session.id, ...summary };
  }

  async scroll({ sessionId, pixels = 600 }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const result = await this.executeActionWithValidation(
      session,
      "scroll",
      async () => {
        await session.page.mouse.wheel(0, pixels);
        return { sessionId: session.id, pixels };
      }
    );
    this.logAction(session, { action: "scroll", result: result.validation.success ? "success" : "validation_failed", retryCount: 0, metadata: { pixels } });
    session.actionHistory.push({ action: "scroll", target: String(pixels), timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async hover({ sessionId, selector, query }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    let retryCount = 0;
    const resolved = await this.resolveSelector(session, { selector, query, action: "hover" });
    const result = await this.executeActionWithValidation(
      session,
      "hover",
      async () => {
        await this.withRetry(async (attempt) => {
          retryCount = attempt - 1;
          const locator = session.page.locator(resolved.selector).first();
          await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
          await locator.hover();
        });
        return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, attempts: resolved.attempts };
      },
      { expectedSelector: resolved.selector }
    );
    this.logAction(session, { action: "hover", selector: resolved.selector, result: result.validation.success ? "success" : "validation_failed", retryCount, metadata: { query: query || "" } });
    session.actionHistory.push({ action: "hover", target: query || selector, selector: resolved.selector, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async wait({ sessionId, selector, query, text, timeoutMs }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const timeout = Number(timeoutMs || config.defaultTimeoutMs);

    const result = await this.executeActionWithValidation(
      session,
      "wait",
      async () => {
        if (text) {
          await session.page.waitForFunction(
            (needle) => document.body && document.body.innerText.toLowerCase().includes(needle.toLowerCase()),
            text,
            { timeout }
          );
          return { sessionId: session.id, mode: "text", text, timeoutMs: timeout };
        }
        if (selector || query) {
          const resolved = await this.resolveSelector(session, { selector, query, action: "wait" });
          await session.page.locator(resolved.selector).first().waitFor({ state: "visible", timeout });
          return { sessionId: session.id, mode: "selector", selector: resolved.selector, strategy: resolved.strategy, attempts: resolved.attempts, timeoutMs: timeout };
        }
        await session.page.waitForTimeout(timeout);
        return { sessionId: session.id, mode: "timeout", timeoutMs: timeout };
      }
    );
    this.logAction(session, { action: "wait", result: "success", retryCount: 0, metadata: { selector: selector || "", query: query || "", text: text || "", timeoutMs: timeout } });
    session.actionHistory.push({ action: "wait", target: selector || query || text || String(timeout), timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async select({ sessionId, selector, query, value, label, index }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (value === undefined && label === undefined && index === undefined) throw new Error("Missing selection target: value, label, or index");
    let retryCount = 0;
    const resolved = await this.resolveSelector(session, { selector, query, action: "select" });
    const option = value !== undefined ? { value: String(value) } : label !== undefined ? { label: String(label) } : { index: Number(index) };
    const result = await this.executeActionWithValidation(
      session,
      "select",
      async () => {
        await this.withRetry(async (attempt) => {
          retryCount = attempt - 1;
          const locator = session.page.locator(resolved.selector).first();
          await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
          await locator.selectOption(option);
        });
        return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, option, attempts: resolved.attempts };
      },
      { expectedSelector: resolved.selector }
    );
    this.logAction(session, { action: "select", selector: resolved.selector, result: result.validation.success ? "success" : "validation_failed", retryCount, metadata: { option } });
    session.actionHistory.push({ action: "select", target: query || selector, selector: resolved.selector, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
  }

  async upload({ sessionId, selector, query, filePath }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (!filePath) throw new Error("Missing required field: filePath");
    let retryCount = 0;
    const resolved = await this.resolveSelector(session, { selector, query, action: "upload" });
    const absoluteFilePath = path.resolve(filePath);
    const result = await this.executeActionWithValidation(
      session,
      "upload",
      async () => {
        await this.withRetry(async (attempt) => {
          retryCount = attempt - 1;
          const locator = session.page.locator(resolved.selector).first();
          await locator.waitFor({ state: "visible", timeout: config.defaultTimeoutMs });
          await locator.setInputFiles(absoluteFilePath);
        });
        return { sessionId: session.id, selector: resolved.selector, strategy: resolved.strategy, filePath: absoluteFilePath, attempts: resolved.attempts };
      },
      { expectedSelector: resolved.selector }
    );
    this.logAction(session, { action: "upload", selector: resolved.selector, result: result.validation.success ? "success" : "validation_failed", retryCount, metadata: { filePath: absoluteFilePath } });
    session.actionHistory.push({ action: "upload", target: query || selector, selector: resolved.selector, timestamp: new Date().toISOString(), validation: result.validation });
    return result;
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
    const execution = [];

    for (const step of plan) {
      const analyzed = await this.analyzePageState(session);
      try {
        const actionResult = await this.runPlannedAction(session, step);
        execution.push({
          step,
          analyze: { url: analyzed.url, counts: analyzed.counts },
          status: "success",
          result: actionResult
        });
      } catch (error) {
        execution.push({
          step,
          analyze: { url: analyzed.url, counts: analyzed.counts },
          status: "error",
          error: error.message
        });
        break;
      }
    }

    this.logAction(session, { action: "planner.execute", result: "success", retryCount: 0, metadata: { goal, stepCount: plan.length } });
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

    this.logAction(session, { action: "flow.execute", result: "success", retryCount: 0, metadata: { template, stepCount: flow.length } });
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
      logs: session.logs,
      screenshotHistory: session.screenshotHistory
    };
  }

  async closeSession({ sessionId }) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    await session.context.close();
    await session.browser.close();
    this.sessions.delete(sessionId);
    return { sessionId };
  }

  async closeAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession({ sessionId: id })));
  }
}

export const browserService = new BrowserService();
