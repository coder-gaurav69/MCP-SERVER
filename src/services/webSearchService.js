/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WEB SEARCH SERVICE — Free internet search via scraping (NO paid APIs)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides web search and content extraction using only fetch + HTML parsing.
 * Zero cost, zero API keys required.
 *
 * Features:
 *   - Search the web via DuckDuckGo Lite (free, no API key)
 *   - Extract clean text from any URL
 *   - Remove scripts, styles, and noise
 *   - Normalize whitespace
 */

import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("web-search");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/**
 * Fetch a URL with standard browser headers.
 */
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.headers || {})
      },
      redirect: "follow",
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Strip all HTML tags and clean up text content.
 * Removes script/style/noscript blocks, normalizes whitespace.
 */
function htmlToCleanText(html) {
  let text = html;

  // Remove script, style, noscript, head blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, " ");

  // Replace common block elements with newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr|section|article|nav|footer|header)[^>]*>/gi, "\n");

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));

  // Normalize whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n\s*\n/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Extract structured data from HTML: headings, paragraphs, links, images.
 */
function extractStructuredData(html, baseUrl = "") {
  const headings = [];
  const paragraphs = [];
  const links = [];
  const images = [];

  // Extract headings
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (text) {
      headings.push({ level: Number(match[1]), text });
    }
  }

  // Extract paragraphs
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((match = pRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, "").trim();
    if (text && text.length > 10) {
      paragraphs.push(text.slice(0, 500));
    }
  }

  // Extract links
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (href && text && !href.startsWith("#") && !href.startsWith("javascript:")) {
      let fullUrl = href;
      try {
        if (baseUrl && !href.startsWith("http")) {
          fullUrl = new URL(href, baseUrl).href;
        }
      } catch { /* keep as-is */ }
      links.push({ text: text.slice(0, 100), url: fullUrl });
    }
  }

  // Extract images
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    const alt = (match[0].match(/alt=["']([^"']*)/i) || [])[1] || "";
    if (src) {
      let fullSrc = src;
      try {
        if (baseUrl && !src.startsWith("http") && !src.startsWith("data:")) {
          fullSrc = new URL(src, baseUrl).href;
        }
      } catch { /* keep as-is */ }
      images.push({ src: fullSrc, alt });
    }
  }

  return {
    headings: headings.slice(0, 50),
    paragraphs: paragraphs.slice(0, 30),
    links: links.slice(0, 100),
    images: images.slice(0, 30)
  };
}

/**
 * Extract the page title from HTML.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
}

/**
 * Extract meta description from HTML.
 */
function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) ||
                html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
  return match ? match[1].trim() : "";
}

