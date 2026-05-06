import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("knowledge-base");

class KnowledgeBaseService {
  constructor() {
    this.kbDir = path.join(config.mcpDataDir, "knowledge_base");
    this._initialized = false;
    this.cache = {};
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    await fs.mkdir(this.kbDir, { recursive: true });
    this._initialized = true;
  }

  async getDomainKnowledge(url) {
    await this._ensureInitialized();
    const domain = new URL(url).origin.replace(/[^a-z0-9]/gi, "_");
    if (this.cache[domain]) return this.cache[domain];

    const filePath = path.join(this.kbDir, `${domain}.json`);
    try {
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      this.cache[domain] = data;
      return data;
    } catch {
      return null;
    }
  }

  async updateDomainKnowledge(url, knowledge) {
    await this._ensureInitialized();
    const domain = new URL(url).origin.replace(/[^a-z0-9]/gi, "_");
    const existing = await this.getDomainKnowledge(url) || {};
    
    const updated = {
      ...existing,
      ...knowledge,
      lastUpdated: new Date().toISOString()
    };

    const filePath = path.join(this.kbDir, `${domain}.json`);
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
    this.cache[domain] = updated;
    log.info(`Knowledge base updated for ${domain}`);
  }

  /**
   * High-level: Store a pattern like "Login Form Structure"
   */
  async recordPattern(url, patternType, data) {
    const knowledge = {
      patterns: {
        [patternType]: data
      }
    };
    await this.updateDomainKnowledge(url, knowledge);
  }
}

export const knowledgeBaseService = new KnowledgeBaseService();
