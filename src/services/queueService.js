/**
 * BullMQ Job Queue Service.
 * Wraps Redis-backed BullMQ queues for async automation job management.
 * Jobs are enqueued by the API layer and processed by workerService.
 * 
 * Falls back to direct execution when Redis is unavailable.
 */
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("queue");

const QUEUE_NAME = "mcp-automation";

class QueueService {
  constructor() {
    this._queue = null;
    this._queueEvents = null;
    this._connection = null;
    this._ready = false;
    this._jobResults = new Map(); // In-memory job result cache
  }

  /** Initialize the queue. Returns true if Redis queue is available. */
  async init() {
    if (this._ready) return true;
    if (!config.redisUrl) {
      log.warn("No REDIS_URL — queue service disabled, using direct execution");
      return false;
    }

    try {
      this._connection = new Redis(config.redisUrl, {
        maxRetriesPerRequest: null, // BullMQ requirement
        retryStrategy: (times) => {
          if (times > 5) return null;
          return Math.min(times * 200, 2000);
        }
      });

      this._connection.on("error", (err) => {
        log.error("Queue Redis error", { error: err.message });
      });

      this._queue = new Queue(QUEUE_NAME, {
        connection: this._connection,
        defaultJobOptions: {
          attempts: config.maxRetries || 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: { age: 3600, count: 200 },
          removeOnFail: { age: 7200, count: 100 }
        }
      });

      this._queueEvents = new QueueEvents(QUEUE_NAME, {
        connection: this._connection.duplicate()
      });

      this._queueEvents.on("completed", ({ jobId, returnvalue }) => {
        log.info("Job completed", { jobId });
        this._jobResults.set(jobId, { status: "completed", result: returnvalue, completedAt: new Date().toISOString() });
      });

      this._queueEvents.on("failed", ({ jobId, failedReason }) => {
        log.error("Job failed", { jobId, reason: failedReason });
        this._jobResults.set(jobId, { status: "failed", error: failedReason, failedAt: new Date().toISOString() });
      });

      this._ready = true;
      log.info("Queue service initialized", { queue: QUEUE_NAME });
      return true;
    } catch (err) {
      log.warn("Queue initialization failed", { error: err.message });
      this._ready = false;
      return false;
    }
  }

  /** 
   * Enqueue a browser automation job.
   * @param {string} action - Tool name (e.g. "browser_click")
   * @param {object} params - Tool parameters
   * @param {object} [options] - BullMQ job options
   * @returns {{ jobId: string, status: string }}
   */
  async enqueue(action, params, options = {}) {
    if (!this._ready || !this._queue) {
      throw new Error("Queue not available — use direct execution");
    }

    const job = await this._queue.add(action, {
      action,
      params,
      enqueuedAt: new Date().toISOString()
    }, {
      priority: options.priority || 0,
      ...options
    });

    log.info("Job enqueued", { jobId: job.id, action });

    return {
      jobId: job.id,
      action,
      status: "queued",
      enqueuedAt: new Date().toISOString()
    };
  }

  /** Get job status by ID. */
  async getJobStatus(jobId) {
    if (!this._ready || !this._queue) {
      // Check in-memory cache
      const cached = this._jobResults.get(jobId);
      if (cached) return { jobId, ...cached };
      return { jobId, status: "unknown", error: "Queue not available" };
    }

    try {
      const job = await this._queue.getJob(jobId);
      if (!job) {
        const cached = this._jobResults.get(jobId);
        if (cached) return { jobId, ...cached };
        return { jobId, status: "not_found" };
      }

      const state = await job.getState();
      const progress = job.progress;

      return {
        jobId: job.id,
        action: job.name,
        status: state,
        progress,
        data: job.data,
        result: job.returnvalue || null,
        error: job.failedReason || null,
        attempts: job.attemptsMade,
        createdAt: new Date(job.timestamp).toISOString(),
        processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
      };
    } catch (err) {
      log.error("getJobStatus failed", { jobId, error: err.message });
      return { jobId, status: "error", error: err.message };
    }
  }

  /** List recent jobs with their statuses. */
  async listJobs({ status = "all", limit = 20 } = {}) {
    if (!this._ready || !this._queue) {
      return { jobs: [], queueAvailable: false };
    }

    try {
      let jobs = [];
      const states = status === "all"
        ? ["completed", "failed", "active", "waiting", "delayed"]
        : [status];

      for (const state of states) {
        const stateJobs = await this._queue.getJobs([state], 0, limit);
        jobs.push(...stateJobs);
      }

      // Sort by timestamp desc, limit
      jobs.sort((a, b) => b.timestamp - a.timestamp);
      jobs = jobs.slice(0, limit);

      return {
        queueAvailable: true,
        total: jobs.length,
        jobs: jobs.map(j => ({
          jobId: j.id,
          action: j.name,
          status: j.finishedOn ? (j.failedReason ? "failed" : "completed") : "active",
          attempts: j.attemptsMade,
          createdAt: new Date(j.timestamp).toISOString()
        }))
      };
    } catch (err) {
      log.error("listJobs failed", { error: err.message });
      return { jobs: [], queueAvailable: false, error: err.message };
    }
  }

  /** Get queue health metrics. */
  async getMetrics() {
    if (!this._ready || !this._queue) {
      return { available: false };
    }

    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this._queue.getWaitingCount(),
        this._queue.getActiveCount(),
        this._queue.getCompletedCount(),
        this._queue.getFailedCount(),
        this._queue.getDelayedCount()
      ]);

      return {
        available: true,
        queue: QUEUE_NAME,
        counts: { waiting, active, completed, failed, delayed },
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return { available: false, error: err.message };
    }
  }

  /** Shutdown gracefully. */
  async shutdown() {
    if (this._queueEvents) await this._queueEvents.close().catch(() => {});
    if (this._queue) await this._queue.close().catch(() => {});
    if (this._connection) await this._connection.quit().catch(() => {});
    this._ready = false;
    log.info("Queue service shut down");
  }

  get isReady() {
    return this._ready;
  }

  get queueName() {
    return QUEUE_NAME;
  }

  get connection() {
    return this._connection;
  }
}

export const queueService = new QueueService();
