/**
 * Self-Healing Selector Module.
 * When a CSS selector fails to find a visible element:
 *   1. Try DOM-based alternative selectors (heuristic)
 *   2. Use AI to suggest the best match from current DOM
 *   3. Retry the action with the healed selector
 * 
 * All healing attempts are logged for debugging.
 */
import { createServiceLogger, logAction } from "./loggerService.js";
import { aiDecisionService } from "./aiDecisionService.js";

const log = createServiceLogger("self-healing");

class SelfHealingSelector {
  constructor() {
    /** Cache of healed selectors: originalSelector → healedSelector */
    this._healingCache = new Map();
    /** Log of all healing attempts */
    this._healingLog = [];
  }

  /**
   * Attempt to heal a broken selector.
   * @param {object} page - Playwright page object
   * @param {string} originalSelector - The selector that failed
   * @param {string} query - The natural language query (if any)
   * @param {string} action - What action was being attempted
   * @returns {{ healed: boolean, selector: string, strategy: string }}
   */
  async heal(page, originalSelector, query, action) {
    const startTime = Date.now();
    log.info("Healing attempt started", { originalSelector, query, action });

    // Check cache first
    const cacheKey = `${originalSelector}:${query || ""}`;
    const cached = this._healingCache.get(cacheKey);
    if (cached) {
      try {
        const locator = page.locator(cached.selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) {
          log.info("Cache hit — healed selector still works", { selector: cached.selector });
          return { healed: true, selector: cached.selector, strategy: "cache" };
        }
      } catch { /* cache entry stale, continue */ }
      this._healingCache.delete(cacheKey);
    }

    // Strategy 1: DOM-based heuristic alternatives
    const domResult = await this._tryDomAlternatives(page, originalSelector, query, action);
    if (domResult.healed) {
      this._recordHealing(originalSelector, domResult.selector, "dom-heuristic", Date.now() - startTime);
      this._healingCache.set(cacheKey, domResult);
      return domResult;
    }

    // Strategy 2: AI-powered selector suggestion
    if (aiDecisionService.isAvailable() && query) {
      const aiResult = await this._tryAiSuggestion(page, query, action);
      if (aiResult.healed) {
        this._recordHealing(originalSelector, aiResult.selector, "ai-suggestion", Date.now() - startTime);
        this._healingCache.set(cacheKey, aiResult);
        return aiResult;
      }
    }

    log.warn("Self-healing failed — no alternative found", { originalSelector, query });
    this._recordHealing(originalSelector, null, "failed", Date.now() - startTime);
    return { healed: false, selector: originalSelector, strategy: "none" };
  }

