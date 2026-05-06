import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("queue-service");

class QueueService {
  constructor() {
    this.connection = config.redisUrl ? new IORedis(config.redisUrl) : null;
    this.queue = null;
    this.queueEvents = null;
    this._initialized = false;
  }

  async init() {
    await this._ensureInitialized();
    return !!this.queue;
  }

  async shutdown() {
    if (this.queue) {
      await this.queue.close();
      this._initialized = false;
    }
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    if (!this.connection) {
      log.warn("Redis URL not provided. Queue service running in degraded mode (sync fallback).");
      this._initialized = true;
      return;
    }

    try {
      this.queue = new Queue("browser_tasks", { connection: this.connection });
      this.queueEvents = new QueueEvents("browser_tasks", { connection: this.connection });
      
      this.queueEvents.on("completed", ({ jobId }) => {
        log.info(`Job ${jobId} completed successfully`);
      });

      this.queueEvents.on("failed", ({ jobId, failedReason }) => {
        log.error(`Job ${jobId} failed`, { reason: failedReason });
      });

      this._initialized = true;
      log.info("Queue service initialized with BullMQ");
    } catch (err) {
      log.error("Failed to initialize queue service", err);
      this.connection = null;
    }
  }

  async addJob(action, params) {
    await this._ensureInitialized();

    if (!this.queue) {
      log.warn(`Queue not available. Executing task ${action} synchronously.`);
      return { sync: true, jobId: "sync-" + Date.now() };
    }

    const job = await this.queue.add(action, params, {
      attempts: config.maxRetries || 3,
      backoff: {
        type: "exponential",
        delay: 1000
      },
      removeOnComplete: true,
      removeOnFail: false
    });

    log.info(`Job added to queue: ${action}`, { jobId: job.id });
    return { sync: false, jobId: job.id };
  }

  async getJobStatus(jobId) {
    await this._ensureInitialized();
    if (!this.queue) return { state: "unknown", sync: true };
    
    const job = await this.queue.getJob(jobId);
    if (!job) return { state: "not_found" };

    const state = await job.getState();
    return {
      state,
      progress: job.progress,
      result: job.returnvalue,
      reason: job.failedReason
    };
  }
}

export const queueService = new QueueService();
