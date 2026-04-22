/**
 * AI Decision Service — Converts natural language goals into executable automation steps.
 * Uses Gemini API (already configured in the project) for:
 *   1. NL → automation step sequences
 *   2. Selector suggestion from DOM context
 *   3. Action fallback when primary approach fails
 */
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("ai-decision");

class AiDecisionService {
  constructor() {
    this._apiUrl = null;
  }

  get apiUrl() {
    if (!this._apiUrl) {
      const model = config.visionModel || "gemini-2.0-flash";
      this._apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    }
    return this._apiUrl;
  }

  isAvailable() {
    return !!config.geminiApiKey;
  }

  _ensureAvailable() {
    if (!config.geminiApiKey) {
      throw new Error("AI Decision Service requires GEMINI_API_KEY. Get one free at https://aistudio.google.com");
    }
  }

  /** Send a text prompt to Gemini and get a response. */
  async _prompt(text, { temperature = 0.1, maxTokens = 2048 } = {}) {
    this._ensureAvailable();

    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature
      }
    };

    const url = `${this.apiUrl}?key=${config.geminiApiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const rawText = (result?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "").join("\n").trim();
    return rawText;
  }

  /** Parse JSON from AI response, stripping markdown fences. */
  _parseJson(text) {
    const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned);
  }

  /**
   * Convert a natural language goal into a sequence of browser_* tool calls.
   * @param {string} goal - e.g. "login to the website with email test@test.com and password 123"
   * @param {object} context - { url, pageTitle, interactiveElements[] }
   * @returns {{ steps: Array<{tool: string, params: object}>, reasoning: string }}
   */
  async planFromGoal(goal, context = {}) {
    this._ensureAvailable();
    log.info("Planning from goal", { goal });

    const contextStr = context.interactiveElements
      ? `\nPage: "${context.pageTitle || 'unknown'}" at ${context.url || 'unknown'}\nVisible elements:\n${JSON.stringify(context.interactiveElements?.slice(0, 30), null, 2)}`
      : "";

    const prompt = `You are a browser automation expert. Convert this natural language goal into a sequence of browser automation tool calls.

GOAL: "${goal}"
${contextStr}

Available tools:
- browser_open: { url: string } — Navigate to URL
- browser_click: { sessionId: string, selector?: string, query?: string } — Click element
- browser_type: { sessionId: string, selector?: string, query?: string, text: string } — Type text
- browser_fill_form: { sessionId: string, fields: { "field query": "value", ... } } — Fill form (PREFERRED for multiple fields)
- browser_select: { sessionId: string, query: string, label: string } — Select dropdown option
- browser_scroll: { sessionId: string, pixels: number } — Scroll page
- browser_wait: { sessionId: string, text?: string, timeoutMs?: number } — Wait for element/text
- browser_press_key: { sessionId: string, key: string } — Press keyboard key
- browser_screenshot: { sessionId: string } — Take screenshot to verify

Rules:
1. Use browser_fill_form when filling multiple fields (NOT repeated browser_type calls)
2. Always end with browser_screenshot to verify the result
3. Use natural language queries for selectors (e.g. "email field", "login button")
4. Extract any credentials/values from the goal text

Respond in JSON only:
{
  "steps": [
    { "tool": "browser_fill_form", "params": { "sessionId": "auto", "fields": { "email field": "test@test.com" } } }
  ],
  "reasoning": "Brief explanation of the plan"
}`;

    try {
      const raw = await this._prompt(prompt);
      const parsed = this._parseJson(raw);
      log.info("Plan generated", { stepCount: parsed.steps?.length });
      return parsed;
    } catch (err) {
      log.error("planFromGoal failed", { goal, error: err.message });
      throw new Error(`AI planning failed: ${err.message}`);
    }
  }

  /**
   * Suggest the best CSS selector for an element described in natural language.
   * Uses DOM context to find the most stable selector.
   * @param {string} description - e.g. "the blue login button"
   * @param {Array} elements - Interactive elements from browser_analyze
   * @returns {{ selector: string, confidence: number, reasoning: string }}
   */
  async suggestSelector(description, elements) {
    this._ensureAvailable();
    log.info("Suggesting selector", { description });

    const prompt = `You are a CSS selector expert for browser automation. Find the best, most stable selector for this element.

