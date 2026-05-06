import { createServiceLogger } from "./loggerService.js";
import { browserService } from "./browserService.js";
import { queueService } from "./queueService.js";

const log = createServiceLogger("crawler-service");

class CrawlerService {
  constructor() {
    this.visited = new Set();
    this.queue = [];
  }

  /**
   * Start an intelligent crawl of a website.
   * @param {string} sessionId 
   * @param {object} options { maxDepth, maxPages, domainOnly }
   */
  async startCrawl({ sessionId, startUrl, maxDepth = 2, maxPages = 50 }) {
    log.info(`Starting crawl at ${startUrl}`, { maxDepth, maxPages });
    
    this.visited.clear();
    const domain = new URL(startUrl).origin;
    
    await this._crawlNode(sessionId, startUrl, 0, maxDepth, maxPages, domain);
    
    return {
      status: "completed",
      pagesVisited: this.visited.size,
      urls: Array.from(this.visited)
    };
  }

  async _crawlNode(sessionId, url, depth, maxDepth, maxPages, domain) {
    if (depth > maxDepth || this.visited.size >= maxPages || this.visited.has(url)) {
      return;
    }

    log.info(`Crawling depth ${depth}: ${url}`);
    this.visited.add(url);

    try {
      const session = browserService.getSession(sessionId);
      if (!session) return;

      // Navigate
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      
      // Extract links
      const links = await session.page.evaluate((domain) => {
        return Array.from(document.querySelectorAll('a'))
          .map(a => a.href)
          .filter(href => {
            try {
              const u = new URL(href);
              return u.origin === domain && !u.hash;
            } catch { return false; }
          });
      }, domain);

      // Deduplicate and filter
      const uniqueLinks = [...new Set(links)];
      
      // Queue next level
      for (const link of uniqueLinks) {
        if (!this.visited.has(link)) {
          // In a real system, we might add these to the BullMQ queue
          await this._crawlNode(sessionId, link, depth + 1, maxDepth, maxPages, domain);
        }
      }
    } catch (err) {
      log.warn(`Failed to crawl ${url}`, { error: err.message });
    }
  }

  /**
   * Queue a crawl job for the parallel engine.
   */
  async queueCrawl(params) {
    return queueService.addJob("browser_crawl", params);
  }
}

export const crawlerService = new CrawlerService();
