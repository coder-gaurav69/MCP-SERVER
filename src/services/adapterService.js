import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("adapter-service");

class AdapterService {
  constructor() {
    this.adapters = {
      ecommerce: {
        detect: (url) => url.includes("shop") || url.includes("product") || url.includes("cart"),
        extract: async (page) => {
          log.info("Applying E-commerce adapter");
          return page.evaluate(() => ({
            type: "ecommerce",
            products: Array.from(document.querySelectorAll('[class*="product"], [id*="product"]')).map(el => el.innerText.trim())
          }));
        }
      },
      blog: {
        detect: (url) => url.includes("blog") || url.includes("article") || url.includes("news"),
        extract: async (page) => {
          log.info("Applying Blog adapter");
          return page.evaluate(() => ({
            type: "blog",
            articles: Array.from(document.querySelectorAll('article')).map(el => el.innerText.trim())
          }));
        }
      },
      generic: {
        detect: () => true,
        extract: async () => ({ type: "generic" })
      }
    };
  }

  async getAdapter(url) {
    for (const [name, adapter] of Object.entries(this.adapters)) {
      if (adapter.detect(url)) {
        log.info(`Adapter selected: ${name}`);
        return adapter;
      }
    }
    return this.adapters.generic;
  }
}

export const adapterService = new AdapterService();
