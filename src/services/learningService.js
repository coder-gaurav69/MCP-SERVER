import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("learning-service");

class LearningService {
  constructor() {
    this.logsDir = path.join(config.mcpDataDir, "logs", "learning");
    this._initialized = false;
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    await fs.mkdir(this.logsDir, { recursive: true });
    this._initialized = true;
  }

  async logFailure(url, action, params, error) {
    await this._ensureInitialized();
    const entry = {
      timestamp: new Date().toISOString(),
      url,
      action,
      params,
      error: typeof error === "string" ? error : error.message,
      context: "failure_analysis"
    };

    const fileName = `failure-${Date.now()}.json`;
    await fs.writeFile(path.join(this.logsDir, fileName), JSON.stringify(entry, null, 2));
    
    log.warn("Action failed, recorded for learning", { action, url });
  }

  async getFailureRate(url, action) {
    await this._ensureInitialized();
    try {
      const files = await fs.readdir(this.logsDir);
      const recentLogs = await Promise.all(
        files.slice(-50).map(async f => JSON.parse(await fs.readFile(path.join(this.logsDir, f), "utf8")))
      );
      
      const domain = new URL(url).origin;
      const matching = recentLogs.filter(l => l.action === action && new URL(l.url).origin === domain);
      
      if (matching.length === 0) return 0;
      return matching.length / 50; 
    } catch (err) {
      log.error("Failed to calculate failure rate", err);
      return 0;
    }
  }

  /** Suggest if a strategy should be avoided based on history */
  async shouldAvoidStrategy(url, action, strategy) {
    await this._ensureInitialized();
    try {
      const files = await fs.readdir(this.logsDir);
      const recentLogs = await Promise.all(
        files.slice(-100).map(async f => JSON.parse(await fs.readFile(path.join(this.logsDir, f), "utf8")))
      );
      
      const domain = new URL(url).origin;
      const failures = recentLogs.filter(l => 
        l.action === action && 
        new URL(l.url).origin === domain && 
        l.params?.strategy === strategy
      );
      
      return failures.length > 3; 
    } catch {
      return false;
    }
  }
}

export const learningService = new LearningService();
