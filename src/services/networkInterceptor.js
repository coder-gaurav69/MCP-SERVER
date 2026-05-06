import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("network-interceptor");

class NetworkInterceptor {
  constructor() {
    this.capturedData = new Map(); // sessionId -> Array of JSON responses
  }

  /**
   * Start intercepting network traffic for a session.
   * @param {object} session - Playwright session
   */
  async attach(session) {
    const sessionId = session.id;
    this.capturedData.set(sessionId, []);

    log.info(`Attaching network interceptor to session ${sessionId}`);

    session.page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      if (contentType.includes("application/json")) {
        try {
          const json = await response.json();
          const entry = {
            url,
            timestamp: new Date().toISOString(),
            data: json
          };
          
          const sessionData = this.capturedData.get(sessionId);
          if (sessionData) {
            sessionData.push(entry);
            // Limit to last 50 responses to avoid memory bloat
            if (sessionData.length > 50) sessionData.shift();
          }
        } catch {
          // Response body might be empty or invalid JSON
        }
      }
    });
  }

  /**
   * Search captured network data for specific patterns.
   */
  async findInNetwork(sessionId, query) {
    const data = this.capturedData.get(sessionId) || [];
    // Basic heuristic: search for keys in JSON that match the query
    const results = data.filter(entry => {
      const stringified = JSON.stringify(entry.data).toLowerCase();
      return stringified.includes(query.toLowerCase());
    });
    
    return results;
  }

  /**
   * Clear captured data for a session.
   */
  clear(sessionId) {
    this.capturedData.delete(sessionId);
  }
}

export const networkInterceptor = new NetworkInterceptor();
