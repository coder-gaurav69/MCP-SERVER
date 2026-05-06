import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("replay-service");

class ReplayService {
  constructor() {
    this.replayDir = path.join(config.mcpDataDir, "replays");
    this._initialized = false;
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    await fs.mkdir(this.replayDir, { recursive: true });
    this._initialized = true;
  }

  async recordSession(sessionId, goal, actions) {
    await this._ensureInitialized();
    const id = `${Date.now()}-${sessionId}`;
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId,
      goal,
      actions,
      url: actions[0]?.url // Use starting URL as anchor
    };

    const filePath = path.join(this.replayDir, `${id}.json`);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2));
    log.info("Session recorded for replay", { goal, id });
  }

  async findReplay(url, goal) {
    await this._ensureInitialized();
    try {
      const files = await fs.readdir(this.replayDir);
      for (const file of files) {
        const content = JSON.parse(await fs.readFile(path.join(this.replayDir, file), "utf8"));
        if (content.goal === goal && content.url === url) {
          log.info("Matching replay found", { goal, url });
          return content.actions;
        }
      }
    } catch { /* ignore */ }
    return null;
  }
}

export const replayService = new ReplayService();
