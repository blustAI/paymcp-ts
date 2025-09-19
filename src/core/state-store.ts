/**
 * StateStoreProvider for PayMCP - ENG-114 Timeout Fix
 * Simple state storage with only 3 methods (put, get, delete)
 */

import { createClient, RedisClientType } from 'redis';

/**
 * Strict type definition for payment state
 */
export interface PaymentState {
  session_id?: string;
  payment_id: string;  // Required for indexing
  payment_url: string;
  tool_name: string;
  tool_args: Record<string, any>;
  status: string;
  created_at: number;
  _timestamp?: number;  // Internal TTL tracking
}

// Legacy alias for backward compatibility
export type StateData = PaymentState;

/**
 * Abstract base class for state storage providers with payment_id indexing
 */
export abstract class StateStoreProvider {
  abstract put(key: string, value: PaymentState): Promise<void>;
  abstract get(key: string): Promise<PaymentState | null>;
  abstract delete(key: string): Promise<void>;
  /**
   * Retrieve a value by payment_id using O(1) hash lookup
   */
  abstract getByPaymentId(paymentId: string): Promise<PaymentState | null>;
}

/**
 * In-memory state storage with payment_id index for O(1) lookups
 */
export class InMemoryStore extends StateStoreProvider {
  private store: Map<string, PaymentState> = new Map();
  // Hash index: payment_id -> key for O(1) payment_id lookups
  private paymentIndex: Map<string, string> = new Map();
  private ttlSeconds: number;
  private lastCleanup: number = Date.now();
  private cleanupInterval: number = 300000; // 5 minutes in ms

  constructor(ttlSeconds: number = 3600) {
    super();
    this.ttlSeconds = ttlSeconds;
    console.log(`[InMemoryStore] Initialized with TTL=${ttlSeconds}s and payment_id index`);
  }

  async put(key: string, value: PaymentState): Promise<void> {
    await this.cleanupIfNeeded();
    value._timestamp = Date.now();

    // Update primary storage
    this.store.set(key, value);

    // Update payment_id index for O(1) lookups
    const paymentId = value.payment_id;
    if (paymentId) {
      // Remove old index entry if key is being updated
      const oldValue = this.store.get(key);
      if (oldValue?.payment_id && oldValue.payment_id !== paymentId) {
        this.paymentIndex.delete(oldValue.payment_id);
      }

      // Add new index entry
      this.paymentIndex.set(paymentId, key);
      console.debug(`[InMemoryStore] Indexed payment_id=${paymentId} -> key=${key}`);
    }

    console.debug(`[InMemoryStore] Stored state for key=${key}`);
  }

  async get(key: string): Promise<PaymentState | null> {
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
      await this.deleteWithIndex(key);
      return null;
    }

    console.debug(`[InMemoryStore] Retrieved state for key=${key}`);
    return value;
  }

  async getByPaymentId(paymentId: string): Promise<PaymentState | null> {
    // Use payment_id index for direct O(1) lookup
    const key = this.paymentIndex.get(paymentId);
    if (!key) {
      console.debug(`[InMemoryStore] Payment ID not found in index: ${paymentId}`);
      return null;
    }

    console.debug(`[InMemoryStore] Found key=${key} for payment_id=${paymentId} via index`);
    return this.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.deleteWithIndex(key);
  }

  private async deleteWithIndex(key: string): Promise<void> {
    const value = this.store.get(key);
    if (value) {
      // Remove from payment_id index
      if (value.payment_id) {
        this.paymentIndex.delete(value.payment_id);
        console.debug(`[InMemoryStore] Removed payment_id=${value.payment_id} from index`);
      }

      // Remove from primary storage
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
      await this.deleteWithIndex(key);
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

  async put(key: string, value: PaymentState): Promise<void> {
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

    // Update payment_id index for O(1) lookups
    const paymentId = value.payment_id;
    if (paymentId) {
      const indexKey = `paymcp:idx:payment:${paymentId}`;
      await this.client.setEx(indexKey, this.ttlSeconds, key);
      console.debug(`[RedisStore] Indexed payment_id=${paymentId} -> key=${key}`);
    }

    console.debug(`[RedisStore] Stored state for key=${key}`);
  }

  async get(key: string): Promise<PaymentState | null> {
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

  async getByPaymentId(paymentId: string): Promise<PaymentState | null> {
    await this.connect();

    // Look up key from payment_id index
    const indexKey = `paymcp:idx:payment:${paymentId}`;
    const key = await this.client.get(indexKey);

    if (!key) {
      console.debug(`[RedisStore] Payment ID not found in index: ${paymentId}`);
      return null;
    }

    console.debug(`[RedisStore] Found key=${key} for payment_id=${paymentId} via index`);
    return this.get(key);
  }

  async delete(key: string): Promise<void> {
    await this.connect();

    const redisKey = `paymcp:${key}`;

    // Get value first to find payment_id for index cleanup
    const data = await this.client.get(redisKey);
    if (data) {
      try {
        const value = JSON.parse(data);
        const paymentId = value.payment_id;
        if (paymentId) {
          // Delete from payment_id index
          const indexKey = `paymcp:idx:payment:${paymentId}`;
          await this.client.del(indexKey);
          console.debug(`[RedisStore] Removed payment_id=${paymentId} from index`);
        }
      } catch (error) {
        // Ignore parse errors during cleanup
      }
    }

    // Delete primary key
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