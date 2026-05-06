import { createServiceLogger } from "./loggerService.js";
import { browserService } from "./browserService.js";

const log = createServiceLogger("scheduler-service");

class SchedulerService {
  constructor() {
    this.jobs = new Map(); // jobId -> timeout
  }

  /**
   * Schedule a recurring browser task.
   * @param {string} id - Unique job ID
   * @param {object} task - { goal, sessionId, intervalMs }
   */
  async scheduleTask(id, { goal, sessionId, intervalMs }) {
    if (this.jobs.has(id)) {
      this.cancelTask(id);
    }

    log.info(`Scheduling task ${id}: ${goal} every ${intervalMs}ms`);

    const run = async () => {
      log.info(`Executing scheduled task ${id}`);
      try {
        await browserService.executeAutonomousGoal({ sessionId, goal });
      } catch (err) {
        log.error(`Scheduled task ${id} failed`, { error: err.message });
      }
      
      const timeout = setTimeout(run, intervalMs);
      this.jobs.set(id, timeout);
    };

    const timeout = setTimeout(run, intervalMs);
    this.jobs.set(id, timeout);
  }

  cancelTask(id) {
    const timeout = this.jobs.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.jobs.delete(id);
      log.info(`Cancelled task ${id}`);
    }
  }

  listJobs() {
    return Array.from(this.jobs.keys());
  }
}

export const schedulerService = new SchedulerService();