class WebSearchService {
  /**
   * Search the web using DuckDuckGo Lite (free, no API key).
   * Returns structured search results.
   *
   * @param {string} query - Search query
   * @param {number} [maxResults=10] - Maximum number of results
   * @returns {Promise<{query: string, results: Array<{title: string, url: string, snippet: string}>, resultCount: number}>}
   */
  async search(query, maxResults = 10) {
    log.info("Web search", { query, maxResults });

    if (!query || !query.trim()) {
      throw new Error("Search query is required.");
    }

    const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

    try {
      const response = await safeFetch(searchUrl, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      });

      const html = await response.text();
      const results = this._parseDDGResults(html, maxResults);

      log.info("Search complete", { query, resultCount: results.length });

      return {
        query,
        results,
        resultCount: results.length,
        source: "duckduckgo_lite"
      };
    } catch (err) {
      log.error("Search failed", { query, error: err.message });

      // Fallback: try DuckDuckGo HTML version
      try {
        return await this._searchDDGHtml(query, maxResults);
      } catch {
        throw new Error(`Web search failed: ${err.message}. No fallback available.`);
      }
    }
  }

  /**
   * Parse DuckDuckGo Lite HTML results.
   */
  _parseDDGResults(html, maxResults) {
    const results = [];

    // DuckDuckGo Lite uses a table-based layout
    // Results are in table rows with class "result-link" and "result-snippet"
    const linkRegex = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

    const urls = [];
    const titles = [];
    const snippets = [];

    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      urls.push(match[1]);
      titles.push(match[2].replace(/<[^>]+>/g, "").trim());
    }

    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
    }

    // If the Lite format didn't work, try generic link extraction
    if (urls.length === 0) {
      const genericLinkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = genericLinkRegex.exec(html)) !== null) {
        const url = match[1];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        // Skip DDG internal links
        if (!url.includes("duckduckgo.com") && title.length > 3) {
          urls.push(url);
          titles.push(title);
        }
      }
    }

    for (let i = 0; i < Math.min(urls.length, maxResults); i++) {
      results.push({
        title: titles[i] || "",
        url: urls[i],
        snippet: snippets[i] || ""
      });
    }

    return results;
  }

  /**
   * Fallback: search using DuckDuckGo HTML version.
   */
  async _searchDDGHtml(query, maxResults) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await safeFetch(searchUrl, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const html = await response.text();
    const results = [];

    // DDG HTML results use class "result__a" for links and "result__snippet" for descriptions
    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const urls = [];
    const titles = [];
    const snippets = [];
    let match;

    while ((match = resultRegex.exec(html)) !== null) {
      // DDG redirects through uddg parameter
      let url = match[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
      urls.push(url);
      titles.push(match[2].replace(/<[^>]+>/g, "").trim());
    }

    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(match[1].replace(/<[^>]+>/g, "").trim());
    }

    for (let i = 0; i < Math.min(urls.length, maxResults); i++) {
      results.push({
        title: titles[i] || "",
        url: urls[i],
        snippet: snippets[i] || ""
      });
    }

    return {
      query,
      results,
      resultCount: results.length,
      source: "duckduckgo_html"
    };
  }

  /**
   * Fetch and extract clean content from a URL.
   *
   * @param {string} url - The URL to fetch
   * @param {object} [options]
   * @param {number} [options.maxLength=10000] - Max characters to return
   * @param {boolean} [options.structured=false] - Return structured data (headings, links, etc.)
   * @returns {Promise<{url: string, title: string, description: string, text: string, structured?: object, wordCount: number}>}
   */
  async extractContent(url, options = {}) {
    const { maxLength = 10000, structured = false } = options;
    log.info("Extracting content", { url, maxLength, structured });

    if (!url || !url.trim()) {
      throw new Error("URL is required.");
    }

    const response = await safeFetch(url);
    const contentType = response.headers.get("content-type") || "";

    // Handle non-HTML content
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      const text = await response.text();
      return {
        url,
        title: "",
        description: "",
        text: text.slice(0, maxLength),
        wordCount: text.split(/\s+/).filter(Boolean).length,
        contentType
      };
    }

    const html = await response.text();
    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    const cleanText = htmlToCleanText(html).slice(0, maxLength);
    const wordCount = cleanText.split(/\s+/).filter(Boolean).length;

    const result = {
      url,
      title,
      description,
      text: cleanText,
      wordCount
    };

    if (structured) {
      result.structured = extractStructuredData(html, url);
    }

    log.info("Content extracted", { url, title, wordCount });
    return result;
  }

  /**
   * Search and get content from top results in one call.
   *
   * @param {string} query - Search query
   * @param {number} [topN=3] - How many top results to fetch content from
   * @param {number} [maxContentLength=3000] - Max content per page
   */
  async searchAndExtract(query, topN = 3, maxContentLength = 3000) {
    const searchResults = await this.search(query, topN + 2);
    const enriched = [];

    for (const result of searchResults.results.slice(0, topN)) {
      try {
        const content = await this.extractContent(result.url, {
          maxLength: maxContentLength,
          structured: true
        });
        enriched.push({
          ...result,
          content: content.text,
          structured: content.structured,
          wordCount: content.wordCount
        });
      } catch (err) {
        enriched.push({
          ...result,
          content: "",
          error: err.message
        });
      }
    }

    return {
      query,
      enrichedResults: enriched,
      totalSearchResults: searchResults.resultCount,
      source: searchResults.source
    };
  }
}

export const webSearchService = new WebSearchService();
