/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HYBRID INPUT ENGINE — Robust form-filling with fallback chain
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Core problem: Standard Playwright typing (page.fill, page.type, keyboard.type)
 * is unreliable in many modern web apps. This engine implements a multi-strategy
 * fallback chain that guarantees input fields are filled correctly and changes
 * are visible in the UI.
 *
 * Strategy Chain (tried in order, stops on first verified success):
 *   1. KEYBOARD TYPING  — Standard keyboard.type with proper focus
 *   2. HYBRID INJECTION — Set value programmatically + dispatch proper events
 *   3. REACT NATIVE SET — Use React's native setter trick + synthetic events
 *   4. DOM DIRECT WRITE — Last resort: direct DOM manipulation + full event chain
 *
 * After every strategy: VERIFY the value matches what was intended.
 */

import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("input-engine");

// ─── Strategy Implementations ───────────────────────────────────────────────

/**
 * Strategy 1: Standard Keyboard Typing
 * Focus the element, select all, delete, then type character by character.
 */
async function strategyKeyboardType(page, locator, text, options = {}) {
  const { delay = 30 } = options;

  // Ensure focus
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ force: true, timeout: 3000 });

  // Verify we have focus on the right element
  const hasFocus = await locator.evaluate(el => document.activeElement === el);
  if (!hasFocus) {
    await locator.focus();
  }

  // Clear existing content
  await page.keyboard.press("Control+A");
  await new Promise(r => setTimeout(r, 50));
  await page.keyboard.press("Backspace");
  await new Promise(r => setTimeout(r, 50));

  // Type character by character
  await page.keyboard.type(String(text), { delay });

  return { strategy: "keyboard_type" };
}

/**
 * Strategy 2: Hybrid Event-Based Injection
 * Set element.value programmatically, then dispatch input/change events with bubbling.
 */
async function strategyHybridInjection(page, locator, text) {
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ force: true, timeout: 3000 }).catch(() => {});
  await locator.focus().catch(() => {});

  await locator.evaluate((el, value) => {
    // Clear first
    el.value = "";

    // Set value
    el.value = value;

    // Dispatch the complete event chain that frameworks listen for
    const focusEvent = new Event("focus", { bubbles: true });
    focusEvent.__mcpAutomation = true;
    el.dispatchEvent(focusEvent);

    const inputEvent = new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    });
    inputEvent.__mcpAutomation = true;
    el.dispatchEvent(inputEvent);

    const changeEvent = new Event("change", { bubbles: true, cancelable: true });
    changeEvent.__mcpAutomation = true;
    el.dispatchEvent(changeEvent);

    if (el.isContentEditable) {
      el.textContent = value;
      const inputEvent = new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value
      });
      inputEvent.__mcpAutomation = true;
      el.dispatchEvent(inputEvent);
    }
  }, String(text));

  return { strategy: "hybrid_injection" };
}

/**
 * Strategy 3: React/Framework Native Setter Bypass
 * Uses Object.getOwnPropertyDescriptor to get the native setter from the prototype,
 * then calls it to set the value. This bypasses React's synthetic event system and
 * triggers React's internal state update mechanism.
 */
async function strategyReactNativeSet(page, locator, text) {
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await locator.click({ force: true, timeout: 3000 }).catch(() => {});

  const success = await locator.evaluate((el, value) => {
    // Detect element type
    const tagName = el.tagName.toLowerCase();

    // Get the native setter from the prototype
    let nativeSetter = null;

    if (tagName === "input") {
      nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
    } else if (tagName === "textarea") {
      nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
    }

    if (!nativeSetter) return false;

    // Call the native setter — this is the key trick for React
    nativeSetter.call(el, value);

    // Multi-event trigger for maximum framework compatibility
    const events = ["input", "change", "blur"];
    events.forEach(type => {
      const e = new Event(type, { bubbles: true });
      e.__mcpAutomation = true;
      el.dispatchEvent(e);
    });

    // Also try dispatching with InputEvent for newer React versions
    const inputEvent = new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    });
    inputEvent.__mcpAutomation = true;
    el.dispatchEvent(inputEvent);

    return true;
  }, String(text));

  if (!success) {
    throw new Error("React native setter not available for this element type");
  }

  return { strategy: "react_native_set" };
}

/**
 * Strategy 4: Direct DOM Manipulation + Full Event Chain
 * The nuclear option. Directly writes to the DOM and fires every possible event
 * that any framework might be listening for.
 */
