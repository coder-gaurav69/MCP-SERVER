/**
 * Utilities for simulating human-like interactions in Playwright.
 * Designed to look "smart as hell" and humanoid.
 */

/**
 * Generates a random delay between min and max.
 * @param {number} min 
 * @param {number} max 
 * @returns {Promise<void>}
 */
export const randomDelay = (min = 50, max = 250) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Standard easing function for smooth movements.
 */
const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * Moves mouse naturally from current position to target (x, y) with overshoot and correction.
 * @param {Object} page - Playwright page object
 * @param {Object} from - {x, y} start position
 * @param {Object} to - {x, y} end position
 * @param {Function} onStep - Optional callback for each step
 */
export const moveMouseHumanoid = async (page, from, to, onStep = null) => {
  const distance = Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2));
  if (distance < 2) return;

  // 1. Calculate path with possible overshoot
  const shouldOvershoot = distance > 100 && Math.random() > 0.3;
  const overshootAmount = shouldOvershoot ? (Math.random() * 15 + 5) : 0;
  
  // Vector for overshoot
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const overshootTarget = {
    x: to.x + Math.cos(angle) * overshootAmount,
    y: to.y + Math.sin(angle) * overshootAmount
  };

  // Intermediate control point for curve
  const control = {
    x: (from.x + overshootTarget.x) / 2 + (Math.random() - 0.5) * distance * 0.3,
    y: (from.y + overshootTarget.y) / 2 + (Math.random() - 0.5) * distance * 0.3
  };

  const getBezier = (t, p0, p1, p2) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2;

  // Move to (overshoot) target
  const steps = Math.min(Math.max(Math.floor(distance / 8), 15), 45);
  for (let i = 1; i <= steps; i++) {
    const rawT = i / steps;
    const t = shouldOvershoot ? easeOutBack(rawT) : easeInOutCubic(rawT);
    
    const curX = getBezier(t, from.x, control.x, overshootTarget.x);
    const curY = getBezier(t, from.y, control.y, overshootTarget.y);
    
    await page.mouse.move(curX, curY);
    if (onStep) await onStep(curX, curY).catch(() => {});

    // Micro-pauses and jitter
    if (i % 7 === 0) {
      await new Promise(r => setTimeout(r, Math.random() * 15 + 5));
    }
  }

  // 2. Correction if overshot
  if (shouldOvershoot) {
    const correctionSteps = Math.floor(Math.random() * 5 + 5);
    const currentPos = overshootTarget;
    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      const curX = currentPos.x + (to.x - currentPos.x) * easeInOutCubic(t);
      const curY = currentPos.y + (to.y - currentPos.y) * easeInOutCubic(t);
      await page.mouse.move(curX, curY);
      if (onStep) await onStep(curX, curY).catch(() => {});
      await new Promise(r => setTimeout(r, Math.random() * 20 + 10));
    }
  }
};

/**
 * Simulates a human hovering over an element (slight idle movement).
 */
export const hoverHumanoid = async (page, pos, onStep = null) => {
  const points = 5;
  const radius = 3;
  for (let i = 0; i < points; i++) {
    const ox = (Math.random() - 0.5) * radius;
    const oy = (Math.random() - 0.5) * radius;
    await page.mouse.move(pos.x + ox, pos.y + oy);
    if (onStep) await onStep(pos.x + ox, pos.y + oy).catch(() => {});
    await new Promise(r => setTimeout(r, Math.random() * 100 + 50));
  }
};

/**
 * Types text with mistakes and corrections.
 */
export const typeHumanoid = async (locator, text) => {
  const keyboard = locator.page().keyboard;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Random "typo" simulation
    if (Math.random() > 0.96 && i > 0) {
      const typos = "qwertyuiopasdfghjklzxcvbnm";
      const typo = typos[Math.floor(Math.random() * typos.length)];
      await locator.pressSequentially(typo, { delay: Math.random() * 40 + 20 });
      await new Promise(r => setTimeout(r, Math.random() * 200 + 100)); // Pause after mistake
      await locator.press("Backspace");
      await new Promise(r => setTimeout(r, Math.random() * 150 + 50)); // Pause after correction
    }

    await locator.pressSequentially(char, { delay: 0 });
    
    // Variance in typing speed
    const baseDelay = Math.random() * 60 + 20;
    const pause = Math.random() > 0.92 ? Math.random() * 300 + 100 : 0;
    await new Promise(r => setTimeout(r, baseDelay + pause));
  }
};

