/**
 * Worker Service — BullMQ worker that processes automation jobs.
 * Picks jobs from the queue and executes them against browserService.
 * Runs in-process (not a separate process) for simplicity,
 * but is architecturally isolated so it CAN be split out later.
 */
import { Worker } from "bullmq";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";
import { logAction } from "./loggerService.js";

const log = createServiceLogger("worker");

class WorkerService {
  constructor() {
    this._worker = null;
    this._browserService = null;
    this._wsService = null;
    this._running = false;
    this._stats = {
      processed: 0,
      failed: 0,
      startedAt: null
    };
  }

  /**
   * Start the worker.
   * @param {object} deps - { browserService, queueService, wsService }
   */
  async start({ browserService, queueService, wsService }) {
    if (this._running) return;
    if (!queueService.isReady) {
      log.warn("Queue not available — worker not started");
      return;
    }

    this._browserService = browserService;
    this._wsService = wsService;

    this._worker = new Worker(
      queueService.queueName,
      async (job) => this._processJob(job),
      {
        connection: queueService.connection?.duplicate(),
        concurrency: config.workerConcurrency || 2,
        limiter: {
          max: 10,
          duration: 1000
        }
      }
    );

    this._worker.on("completed", (job) => {
      this._stats.processed++;
      log.info("Worker: job completed", { jobId: job.id, action: job.name });
      this._broadcast("job:completed", { jobId: job.id, action: job.name, result: job.returnvalue });
    });

    this._worker.on("failed", (job, err) => {
      this._stats.failed++;
      log.error("Worker: job failed", { jobId: job?.id, action: job?.name, error: err.message });
      this._broadcast("job:failed", { jobId: job?.id, action: job?.name, error: err.message });
    });

    this._worker.on("active", (job) => {
      log.info("Worker: job active", { jobId: job.id, action: job.name });
      this._broadcast("job:active", { jobId: job.id, action: job.name });
    });

    this._worker.on("error", (err) => {
      log.error("Worker error", { error: err.message });
    });

    this._running = true;
    this._stats.startedAt = new Date().toISOString();
    log.info("Worker service started", { concurrency: config.workerConcurrency || 2 });
  }

  /** Process a single job. */
  async _processJob(job) {
    const { action, params } = job.data;
    const startTime = Date.now();

    log.info("Processing job", { jobId: job.id, action, params: Object.keys(params || {}) });
    await job.updateProgress(10);

    try {
      const result = await this._executeAction(action, params);
      const duration = Date.now() - startTime;

      await job.updateProgress(100);

      logAction({
        action,
        sessionId: params.sessionId || "queue",
        result: "success",
        duration,
        metadata: { jobId: job.id, queued: true }
      });

      return result;
    } catch (err) {
      const duration = Date.now() - startTime;

      logAction({
        action,
        sessionId: params.sessionId || "queue",
        result: "failed",
        error: err.message,
        duration,
        retryCount: job.attemptsMade,
        metadata: { jobId: job.id, queued: true }
      });

      throw err; // BullMQ will handle retry
    }
  }

  /** Map action name to browserService method. */
  async _executeAction(action, params) {
    const bs = this._browserService;
    if (!bs) throw new Error("BrowserService not available in worker");

    const actionMap = {
      "browser_open": () => bs.openUrl(params),
      "browser_click": () => bs.click(params),
      "browser_type": () => bs.type(params),
      "browser_fill_form": () => bs.fillForm(params),
      "browser_hover": () => bs.hover(params),
      "browser_scroll": () => bs.scroll(params),
      "browser_select": () => bs.select(params),
      "browser_wait": () => bs.wait(params),
      "browser_press_key": () => bs.pressKey(params),
      "browser_upload": () => bs.upload(params),
      "browser_screenshot": () => bs.screenshot(params),
      "browser_analyze": () => bs.analyze(params),
      "browser_smart_scrape": () => bs.smartScrape(params),
      "browser_generate_pdf": () => bs.generatePdf(params)
    };

    const handler = actionMap[action];
    if (!handler) {
      throw new Error(`Unknown queued action: ${action}`);
    }

    return handler();
  }

  /** Broadcast event to WebSocket clients. */
  _broadcast(event, data) {
    if (this._wsService) {
      this._wsService.broadcast(event, data);
    }
  }

  /** Get worker stats. */
  getStats() {
    return {
      running: this._running,
      ...this._stats
    };
  }

  /** Shutdown the worker. */
  async shutdown() {
    if (this._worker) {
      await this._worker.close().catch(() => {});
      this._worker = null;
    }
    this._running = false;
    log.info("Worker service shut down");
  }
}

export const workerService = new WorkerService();