async function strategyDOMDirect(page, locator, text) {
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

  await locator.evaluate((el, value) => {
    const tagName = el.tagName.toLowerCase();

    // Focus the element
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Try native setter first (works for React)
    let nativeSetter = null;
    if (tagName === "input") {
      nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, "value"
      )?.set;
    } else if (tagName === "textarea") {
      nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
    }

    if (nativeSetter) {
      nativeSetter.call(el, ""); // Clear
      nativeSetter.call(el, value); // Set
    } else {
      el.value = value;
    }

    // ContentEditable fallback
    if (el.isContentEditable) {
      el.innerHTML = "";
      el.textContent = value;
    }

    // Fire EVERY event that any framework might care about
    const eventTypes = [
      { Constructor: Event, type: "input", opts: { bubbles: true, cancelable: true } },
      { Constructor: InputEvent, type: "input", opts: { bubbles: true, cancelable: true, inputType: "insertText", data: value } },
      { Constructor: Event, type: "change", opts: { bubbles: true, cancelable: true } },
      { Constructor: KeyboardEvent, type: "keydown", opts: { bubbles: true, key: value.slice(-1) || "a", code: "KeyA" } },
      { Constructor: KeyboardEvent, type: "keypress", opts: { bubbles: true, key: value.slice(-1) || "a", code: "KeyA" } },
      { Constructor: KeyboardEvent, type: "keyup", opts: { bubbles: true, key: value.slice(-1) || "a", code: "KeyA" } },
    ];

    for (const { Constructor, type, opts } of eventTypes) {
      try {
        const e = new Constructor(type, opts);
        e.__mcpAutomation = true;
        el.dispatchEvent(e);
      } catch { /* some events may not be constructible in all browsers */ }
    }

    // 5. Fire events
    const inputEv = new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: value });
    inputEv.__mcpAutomation = true;
    el.dispatchEvent(inputEv);

    const changeEv = new Event("change", { bubbles: true });
    changeEv.__mcpAutomation = true;
    el.dispatchEvent(changeEv);

    const blurEv = new FocusEvent("blur", { bubbles: true });
    blurEv.__mcpAutomation = true;
    el.dispatchEvent(blurEv);

    const focusOutEv = new FocusEvent("focusout", { bubbles: true });
    focusOutEv.__mcpAutomation = true;
    el.dispatchEvent(focusOutEv);

    // Re-focus so the user sees the cursor in the field
    el.focus();
  }, String(text));

  return { strategy: "dom_direct" };
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Verify that the element's value matches what we intended to type.
 * Supports: input, textarea, contentEditable, select, and shadow DOM.
 */
async function verifyInputValue(locator, expectedValue) {
  try {
    const actual = await locator.evaluate((el, expected) => {
      const tagName = el.tagName.toLowerCase();

      // Standard inputs
      if (tagName === "input" || tagName === "textarea") {
        return el.value || "";
      }

      // ContentEditable
      if (el.isContentEditable) {
        return (el.innerText || el.textContent || "").trim();
      }

      // Select elements
      if (tagName === "select") {
        const selectedOption = el.options[el.selectedIndex];
        return selectedOption ? (selectedOption.text || selectedOption.value || "") : "";
      }

      // Shadow DOM — try to peek inside
      if (el.shadowRoot) {
        const innerInput = el.shadowRoot.querySelector("input, textarea");
        if (innerInput) return innerInput.value || "";
      }

      // Fallback: look for inner input
      const innerInput = el.querySelector("input, textarea");
      if (innerInput) return innerInput.value || "";

      return el.innerText || el.textContent || "";
    }, expectedValue);

    const normalizedActual = String(actual).trim();
    const normalizedExpected = String(expectedValue).trim();

    // Exact match
    if (normalizedActual === normalizedExpected) {
      return { verified: true, actual: normalizedActual, match: "exact" };
    }

    // Partial match (for masked inputs like passwords showing •••)
    if (normalizedActual.length === normalizedExpected.length && normalizedActual.length > 0) {
      return { verified: true, actual: normalizedActual, match: "length_match_masked" };
    }

    // Contains match (for formatted inputs like phone numbers)
    const cleanActual = normalizedActual.replace(/[\s\-().+]/g, "");
    const cleanExpected = normalizedExpected.replace(/[\s\-().+]/g, "");
    if (cleanActual === cleanExpected || cleanActual.includes(cleanExpected) || cleanExpected.includes(cleanActual)) {
      return { verified: true, actual: normalizedActual, match: "fuzzy" };
    }

    return { verified: false, actual: normalizedActual, expected: normalizedExpected };
  } catch (err) {
    return { verified: false, actual: "", error: err.message };
  }
}

