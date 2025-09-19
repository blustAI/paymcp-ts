/**
 * StateStoreProvider for PayMCP - ENG-114 Timeout Fix
 * Simple state storage with only 3 methods (put, get, delete)
 */

import { createClient, RedisClientType } from 'redis';

export interface StateData {
  session_id?: string;
  payment_id?: string;
  payment_url?: string;
  tool_name?: string;
  tool_args?: Record<string, any>;
  status?: string;
  created_at?: number;
  _timestamp?: number;
  [key: string]: any;
}

/**
 * Abstract base class for state storage providers
 */
export abstract class StateStoreProvider {
  abstract put(key: string, value: StateData): Promise<void>;
  abstract get(key: string): Promise<StateData | null>;
  abstract delete(key: string): Promise<void>;
}

/**
 * In-memory state storage (default for development)
 */
export class InMemoryStore extends StateStoreProvider {
  private store: Map<string, StateData> = new Map();
  private ttlSeconds: number;
  private lastCleanup: number = Date.now();
  private cleanupInterval: number = 300000; // 5 minutes in ms

  constructor(ttlSeconds: number = 3600) {
    super();
    this.ttlSeconds = ttlSeconds;
    console.log(`[InMemoryStore] Initialized with TTL=${ttlSeconds}s`);
  }

  async put(key: string, value: StateData): Promise<void> {
    await this.cleanupIfNeeded();
    value._timestamp = Date.now();
    this.store.set(key, value);
    console.debug(`[InMemoryStore] Stored state for key=${key}`);
  }

  async get(key: string): Promise<StateData | null> {
    await this.cleanupIfNeeded();

    const value = this.store.get(key);
    if (!value) {
      console.debug(`[InMemoryStore] Key not found: ${key}`);
      return null;
    }

    const timestamp = value._timestamp || 0;
    const now = Date.now();

    // Check if expired
    if (now - timestamp > this.ttlSeconds * 1000) {
      console.debug(`[InMemoryStore] Key expired: ${key}`);
      this.store.delete(key);
      return null;
    }

    console.debug(`[InMemoryStore] Retrieved state for key=${key}`);
    return value;
  }

  async delete(key: string): Promise<void> {
    if (this.store.has(key)) {
      this.store.delete(key);
      console.debug(`[InMemoryStore] Deleted state for key=${key}`);
    }
  }

  private async cleanupIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) {
      return;
    }

    this.lastCleanup = now;
    const expiredKeys: string[] = [];

    for (const [key, value] of this.store.entries()) {
      const timestamp = value._timestamp || 0;
      if (now - timestamp > this.ttlSeconds * 1000) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.store.delete(key);
    }

    if (expiredKeys.length > 0) {
      console.log(`[InMemoryStore] Cleaned up ${expiredKeys.length} expired entries`);
    }
  }
}

/**
 * Redis state storage (for production)
 */
export class RedisStore extends StateStoreProvider {
  private client: RedisClientType;
  private ttlSeconds: number;
  private connected: boolean = false;

  constructor(options: {
    host?: string;
    port?: number;
    db?: number;
    password?: string;
    ttlSeconds?: number;
    url?: string;
  } = {}) {
    super();
    
    this.ttlSeconds = options.ttlSeconds || 3600;

    // Create Redis client
    if (options.url) {
      this.client = createClient({ url: options.url });
    } else {
      this.client = createClient({
        socket: {
          host: options.host || 'localhost',
          port: options.port || 6379
        },
        database: options.db || 0,
        password: options.password
      });
    }

    // Setup error handling
    this.client.on('error', (err: any) => {
      console.error('[RedisStore] Redis client error:', err);
    });

    // Connect
    this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.connected) {
      try {
        await this.client.connect();
        this.connected = true;
        console.log('[RedisStore] Connected to Redis');
      } catch (error) {
        console.error('[RedisStore] Failed to connect to Redis:', error);
        throw error;
      }
    }
  }

  async put(key: string, value: StateData): Promise<void> {
    await this.connect();
    
    // Add timestamp for consistency with in-memory store
    value._timestamp = Date.now();
    
    // Prefix key to avoid collisions
    const redisKey = `paymcp:${key}`;
    
    // Store as JSON with TTL
    await this.client.setEx(
      redisKey,
      this.ttlSeconds,
      JSON.stringify(value)
    );
    
    console.debug(`[RedisStore] Stored state for key=${key}`);
  }

  async get(key: string): Promise<StateData | null> {
    await this.connect();
    
    const redisKey = `paymcp:${key}`;
    const data = await this.client.get(redisKey);
    
    if (!data) {
      console.debug(`[RedisStore] Key not found: ${key}`);
      return null;
    }
    
    try {
      const value = JSON.parse(data);
      console.debug(`[RedisStore] Retrieved state for key=${key}`);
      return value;
    } catch (error) {
      console.error(`[RedisStore] Failed to parse value for key=${key}:`, error);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.connect();
    
    const redisKey = `paymcp:${key}`;
    const result = await this.client.del(redisKey);
    
    if (result) {
      console.debug(`[RedisStore] Deleted state for key=${key}`);
    } else {
      console.debug(`[RedisStore] Key not found for deletion: ${key}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
      console.log('[RedisStore] Disconnected from Redis');
    }
  }
}