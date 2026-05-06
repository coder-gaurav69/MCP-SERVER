import { Worker } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config.js";
import { browserService } from "./browserService.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("worker-service");

class WorkerService {
  constructor() {
    this.connection = config.redisUrl ? new IORedis(config.redisUrl) : null;
    this.worker = null;
    this._initialized = false;
  }

  async start() {
    if (this._initialized) return;
    if (!this.connection) {
      log.warn("Redis URL not provided. Worker service will not start (standalone mode).");
      return;
    }

    try {
      this.worker = new Worker("browser_tasks", async (job) => {
        const { name, data } = job;
        log.info(`Processing job ${job.id}: ${name}`);

        try {
          let result;
          switch (name) {
            case "browser_autonomous_goal":
              result = await browserService.executeAutonomousGoal(data);
              break;
            case "browser_open":
              result = await browserService.openUrl(data);
              break;
            case "browser_click":
              result = await browserService.click(data);
              break;
            case "browser_type":
              result = await browserService.type(data);
              break;
            case "browser_fill_form":
              result = await browserService.fillForm(data);
              break;
            case "browser_screenshot":
              result = await browserService.screenshot(data);
              break;
            case "browser_scrape_content":
              result = await browserService.scrapeContent(data);
              break;
            default:
              throw new Error(`Unsupported job type: ${name}`);
          }
          return result;
        } catch (err) {
          log.error(`Job ${job.id} execution failed`, { error: err.message });
          throw err;
        }
      }, {
        connection: this.connection,
        concurrency: config.workerConcurrency || 2,
        lockDuration: 30000,
      });

      this.worker.on("completed", (job) => {
        log.info(`Worker finished job ${job.id}`);
      });

      this.worker.on("failed", (job, err) => {
        log.error(`Worker failed job ${job.id}`, { error: err.message });
      });

      this._initialized = true;
      log.info(`Worker service started with concurrency: ${config.workerConcurrency}`);
    } catch (err) {
      log.error("Failed to start worker service", err);
    }
  }

  async shutdown() {
    if (this.worker) {
      await this.worker.close();
      this._initialized = false;
      log.info("Worker service stopped");
    }
  }
}

export const workerService = new WorkerService();