TARGET: "${description}"

Available interactive elements on the page:
${JSON.stringify(elements.slice(0, 50), null, 2)}

Respond in JSON only:
{
  "selector": "the CSS selector string",
  "confidence": 0.0-1.0,
  "reasoning": "why this selector is the best match",
  "alternatives": ["backup selector 1", "backup selector 2"]
}

Rules:
1. Prefer id-based selectors (#id) — most stable
2. Then data-testid or name attributes
3. Then aria-label
4. Avoid class-based selectors if possible (fragile)
5. Use the element list to find exact matches`;

    try {
      const raw = await this._prompt(prompt);
      const parsed = this._parseJson(raw);
      return parsed;
    } catch (err) {
      log.error("suggestSelector failed", { description, error: err.message });
      return { selector: null, confidence: 0, reasoning: `AI suggestion failed: ${err.message}`, alternatives: [] };
    }
  }

  /**
   * When an action fails, suggest a recovery strategy.
   * @param {string} action - The tool that failed (e.g. "browser_click")
   * @param {object} params - The params that were used
   * @param {string} error - The error message
   * @param {Array} elements - Current page elements
   * @returns {{ strategy: string, newParams: object, reasoning: string }}
   */
  async suggestRecovery(action, params, error, elements) {
    this._ensureAvailable();
    log.info("Suggesting recovery", { action, error });

    const prompt = `A browser automation action failed. Suggest a recovery strategy.

FAILED ACTION: ${action}
PARAMS: ${JSON.stringify(params)}
ERROR: ${error}

Current page elements:
${JSON.stringify(elements.slice(0, 30), null, 2)}

Respond in JSON only:
{
  "strategy": "retry_with_new_selector" | "wait_and_retry" | "scroll_and_retry" | "use_keyboard" | "skip" | "abort",
  "newParams": { ... updated params ... },
  "reasoning": "why this recovery should work",
  "preSteps": [
    { "tool": "browser_scroll", "params": { "pixels": 300 } }
  ]
}`;

    try {
      const raw = await this._prompt(prompt);
      return this._parseJson(raw);
    } catch (err) {
      log.error("suggestRecovery failed", { error: err.message });
      return { strategy: "skip", newParams: params, reasoning: `AI recovery failed: ${err.message}`, preSteps: [] };
    }
  }

  /**
   * Analyze page elements and add semantic labels.
   * Enhances browser_analyze output with human-readable descriptions.
   * @param {Array} elements - Raw interactive elements
   * @param {string} pageTitle
   * @returns {Array} Enhanced elements with semanticLabel
   */
  async enhanceElementLabels(elements, pageTitle = "") {
    if (!this.isAvailable() || elements.length === 0) return elements;

    const prompt = `You are a UI analysis expert. Add a human-readable semantic label to each interactive element.

Page: "${pageTitle}"
Elements (first 30):
${JSON.stringify(elements.slice(0, 30), null, 2)}

Respond in JSON only — an array of objects, one per input element, in the same order:
[
  { "index": 0, "semanticLabel": "Login email input", "purpose": "User enters their email address" },
  ...
]

Rules:
1. Keep labels short (2-5 words)
2. Describe PURPOSE not appearance
3. Use common UI patterns (login, search, nav, etc.)`;

    try {
      const raw = await this._prompt(prompt, { maxTokens: 3000 });
      const labels = this._parseJson(raw);

      // Merge labels back into elements
      const enhanced = elements.map((el, i) => {
        const label = labels.find(l => l.index === i);
        return {
          ...el,
          semanticLabel: label?.semanticLabel || el.label || el.aria || "",
          purpose: label?.purpose || ""
        };
      });

      return enhanced;
    } catch (err) {
      log.warn("enhanceElementLabels failed, returning raw elements", { error: err.message });
      return elements;
    }
  }
}

export const aiDecisionService = new AiDecisionService();
