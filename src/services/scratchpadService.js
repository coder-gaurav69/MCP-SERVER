import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");

/**
 * Scratchpad Service — Isolated workspace for AI agent testing.
 * Files are stored in .scratchpad/<sessionId>/ and never pollute the user's project.
 */
class ScratchpadService {
  get baseDir() {
    return path.resolve(SERVER_ROOT, config.scratchpadDir || ".scratchpad");
  }

  sessionDir(sessionId) {
    const safe = String(sessionId || "default")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 200);
    const dir = path.resolve(this.baseDir, safe || "default");
    // Path traversal guard
    const rel = path.relative(this.baseDir, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid scratchpad session directory");
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

  /**
   * Write/update a file in the scratchpad.
   */
  async writeFile(sessionId, filename, content) {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const safeName = this.safeName(filename);
    const filePath = path.resolve(dir, safeName);

    // Path traversal guard
    const rel = path.relative(dir, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid filename — path traversal detected");
    }

    await fs.writeFile(filePath, String(content), "utf-8");

    return {
      path: filePath,
      filename: safeName,
      size: Buffer.byteLength(content, "utf-8"),
      sessionId
    };
  }

  /**
   * Read a file from the scratchpad.
   */
  async readFile(sessionId, filename) {
    const dir = this.sessionDir(sessionId);
    const safeName = this.safeName(filename);
    const filePath = path.resolve(dir, safeName);

    const rel = path.relative(dir, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid filename — path traversal detected");
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const stat = await fs.stat(filePath);
      return {
        path: filePath,
        filename: safeName,
        content,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        sessionId
      };
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Scratchpad file not found: ${safeName}`);
      }
      throw err;
    }
  }

  /**
   * List all files in a session's scratchpad.
   */
  async listFiles(sessionId) {
    const dir = this.sessionDir(sessionId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.resolve(dir, entry.name);
        const stat = await fs.stat(filePath);
        files.push({
          filename: entry.name,
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        });
      }
      return { sessionId, directory: dir, files, count: files.length };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { sessionId, directory: dir, files: [], count: 0 };
      }
      throw err;
    }
  }

  /**
   * Delete a specific file from the scratchpad.
   */
  async deleteFile(sessionId, filename) {
    const dir = this.sessionDir(sessionId);
    const safeName = this.safeName(filename);
    const filePath = path.resolve(dir, safeName);

    const rel = path.relative(dir, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid filename");
    }

    try {
      await fs.unlink(filePath);
      return { deleted: true, filename: safeName, sessionId };
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Scratchpad file not found: ${safeName}`);
      }
      throw err;
    }
  }

  /**
   * Clear all files for a session's scratchpad.
   */
  async clearSession(sessionId) {
    const dir = this.sessionDir(sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return { cleared: true, sessionId, directory: dir };
    } catch {
      return { cleared: true, sessionId, directory: dir };
    }
  }

  /**
   * Get the HTTP URL to preview a scratchpad file (served by Express).
   */
  getPreviewUrl(sessionId, filename) {
    const safeName = this.safeName(filename);
    const safeSession = String(sessionId || "default")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 200);
    const port = config.port || 1000;
    return `http://127.0.0.1:${port}/scratchpad/${safeSession}/${encodeURIComponent(safeName)}`;
  }
}

export const scratchpadService = new ScratchpadService();
