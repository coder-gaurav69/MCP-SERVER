import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "../..");

/**
 * ALLOWLIST: Only these files are allowed to exist in the project root.
 * Everything else is treated as clutter and will be flagged / auto-deleted.
 */
const ROOT_ALLOWLIST = new Set([
  ".env",
  ".env.example",
  ".gitignore",
  ".gitattributes",
  ".clinerules",
  ".cursorrules",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "mcp.js",
  "MCP_TOOL_GUIDE.md",
  ".ai_instructions"
]);

/**
 * ALLOWLISTED directories in root (won't be flagged).
 */
const ROOT_DIR_ALLOWLIST = new Set([
  ".cursor",
  ".vscode",
  ".git",
  ".mcp_data",
  "node_modules",
  "out",
  "src"
]);

class ProjectSyncService {
  get rootDir() {
    return SERVER_ROOT;
  }

  get managedDirs() {
    const dataBase = path.resolve(this.rootDir, process.env.MCP_DATA_DIR || "src/.ai_outputs");
    const scratchpadBase = path.resolve(this.rootDir, config.scratchpadDir || path.join(process.env.MCP_DATA_DIR || "src/.ai_outputs", "ai_workspace"));
    const mcpDataBase = path.resolve(this.rootDir, ".mcp_data");
    return [
      dataBase,
      path.resolve(this.rootDir, config.screenshotDir),
      path.resolve(this.rootDir, config.downloadsDir),
      scratchpadBase,
      path.resolve(scratchpadBase, "default"),
      path.resolve(this.rootDir, config.userDataDir),
      path.resolve(this.rootDir, config.logsDir),
      // .mcp_data structure
      mcpDataBase,
      path.resolve(mcpDataBase, "temp"),
      path.resolve(mcpDataBase, "logs"),
      path.resolve(mcpDataBase, "screenshots")
    ];
  }

  async ensureManagedDirs() {
    for (const dir of this.managedDirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Allowlist-only check: if a file is NOT in the allowlist, it's clutter.
   */
  isRootClutter(name, isDirectory) {
    if (isDirectory) {
      return !ROOT_DIR_ALLOWLIST.has(name) && !name.startsWith(".");
    }
    return !ROOT_ALLOWLIST.has(name);
  }

  async listRootClutter() {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const clutterFiles = [];
    for (const entry of entries) {
      if (!this.isRootClutter(entry.name, entry.isDirectory())) continue;
      // Only flag files, not directories (to be safe)
      if (entry.isDirectory()) continue;
      const absolutePath = path.resolve(this.rootDir, entry.name);
      const stat = await fs.stat(absolutePath);
      clutterFiles.push({
        name: entry.name,
        path: absolutePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
    clutterFiles.sort((a, b) => a.name.localeCompare(b.name));
    return clutterFiles;
  }

  async syncStatus() {
    const clutterFiles = await this.listRootClutter();
    const dirStatus = await Promise.all(
      this.managedDirs.map(async (dir) => {
        try {
          const stat = await fs.stat(dir);
          return { dir, exists: stat.isDirectory() };
        } catch {
          return { dir, exists: false };
        }
      })
    );

    return {
      rootDir: this.rootDir,
      managedDirs: dirStatus,
      rootClutterCount: clutterFiles.length,
      rootClutterFiles: clutterFiles,
      healthy: dirStatus.every((d) => d.exists) && clutterFiles.length === 0
    };
  }

  async syncFix({ cleanupRootClutter = true } = {}) {
    await this.ensureManagedDirs();
    let removed = [];
    if (cleanupRootClutter) {
      const clutter = await this.listRootClutter();
      for (const file of clutter) {
        try {
          await fs.unlink(file.path);
          removed.push(file.path);
        } catch {
          // ignore individual delete failures
        }
      }
    }
    const status = await this.syncStatus();
    return {
      fixed: true,
      removedFiles: removed,
      status
    };
  }

  /**
   * Called on server startup — silently removes any junk files from project root.
   * This ensures even if a bad AI created files last session, they're gone now.
   */
  async autoCleanOnStartup() {
    try {
      const clutter = await this.listRootClutter();
      if (clutter.length === 0) return;
      
      console.error(`[CLEANUP] Found ${clutter.length} junk file(s) in project root. Auto-removing...`);
      for (const file of clutter) {
        try {
          await fs.unlink(file.path);
          console.error(`[CLEANUP]   Deleted: ${file.name}`);
        } catch {
          // silently skip
        }
      }
      console.error(`[CLEANUP] Root directory cleaned.`);
    } catch {
      // Non-critical — don't crash startup
    }
  }

  /**
   * Clean up all temporary files from .mcp_data/temp/.
   * Called after each job completes or via the browser_cleanup_temp tool.
   */
  async cleanupTempFiles() {
    const tempDir = path.resolve(this.rootDir, ".mcp_data", "temp");
    const removed = [];

    try {
      await fs.mkdir(tempDir, { recursive: true });
      const entries = await fs.readdir(tempDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.resolve(tempDir, entry.name);
        try {
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
          removed.push(entry.name);
        } catch {
          // skip individual failures
        }
      }

      if (removed.length > 0) {
        console.error(`[CLEANUP] Removed ${removed.length} temp file(s) from .mcp_data/temp/`);
      }
    } catch {
      // Non-critical
    }

    return { removed, tempDir };
  }

  /**
   * Get the path to the .mcp_data/temp/ directory.
   * Ensures it exists before returning.
   */
  async getTempDir() {
    const tempDir = path.resolve(this.rootDir, ".mcp_data", "temp");
    await fs.mkdir(tempDir, { recursive: true });
    return tempDir;
  }
}

export const projectSyncService = new ProjectSyncService();
