import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("memory-service");

class MemoryService {
  constructor() {
    this.memoryDir = path.join(config.mcpDataDir, "memory");
    this.selectorsPath = path.join(this.memoryDir, "selectors.json");
    this.patternsPath = path.join(this.memoryDir, "patterns.json");
    this.cache = {
      selectors: {},
      patterns: {}
    };
    this._initialized = false;
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    await fs.mkdir(this.memoryDir, { recursive: true });
    
    try {
      const selectorsRaw = await fs.readFile(this.selectorsPath, "utf8");
      this.cache.selectors = JSON.parse(selectorsRaw);
    } catch {
      this.cache.selectors = {};
    }

    try {
      const patternsRaw = await fs.readFile(this.patternsPath, "utf8");
      this.cache.patterns = JSON.parse(patternsRaw);
    } catch {
      this.cache.patterns = {};
    }

    this._initialized = true;
    log.info("Memory service initialized");
  }

  async getBestSelector(url, goal) {
    await this._ensureInitialized();
    const domain = new URL(url).origin;
    const key = `${domain}:${goal}`;
    const entry = this.cache.selectors[key];
    
    if (entry && entry.successCount > entry.failureCount) {
      log.info("Memory hit: found successful selector", { key, selector: entry.selector });
      return entry.selector;
    }
    return null;
  }

  async recordResult(url, goal, selector, success, error = null) {
    await this._ensureInitialized();
    const domain = new URL(url).origin;
    const key = `${domain}:${goal}`;
    
    if (!this.cache.selectors[key]) {
      this.cache.selectors[key] = {
        selector,
        successCount: 0,
        failureCount: 0,
        lastError: null,
        updatedAt: new Date().toISOString()
      };
    }

    const entry = this.cache.selectors[key];
    if (success) {
      entry.successCount++;
    } else {
      entry.failureCount++;
      entry.lastError = error;
    }
    entry.updatedAt = new Date().toISOString();

    await this._persist();
    log.info("Memory updated", { key, success });
  }

  async getPattern(url, patternType) {
    await this._ensureInitialized();
    const domain = new URL(url).origin;
    const key = `${domain}:${patternType}`;
    return this.cache.patterns[key] || null;
  }

  async recordPattern(url, patternType, data) {
    await this._ensureInitialized();
    const domain = new URL(url).origin;
    const key = `${domain}:${patternType}`;
    this.cache.patterns[key] = {
      data,
      updatedAt: new Date().toISOString()
    };
    await this._persist();
  }

  async _persist() {
    await fs.writeFile(this.selectorsPath, JSON.stringify(this.cache.selectors, null, 2));
    await fs.writeFile(this.patternsPath, JSON.stringify(this.cache.patterns, null, 2));
  }
}

export const memoryService = new MemoryService();
