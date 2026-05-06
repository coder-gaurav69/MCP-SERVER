import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("graph-executor");

class GraphExecutor {
  /**
   * Execute a task graph with dependency resolution and concurrency.
   * @param {object} session - Browser session
   * @param {object} taskGraph - { tasks: [{ id, tool, params, dependencies: [] }] }
   * @param {function} dispatchAction - Function to execute a single task
   */
  async execute(session, taskGraph, dispatchAction) {
    log.info(`Executing task graph with ${taskGraph.tasks.length} tasks`);
    
    const completed = new Set();
    const results = {};
    const inProgress = new Set();

    while (completed.size < taskGraph.tasks.length) {
      const readyTasks = taskGraph.tasks.filter(t => 
        !completed.has(t.id) && 
        !inProgress.has(t.id) &&
        (t.dependencies || []).every(depId => completed.has(depId))
      );

      if (readyTasks.length === 0 && inProgress.size === 0) {
        const remaining = taskGraph.tasks.filter(t => !completed.has(t.id)).map(t => t.id);
        throw new Error(`Deadlock or missing dependency in task graph. Remaining: ${remaining.join(", ")}`);
      }

      if (readyTasks.length > 0) {
        const taskPromises = readyTasks.map(async (task) => {
          inProgress.add(task.id);
          log.info(`Starting task ${task.id}: ${task.tool}`);
          
          try {
            const result = await dispatchAction(session, task.tool, task.params);
            results[task.id] = { status: "success", result };
            completed.add(task.id);
          } catch (err) {
            log.error(`Task ${task.id} failed`, { error: err.message });
            results[task.id] = { status: "failed", error: err.message };
            // Depending on strategy, we might want to fail the whole graph or continue
            throw err; 
          } finally {
            inProgress.delete(task.id);
          }
        });

        // Run independent tasks in parallel
        await Promise.all(taskPromises);
      } else {
        // Wait for at least one in-progress task to finish before checking again
        await new Promise(r => setTimeout(r, 100));
      }
    }

    return results;
  }

  /**
   * Speculative execution: Run multiple actions and take the first success.
   * @param {Array<Promise>} actions 
   */
  async speculativeExecute(actions) {
    return Promise.any(actions);
  }
}

export const graphExecutor = new GraphExecutor();
