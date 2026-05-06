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

  /** Send a text prompt to Gemini and get a response with retry logic for 429s. */
  async _prompt(text, { temperature = 0.1, maxTokens = 2048, retries = 3 } = {}) {
    this._ensureAvailable();

    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature
      }
    };

    const url = `${this.apiUrl}?key=${config.geminiApiKey}`;
    
    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });

        if (response.status === 429) {
          const waitSec = Math.pow(2, i) * 10;
          log.warn(`Rate limited (429). Retrying in ${waitSec}s...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const result = await response.json();
        const rawText = (result?.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || "").join("\n").trim();
        return rawText;
      } catch (err) {
        if (i === retries - 1) throw err;
        log.warn(`Prompt attempt ${i + 1} failed: ${err.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
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

    const prompt = `You are a browser automation expert. Convert this natural language goal into a DIRECTED ACYCLIC GRAPH (DAG) of automation tasks.
    
GOAL: "${goal}"
${contextStr}

Available tools:
- browser_open: { url: string }
- browser_click: { selector?: string, query?: string }
- browser_type: { selector?: string, query?: string, text: string }
- browser_fill_form: { fields: { "field query": "value", ... } }
- browser_select: { query: string, label: string }
- browser_scroll: { pixels: number }
- browser_wait: { text?: string, timeoutMs?: number }
- browser_press_key: { key: string }
- browser_screenshot: {}

Rules:
1. Return a list of tasks with unique IDs.
2. Specify "dependencies" for each task (IDs that must finish before this task).
3. Independent tasks (e.g., filling different form fields) should have NO dependencies on each other so they can run in parallel.
4. Use browser_fill_form for multiple fields.
5. Always end with a screenshot verification task.

Respond in JSON only:
{
  "reasoning": "Brief explanation",
  "tasks": [
    { "id": "t1", "tool": "browser_open", "params": { "url": "..." }, "dependencies": [] },
    { "id": "t2", "tool": "browser_fill_form", "params": { "fields": { "email": "..." } }, "dependencies": ["t1"] }
  ]
}`;

    try {
      const raw = await this._prompt(prompt);
      const parsed = this._parseJson(raw);
      log.info("Task graph generated", { taskCount: parsed.tasks?.length });
      
      // Post-process: ensure params is an object and add sessionId if missing
      parsed.tasks = (parsed.tasks || []).map(t => ({
        ...t,
        params: { sessionId: "auto", ...(t.params || {}) }
      }));

      return parsed;
    } catch (err) {
      log.error("planFromGoal failed", { goal, error: err.message });
      throw new Error(`AI planning failed: ${err.message}`);
    }
  }

  /**
   * Analyze a page and build a structured form plan.
   * @param {string} url
   * @param {Array} elements - From analyzePageState
   * @returns {{ fields: Array<{label: string, selector: string, value: string}> }}
   */
  async generateFormPlan(url, elements, userGoal = "") {
    this._ensureAvailable();
    log.info("Generating form plan", { url, elementCount: elements.length });

    const fields = elements
      .filter(f => ['input', 'select', 'textarea'].includes(f.tag))
      .map(f => ({
        label: f.label || f.placeholder || f.name || "unknown",
        selector: f.selector,
        tag: f.tag,
        type: f.type,
        options: f.options
      }))
      .slice(0, 40);

    const prompt = `You are a form analysis expert. Create a structured filling plan for this form based on the user's goal.

GOAL: "${userGoal || 'Fill the form completely'}"
URL: ${url}

FIELDS:
${JSON.stringify(fields, null, 2)}

Respond in JSON only:
{
  "fields": [
    { "label": "Email", "selector": "...", "value": "test@example.com", "strategy": "type" },
    ...
  ],
  "reasoning": "Brief explanation"
}

Rules:
1. Generate realistic values for each field.
2. If multiple strategies are possible, specify the best one.
3. Only include fields relevant to the goal.`;

    try {
      const raw = await this._prompt(prompt);
      return this._parseJson(raw);
    } catch (err) {
      log.error("generateFormPlan failed", { url, error: err.message });
      throw new Error(`Form planning failed: ${err.message}`);
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

  /**
   * Generate contextually appropriate data to fill a form autonomously.
   * @param {string} goal - e.g. "Fill this with fake patient data"
   * @param {Array} fields - List of fields from analyzePageState
   * @param {string} pageTitle
   * @returns {{ fields: Object, reasoning: string }}
   */
  async generateAutofillData(goal, fields, pageTitle = "") {
    this._ensureAvailable();
    log.info("Generating autofill data", { goal });

    const filteredFields = fields
      .filter(f => ['input', 'select', 'textarea'].includes(f.tag))
      .map(f => ({
        label: f.label,
        name: f.name,
        placeholder: f.placeholder,
        tag: f.tag,
        options: f.options
      }))
      .slice(0, 50);

    const prompt = `You are a data entry expert. Generate realistic, contextually appropriate data to fill this form based on the goal.

GOAL: "${goal || 'Fill the form completely with realistic test data'}"
PAGE TITLE: "${pageTitle}"

Available fields to fill:
${JSON.stringify(filteredFields, null, 2)}

Respond in JSON only:
{
  "fields": {
    "Field Label or Name": "Generated Value",
    ...
  },
  "reasoning": "Brief explanation of the generated data persona/context"
}

Rules:
1. Map values to the exact "label", "name", or "placeholder" provided in the field list.
2. For dates, use YYYY-MM-DD format.
3. For selects, choose one of the available "options" if provided.
4. For numbers (qty, rate), provide realistic small integers.
5. If the goal specifies a persona (e.g. "John Doe"), use it. Otherwise, be creative but professional.`;

    try {
      const raw = await this._prompt(prompt);
      return this._parseJson(raw);
    } catch (err) {
      log.error("generateAutofillData failed", { error: err.message });
      throw new Error(`AI data generation failed: ${err.message}`);
    }
  }
}

export const aiDecisionService = new AiDecisionService();