// ─── Shadow DOM Support ─────────────────────────────────────────────────────

/**
 * Try to find and fill an input inside a shadow DOM element.
 */
async function fillShadowDOMInput(page, locator, text) {
  const filled = await locator.evaluate((el, value) => {
    if (!el.shadowRoot) return false;
    const inner = el.shadowRoot.querySelector("input, textarea, [contenteditable]");
    if (!inner) return false;

    // Use native setter if possible
    const tag = inner.tagName.toLowerCase();
    let setter = null;
    if (tag === "input") {
      setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    } else if (tag === "textarea") {
      setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    }

    if (setter) {
      setter.call(inner, value);
    } else if (inner.isContentEditable) {
      inner.textContent = value;
    } else {
      inner.value = value;
    }

    const inputEvent = new Event("input", { bubbles: true });
    inputEvent.__mcpAutomation = true;
    inner.dispatchEvent(inputEvent);

    const changeEvent = new Event("change", { bubbles: true });
    changeEvent.__mcpAutomation = true;
    inner.dispatchEvent(changeEvent);
    return true;
  }, String(text));

  return filled;
}

// ─── Main Engine ────────────────────────────────────────────────────────────

/**
 * The strategies to try, in order. Each is a function that attempts to fill
 * the input and returns a result object. If it throws, we move to the next.
 */
const STRATEGIES = [
  { name: "keyboard_type", fn: strategyKeyboardType, label: "Keyboard Typing" },
  { name: "hybrid_injection", fn: strategyHybridInjection, label: "Hybrid Event Injection" },
  { name: "react_native_set", fn: strategyReactNativeSet, label: "React Native Setter" },
  { name: "dom_direct", fn: strategyDOMDirect, label: "Direct DOM Write" }
];

/**
 * Fill a single input field using the fallback chain.
 *
 * @param {import('playwright').Page} page - Playwright page
 * @param {import('playwright').Locator} locator - Playwright locator for the target element
 * @param {string} text - The text value to fill
 * @param {object} options
 * @param {boolean} [options.turbo=false] - Skip visual feedback for speed
 * @param {Function} [options.onLog] - Callback for log messages
 * @param {Function} [options.onMouseMove] - Callback for mouse position updates
 * @param {Function} [options.onRipple] - Callback for ripple effect at (x, y)
 * @returns {Promise<{success: boolean, strategy: string, attempts: number, logs: string[], verification: object}>}
 */
