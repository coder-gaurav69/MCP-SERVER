import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");

/**
 * Isolated AI workspace for agent-generated tests, scripts, drafts, and artifacts.
 * Files are stored below the configured scratchpad directory and never in project root.
 */
class ScratchpadService {
  constructor() {
    this.allowedCategories = new Set(["scripts", "tests", "pages", "artifacts", "notes", "tmp"]);
  }

  get baseDir() {
    return path.resolve(SERVER_ROOT, config.scratchpadDir || "src/.ai_outputs/ai_workspace");
  }

  sessionDir(sessionId) {
    const safe = String(sessionId || "default")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 200);
    const dir = path.resolve(this.baseDir, safe || "default");
    const rel = path.relative(this.baseDir, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid AI workspace session directory");
    }
    return dir;
  }

  safeName(filename) {
    const name = String(filename || "untitled.txt")
      .replace(/[^a-zA-Z0-9._\- ()]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 255);
    return name || "untitled.txt";
  }

  safeCategory(category) {
    const safe = String(category || "tmp")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80);
    return this.allowedCategories.has(safe) ? safe : "tmp";
  }

  filePath(sessionId, filename, category = "tmp") {
    const safeCategory = this.safeCategory(category);
    const dir = path.resolve(this.sessionDir(sessionId), safeCategory);
    const safeName = this.safeName(filename);
    const filePath = path.resolve(dir, safeName);
    const rel = path.relative(dir, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid filename - path traversal detected");
    }
    return { dir, filePath, safeName, category: safeCategory };
  }

  async ensureSessionWorkspace(sessionId) {
    const sessionRoot = this.sessionDir(sessionId);
    await fs.mkdir(sessionRoot, { recursive: true });
    const categories = Array.from(this.allowedCategories).sort();
    for (const category of categories) {
      await fs.mkdir(path.resolve(sessionRoot, category), { recursive: true });
    }
    return { sessionId, directory: sessionRoot, categories };
  }

  async writeFile(sessionId, filename, content, category = "tmp") {
    const { dir, filePath, safeName, category: safeCategory } = this.filePath(sessionId, filename, category);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, String(content), "utf-8");
    return {
      path: filePath,
      filename: safeName,
      category: safeCategory,
      size: Buffer.byteLength(String(content), "utf-8"),
      sessionId
    };
  }

  async readFile(sessionId, filename, category = "tmp") {
    const { filePath, safeName, category: safeCategory } = this.filePath(sessionId, filename, category);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const stat = await fs.stat(filePath);
      return {
        path: filePath,
        filename: safeName,
        category: safeCategory,
        content,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sessionId
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`AI workspace file not found: ${safeCategory}/${safeName}`);
      }
      throw err;
    }
  }

  async listFiles(sessionId, category = null) {
    await this.ensureSessionWorkspace(sessionId);
    const categories = category ? [this.safeCategory(category)] : Array.from(this.allowedCategories).sort();
    const files = [];

    for (const currentCategory of categories) {
      const dir = path.resolve(this.sessionDir(sessionId), currentCategory);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err) => {
        if (err.code === "ENOENT") return [];
        throw err;
      });

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.resolve(dir, entry.name);
        const stat = await fs.stat(filePath);
        files.push({
          filename: entry.name,
          category: currentCategory,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        });
      }
    }

    files.sort((a, b) => `${a.category}/${a.filename}`.localeCompare(`${b.category}/${b.filename}`));
    return { sessionId, directory: this.sessionDir(sessionId), files, count: files.length };
  }

  async deleteFile(sessionId, filename, category = "tmp") {
    const { filePath, safeName, category: safeCategory } = this.filePath(sessionId, filename, category);
    try {
      await fs.unlink(filePath);
      return { deleted: true, filename: safeName, category: safeCategory, sessionId };
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`AI workspace file not found: ${safeCategory}/${safeName}`);
      }
      throw err;
    }
  }

  async clearSession(sessionId) {
    const dir = this.sessionDir(sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return { cleared: true, sessionId, directory: dir };
    } catch {
      return { cleared: true, sessionId, directory: dir };
    }
  }

  getPreviewUrl(sessionId, filename, category = "pages") {
    const safeName = this.safeName(filename);
    const safeCategory = this.safeCategory(category);
    const safeSession = String(sessionId || "default")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
    const port = config.port || 1000;
    return `http://127.0.0.1:${port}/scratchpad/${safeSession}/${safeCategory}/${encodeURIComponent(safeName)}`;
  }
}

export const scratchpadService = new ScratchpadService();
