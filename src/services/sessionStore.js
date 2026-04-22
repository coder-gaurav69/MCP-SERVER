/**
 * Redis-backed session metadata store.
 * Stores session metadata (id, domain, timestamps, status) in Redis
 * for cross-process visibility and crash recovery.
 * 
 * Falls back to in-memory Map when Redis is unavailable.
 */
import Redis from "ioredis";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("session-store");

const SESSION_PREFIX = "mcp:session:";
const DOMAIN_INDEX = "mcp:sessions:by-domain";
const SESSION_TTL = 86400; // 24h

class SessionStore {
  constructor() {
    this._redis = null;
    this._fallback = new Map();
    this._connected = false;
  }

  /** Lazy-connect to Redis. Returns true if connected. */
  async connect() {
    if (this._connected) return true;
    if (!config.redisUrl) {
      log.warn("No REDIS_URL configured — using in-memory session store");
      return false;
    }

    try {
      this._redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 5) return null; // stop retrying
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true
      });

      this._redis.on("error", (err) => {
        log.error("Redis connection error", { error: err.message });
      });

      this._redis.on("connect", () => {
        log.info("Redis connected");
      });

      await this._redis.connect();
      this._connected = true;
      return true;
    } catch (err) {
      log.warn("Redis connection failed — falling back to in-memory", { error: err.message });
      this._redis = null;
      this._connected = false;
      return false;
    }
  }

  /** Store session metadata. */
  async set(sessionId, metadata) {
    const data = {
      ...metadata,
      id: sessionId,
      updatedAt: new Date().toISOString()
    };

    if (this._redis) {
      try {
        const pipeline = this._redis.pipeline();
        pipeline.set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(data), "EX", SESSION_TTL);
        if (data.domain) {
          pipeline.hset(DOMAIN_INDEX, data.domain, sessionId);
        }
        await pipeline.exec();
      } catch (err) {
        log.error("Redis set failed", { sessionId, error: err.message });
        this._fallback.set(sessionId, data);
      }
    } else {
      this._fallback.set(sessionId, data);
    }
  }

  /** Get session metadata by ID. */
  async get(sessionId) {
    if (this._redis) {
      try {
        const raw = await this._redis.get(`${SESSION_PREFIX}${sessionId}`);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        log.error("Redis get failed", { sessionId, error: err.message });
        return this._fallback.get(sessionId) || null;
      }
    }
    return this._fallback.get(sessionId) || null;
  }

  /** Find session by domain. */
  async findByDomain(domain) {
    if (this._redis) {
      try {
        const sessionId = await this._redis.hget(DOMAIN_INDEX, domain);
        if (!sessionId) return null;
        return this.get(sessionId);
      } catch (err) {
        log.error("Redis findByDomain failed", { domain, error: err.message });
      }
    }

    // Fallback
    for (const [, data] of this._fallback) {
      if (data.domain === domain) return data;
    }
    return null;
  }

  /** Remove session metadata. */
  async remove(sessionId) {
    if (this._redis) {
      try {
        const raw = await this._redis.get(`${SESSION_PREFIX}${sessionId}`);
        if (raw) {
          const data = JSON.parse(raw);
          if (data.domain) {
            await this._redis.hdel(DOMAIN_INDEX, data.domain);
          }
        }
        await this._redis.del(`${SESSION_PREFIX}${sessionId}`);
      } catch (err) {
        log.error("Redis remove failed", { sessionId, error: err.message });
      }
    }
    this._fallback.delete(sessionId);
  }

  /** List all session metadata. */
  async list() {
    if (this._redis) {
      try {
        const keys = await this._redis.keys(`${SESSION_PREFIX}*`);
        if (keys.length === 0) return [];
        const pipeline = this._redis.pipeline();
        keys.forEach(k => pipeline.get(k));
        const results = await pipeline.exec();
        return results.map(([, val]) => val ? JSON.parse(val) : null).filter(Boolean);
      } catch (err) {
        log.error("Redis list failed", { error: err.message });
      }
    }
    return Array.from(this._fallback.values());
  }

  /** Update session status (alive/dead). */
  async updateStatus(sessionId, status) {
    const existing = await this.get(sessionId);
    if (existing) {
      await this.set(sessionId, { ...existing, status, updatedAt: new Date().toISOString() });
    }
  }

  /** Disconnect Redis. */
  async disconnect() {
    if (this._redis) {
      try {
        await this._redis.quit();
      } catch { /* ignore */ }
      this._redis = null;
      this._connected = false;
    }
  }

  get isRedisConnected() {
    return this._connected && this._redis !== null;
  }
}

export const sessionStore = new SessionStore();