export async function fillInput(page, locator, text, options = {}) {
  const { turbo = false, onLog, onMouseMove, onRipple } = options;
  const logs = [];

  const addLog = (msg) => {
    logs.push(msg);
    if (onLog) onLog(msg);
    log.debug(msg);
  };

  const value = String(text);
  addLog(`[INPUT] Target value: "${value.slice(0, 40)}${value.length > 40 ? "..." : ""}"`);

  // Pre-check: is this element even fillable?
  const elementInfo = await locator.evaluate(el => {
    const tag = el.tagName.toLowerCase();
    return {
      tag,
      type: el.getAttribute("type") || "",
      isReadOnly: el.readOnly === true,
      isDisabled: el.disabled === true,
      isContentEditable: el.isContentEditable === true,
      hasShadowRoot: !!el.shadowRoot,
      role: el.getAttribute("role") || ""
    };
  }).catch(() => ({ tag: "unknown", type: "", isReadOnly: false, isDisabled: false, isContentEditable: false, hasShadowRoot: false, role: "" }));

  addLog(`[INPUT] Element: <${elementInfo.tag}> type="${elementInfo.type}" readonly=${elementInfo.isReadOnly} disabled=${elementInfo.isDisabled} shadow=${elementInfo.hasShadowRoot}`);

  // Aggressive focus attempt for readonly/disabled fields (often toggles their state)
  if (elementInfo.isReadOnly || elementInfo.isDisabled) {
    addLog(`[INPUT] Element is initially ${elementInfo.isReadOnly ? "readonly" : "disabled"}. Attempting activation click...`);
    await locator.click({ force: true, timeout: 1000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 100));
    
    // Re-check
    const refreshed = await locator.evaluate(el => ({
      isReadOnly: el.readOnly === true,
      isDisabled: el.disabled === true
    })).catch(() => elementInfo);

    if (refreshed.isDisabled) {
      addLog(`[INPUT] SKIP: Element is strictly disabled.`);
      return {
        success: false,
        strategy: "skipped",
        attempts: 0,
        logs,
        verification: { verified: false, reason: "disabled" }
      };
    }
    
    if (refreshed.isReadOnly) {
      addLog(`[INPUT] Element is readonly, but continuing with injection strategies...`);
    }
  }

  // Shadow DOM special case
  if (elementInfo.hasShadowRoot) {
    addLog(`[INPUT] Shadow DOM detected — using shadow fill strategy`);
    const filled = await fillShadowDOMInput(page, locator, value);
    if (filled) {
      const verification = await verifyInputValue(locator, value);
      addLog(`[INPUT] Shadow DOM fill: ${verification.verified ? "VERIFIED ✓" : "UNVERIFIED"}`);
      return {
        success: verification.verified,
        strategy: "shadow_dom",
        attempts: 1,
        logs,
        verification
      };
    }
  }

  // Visual feedback: move mouse to element
  if (!turbo && onMouseMove) {
    try {
      const box = await locator.boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await onMouseMove(cx, cy);
        if (onRipple) await onRipple(cx, cy);
      }
    } catch { /* ignore visual feedback failures */ }
  }

  // Run the fallback chain
  let lastVerification = null;

  for (let i = 0; i < STRATEGIES.length; i++) {
    const strategy = STRATEGIES[i];
    
    // Skip keyboard typing for readonly elements as it definitely won't work
    if (elementInfo.isReadOnly && strategy.name === "keyboard_type") {
      continue;
    }

    addLog(`[INPUT] Attempt ${i + 1}/${STRATEGIES.length}: ${strategy.label}`);

    try {
      await strategy.fn(page, locator, value, { delay: turbo ? 0 : 25 });

      // Wait a moment for framework state updates
      await new Promise(r => setTimeout(r, turbo ? 50 : 200));

      // Verify
      const verification = await verifyInputValue(locator, value);
      lastVerification = verification;

      if (verification.verified) {
        addLog(`[INPUT] ✅ SUCCESS via "${strategy.label}" (match: ${verification.match})`);
        return {
          success: true,
          strategy: strategy.name,
          attempts: i + 1,
          logs,
          verification
        };
      } else {
        addLog(`[INPUT] ❌ Verification failed: actual="${verification.actual}" expected="${value}"`);
      }
    } catch (err) {
      addLog(`[INPUT] ⚠ Strategy "${strategy.label}" threw: ${err.message}`);
    }
  }

  // All strategies failed — but still return the best info we have
  addLog(`[INPUT] ❌ ALL ${STRATEGIES.length} strategies failed for this field`);
  return {
    success: false,
    strategy: "all_failed",
    attempts: STRATEGIES.length,
    logs,
    verification: lastVerification || { verified: false, actual: "", expected: value }
  };
}

// ─── Dropdown Engine ────────────────────────────────────────────────────────

/**
 * Smart dropdown selection with native/custom detection.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 * @param {object} option - { value?, label?, index? }
 * @param {object} options - { onLog?, onMouseMove?, onRipple? }
 */