  /** Strategy 1: Try DOM-based alternative selectors. */
  async _tryDomAlternatives(page, originalSelector, query, action) {
    const alternatives = await page.evaluate(({ originalSelector, query, action }) => {
      const results = [];
      const queryLower = (query || "").toLowerCase();

      // Helper: check element visibility
      const isVisible = (el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" &&
          style.opacity !== "0" && el.offsetWidth > 0 && el.offsetHeight > 0;
      };

      // Helper: score how well an element matches the query
      const scoreElement = (el) => {
        let score = 0;
        const text = (el.innerText || el.textContent || "").toLowerCase().trim();
        const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const name = (el.getAttribute("name") || "").toLowerCase();
        const id = (el.id || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();

        if (queryLower) {
          if (text.includes(queryLower)) score += 10;
          if (placeholder.includes(queryLower)) score += 8;
          if (ariaLabel.includes(queryLower)) score += 8;
          if (name.includes(queryLower)) score += 7;
          if (id.includes(queryLower)) score += 9;
          if (title.includes(queryLower)) score += 6;

          // Partial word matching
          const queryWords = queryLower.split(/\s+/);
          for (const word of queryWords) {
            if (word.length < 2) continue;
            if (text.includes(word)) score += 3;
            if (placeholder.includes(word)) score += 3;
            if (ariaLabel.includes(word)) score += 3;
            if (name.includes(word)) score += 2;
          }
        }

        return score;
      };

      // Build selector from element
      const buildSelector = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
        if (el.getAttribute("name")) return `[name="${el.getAttribute("name")}"]`;
        if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
        if (el.getAttribute("placeholder")) return `[placeholder="${el.getAttribute("placeholder")}"]`;

        // Fallback: tag + class
        const tag = el.tagName.toLowerCase();
        if (el.className && typeof el.className === "string") {
          const cls = el.className.trim().split(/\s+/)[0];
          if (cls) return `${tag}.${CSS.escape(cls)}`;
        }
        return null;
      };

      // Scan relevant elements
      const isInputAction = action === "type" || action === "upload" || action === "select";
      const selectors = isInputAction
        ? "input, textarea, select, [contenteditable]"
        : "button, a, input, textarea, select, [role='button'], [onclick]";

      const candidates = Array.from(document.querySelectorAll(selectors));
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const score = scoreElement(el);
        if (score > 0) {
          const selector = buildSelector(el);
          if (selector) {
            results.push({ selector, score, text: (el.innerText || "").trim().slice(0, 50) });
          }
        }
      }

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, 5);
    }, { originalSelector, query, action });

    // Try each alternative
    for (const alt of alternatives) {
      try {
        const locator = page.locator(alt.selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) {
          log.info("DOM-heuristic healed selector", { original: originalSelector, healed: alt.selector, score: alt.score });
          return { healed: true, selector: alt.selector, strategy: "dom-heuristic", score: alt.score };
        }
      } catch { /* continue */ }
    }

    return { healed: false, selector: originalSelector, strategy: "dom-heuristic" };
  }

  /** Strategy 2: Ask AI to suggest the best selector. */
  async _tryAiSuggestion(page, query, action) {
    try {
      // Get current interactive elements
      const elements = await page.evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" &&
            style.opacity !== "0" && el.offsetWidth > 0 && el.offsetHeight > 0;
        };

        return Array.from(document.querySelectorAll("button, a, input, textarea, select, [role='button'], [onclick]"))
          .filter(isVisible)
          .slice(0, 40)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            name: el.getAttribute("name") || undefined,
            text: (el.innerText || "").trim().slice(0, 50),
            placeholder: el.getAttribute("placeholder") || undefined,
            aria: el.getAttribute("aria-label") || undefined,
            type: el.getAttribute("type") || undefined,
            selector: el.id ? `#${el.id}` : el.getAttribute("name") ? `[name="${el.getAttribute("name")}"]` : undefined
          }));
      });

      const suggestion = await aiDecisionService.suggestSelector(query, elements);

      if (suggestion.selector && suggestion.confidence > 0.5) {
        const locator = page.locator(suggestion.selector).first();
        if (await locator.count() > 0 && await locator.isVisible()) {
          log.info("AI healed selector", { query, healed: suggestion.selector, confidence: suggestion.confidence });
          return { healed: true, selector: suggestion.selector, strategy: "ai-suggestion", confidence: suggestion.confidence };
        }

        // Try alternatives
        for (const alt of suggestion.alternatives || []) {
          try {
            const altLocator = page.locator(alt).first();
            if (await altLocator.count() > 0 && await altLocator.isVisible()) {
              log.info("AI alternative healed", { query, healed: alt });
              return { healed: true, selector: alt, strategy: "ai-alternative" };
            }
          } catch { /* continue */ }
        }
      }
    } catch (err) {
      log.warn("AI healing attempt failed", { query, error: err.message });
    }

    return { healed: false, selector: null, strategy: "ai-suggestion" };
  }

  /** Record healing attempt for debugging/analytics. */
  _recordHealing(original, healed, strategy, duration) {
    const entry = {
      original,
      healed,
      strategy,
      duration,
      timestamp: new Date().toISOString()
    };
    this._healingLog.push(entry);
    // Keep log bounded
    if (this._healingLog.length > 200) {
      this._healingLog = this._healingLog.slice(-100);
    }

    logAction({
      action: "self-heal",
      result: healed ? "healed" : "failed",
      metadata: entry
    });
  }

  /** Get the healing log (for debugging dashboard). */
  getHealingLog() {
    return [...this._healingLog];
  }

  /** Get healing stats. */
  getStats() {
    const total = this._healingLog.length;
    const healed = this._healingLog.filter(e => e.healed !== null && e.strategy !== "failed").length;
    const failed = total - healed;
    const byStrategy = {};
    for (const entry of this._healingLog) {
      byStrategy[entry.strategy] = (byStrategy[entry.strategy] || 0) + 1;
    }
    return { total, healed, failed, successRate: total > 0 ? (healed / total * 100).toFixed(1) + "%" : "N/A", byStrategy };
  }

  /** Clear cache (useful after page navigation). */
  clearCache() {
    this._healingCache.clear();
  }
}

export const selfHealingSelector = new SelfHealingSelector();
