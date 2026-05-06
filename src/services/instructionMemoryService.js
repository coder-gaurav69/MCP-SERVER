import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("instruction-memory");

class InstructionMemoryService {
  constructor() {
    this.memoryFile = path.join(config.mcpDataDir, "user_preferences.json");
    this.memory = null;
  }

  async _load() {
    if (this.memory) return;
    try {
      const data = await fs.readFile(this.memoryFile, "utf8");
      this.memory = JSON.parse(data);
    } catch {
      this.memory = { preferences: {}, history: [] };
    }
  }

  async getPreference(key) {
    await this._load();
    return this.memory.preferences[key];
  }

  async setPreference(key, value) {
    await this._load();
    this.memory.preferences[key] = value;
    await this._save();
    log.info(`Preference updated: ${key}`);
  }

  async addInstruction(instruction) {
    await this._load();
    this.memory.history.push({
      text: instruction,
      timestamp: new Date().toISOString()
    });
    await this._save();
  }

  async getAllPreferences() {
    await this._load();
    return this.memory.preferences;
  }

  async _save() {
    await fs.writeFile(this.memoryFile, JSON.stringify(this.memory, null, 2));
  }
}

export const instructionMemoryService = new InstructionMemoryService();