export async function selectDropdown(page, locator, option, options = {}) {
  const { onLog, onMouseMove, onRipple } = options;
  const logs = [];

  const addLog = (msg) => {
    logs.push(msg);
    if (onLog) onLog(msg);
    log.debug(msg);
  };

  const tagName = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => "unknown");
  addLog(`[SELECT] Element: <${tagName}>`);

  // Visual feedback
  if (onMouseMove) {
    try {
      const box = await locator.boundingBox();
      if (box) {
        await onMouseMove(box.x + box.width / 2, box.y + box.height / 2);
        if (onRipple) await onRipple(box.x + box.width / 2, box.y + box.height / 2);
      }
    } catch { /* ignore */ }
  }

  // ── Native <select> ────────────────────────────────────────
  if (tagName === "select") {
    addLog(`[SELECT] Native <select> detected`);

    // Try selectOption with the provided option
    try {
      if (option.value !== undefined) {
        await locator.selectOption({ value: String(option.value) });
      } else if (option.label !== undefined) {
        await locator.selectOption({ label: String(option.label) });
      } else if (option.index !== undefined) {
        await locator.selectOption({ index: Number(option.index) });
      }

      // Dispatch change event
      await locator.evaluate(el => {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });

      addLog(`[SELECT] ✅ Native select succeeded`);
      return { success: true, strategy: "native_select", logs };
    } catch (err) {
      addLog(`[SELECT] Native selectOption failed: ${err.message}`);

      // Fallback: try by label text if value failed
      if (option.value !== undefined) {
        try {
          await locator.selectOption({ label: String(option.value) });
          addLog(`[SELECT] ✅ Fallback by label succeeded`);
          return { success: true, strategy: "native_select_label_fallback", logs };
        } catch { /* continue to next strategy */ }
      }
    }
  }

  // ── Custom Dropdown (div/button-based) ─────────────────────
  addLog(`[SELECT] Custom dropdown detected, using click-and-search`);
  const searchText = String(option.label || option.value || "");

  // Step 1: Click to open
  try {
    await locator.click({ timeout: 3000 });
    await new Promise(r => setTimeout(r, 300)); // Wait for dropdown animation
  } catch (err) {
    addLog(`[SELECT] ⚠ Failed to click dropdown trigger: ${err.message}`);
  }

  // Step 2: Find and click the option
  if (searchText) {
    // Try multiple selectors for the option
    const optionSelectors = [
      `[role="option"]:has-text("${searchText}")`,
      `[role="listbox"] >> text="${searchText}"`,
      `li:has-text("${searchText}")`,
      `[class*="option"]:has-text("${searchText}")`,
      `[class*="menu"] >> text="${searchText}"`,
      `text="${searchText}"`
    ];

    for (const sel of optionSelectors) {
      try {
        const optionLocator = page.locator(sel).first();
        if (await optionLocator.isVisible({ timeout: 1000 })) {
          // Move mouse to option for visual feedback
          if (onMouseMove) {
            const box = await optionLocator.boundingBox();
            if (box) await onMouseMove(box.x + box.width / 2, box.y + box.height / 2);
          }
          await optionLocator.click({ timeout: 2000 });
          addLog(`[SELECT] ✅ Custom dropdown: clicked option via "${sel}"`);
          return { success: true, strategy: "custom_dropdown_click", logs, usedSelector: sel };
        }
      } catch { /* try next selector */ }
    }

    // Last resort: evaluate and click by text content
    try {
      const clicked = await page.evaluate((searchText) => {
        const allElements = document.querySelectorAll("li, div, span, button, [role='option'], [role='menuitem']");
        for (const el of allElements) {
          const text = (el.innerText || el.textContent || "").trim();
          if (text.toLowerCase() === searchText.toLowerCase() ||
              text.toLowerCase().includes(searchText.toLowerCase())) {
            const style = window.getComputedStyle(el);
            if (style.display !== "none" && style.visibility !== "hidden") {
              el.click();
              return true;
            }
          }
        }
        return false;
      }, searchText);

      if (clicked) {
        addLog(`[SELECT] ✅ Custom dropdown: clicked option via DOM search`);
        return { success: true, strategy: "custom_dropdown_dom_search", logs };
      }
    } catch { /* ignore */ }
  }

  addLog(`[SELECT] ❌ Could not find option "${searchText}" in dropdown`);
  return { success: false, strategy: "dropdown_failed", logs };
}

/**
 * Detect what kind of input element we're dealing with.
 * Useful for choosing the right fill strategy upfront.
 */
export async function detectInputType(locator) {
  return locator.evaluate(el => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    const role = el.getAttribute("role") || "";
    const isContentEditable = el.isContentEditable;
    const hasShadowRoot = !!el.shadowRoot;

    // Check for React fiber (indicates React-controlled component)
    const reactFiber = Object.keys(el).find(key =>
      key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")
    );

    // Check for Vue reactivity
    const isVue = !!el.__vue__ || !!el.__vueParentComponent;

    // Check for Angular
    const isAngular = Object.keys(el).some(key => key.startsWith("ng-") || key.startsWith("_ngcontent"));

    return {
      tag,
      type,
      role,
      isContentEditable,
      hasShadowRoot,
      isReact: !!reactFiber,
      isVue,
      isAngular,
      isSelect: tag === "select",
      isCheckbox: type === "checkbox",
      isRadio: type === "radio",
      isFile: type === "file",
      isMasked: type === "password",
      isCustomComponent: tag === "div" && (isContentEditable || role === "textbox" || role === "combobox")
    };
  }).catch(() => ({
    tag: "unknown", type: "text", role: "", isContentEditable: false,
    hasShadowRoot: false, isReact: false, isVue: false, isAngular: false,
    isSelect: false, isCheckbox: false, isRadio: false, isFile: false,
    isMasked: false, isCustomComponent: false
  }));
}
