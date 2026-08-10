/**
 * Missive API client with token validation, error handling, and rate limit detection
 */

import {
  MissiveAPIError,
  AuthError,
  RateLimitError,
  NotFoundError,
} from './errors.js';

const BASE_URL = 'https://public.missiveapp.com/v1';
const REQUEST_TIMEOUT = 30000;

// Missive's documented limits: 300 requests/min (5/sec), 900/15min, 5 concurrent.
// For continuous polling (which is what mentions-scanning and any multi-conversation
// tool call does) Missive's own guidance is to stay around 1 request/second rather
// than bursting near the ceiling — bursting invites 429s under real-world jitter,
// especially now that more than one client (ClickUp, Jarvis, ...) can call this
// server against the same token.
const MIN_REQUEST_INTERVAL_MS = 1000;
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
}

export class MissiveClient {
  private readonly token: string;

  // Serializes outgoing requests so concurrent callers (e.g. Promise.all
  // fetching comments + messages for one conversation) get spaced out rather
  // than firing at once. Shared per-instance, and instances are cached
  // per-token (see getClientForToken/getClient below), so this pacing is
  // effectively per-token, matching how Missive's rate limit is scoped.
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(token: string) {
    if (!token) {
      throw new Error('API token is required');
    }

    if (token.length < 20) {
      throw new Error('API token appears to be invalid (too short)');
    }

    this.token = token;
  }

  private pace(): Promise<void> {
    const myTurn = this.requestQueue.then(async () => {
      const wait = Math.max(0, this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
      if (wait > 0) {
        await sleep(wait);
      }
      this.lastRequestAt = Date.now();
    });
    // Keep the chain alive even if this turn's caller ends up throwing later —
    // the pacing slot itself always resolves.
    this.requestQueue = myTurn.catch(() => {});
    return myTurn;
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, params } = options;

    let url = `${BASE_URL}${path}`;

    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    for (let attempt = 0; ; attempt++) {
      await this.pace();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          await this.handleErrorResponse(response);
        }

        if (response.status === 204) {
          return {} as T;
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof RateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
          const waitSeconds = error.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS * (attempt + 1);
          console.error(
            `Missive API rate limited on ${path}; retrying in ${waitSeconds}s ` +
              `(attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
          );
          await sleep(waitSeconds * 1000);
          continue;
        }
        if (error instanceof MissiveAPIError) {
          throw error;
        }
        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new MissiveAPIError('Request timeout', 408, 'TIMEOUT');
          }
          // Redact token from any error message
          const safeMessage = error.message.replace(this.token, '[REDACTED]');
          throw new MissiveAPIError(safeMessage, 500, 'UNKNOWN');
        }
        throw new MissiveAPIError('Unknown error occurred', 500, 'UNKNOWN');
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    let message = `API error: ${response.status}`;

    try {
      const errorBody = await response.text();
      if (errorBody) {
        // Try to parse as JSON for better error messages
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.error) {
            // Error could be string or object
            message = typeof parsed.error === 'string'
              ? parsed.error
              : JSON.stringify(parsed.error);
          } else if (parsed.message) {
            message = typeof parsed.message === 'string'
              ? parsed.message
              : JSON.stringify(parsed.message);
          } else {
            // Fallback to stringified response
            message = JSON.stringify(parsed).substring(0, 500);
          }
        } catch {
          // Use text as-is if not JSON
          message = errorBody.substring(0, 200);
        }
      }
    } catch {
      // Ignore errors reading body
    }

    // Redact any token that might be in error messages
    if (typeof message === 'string') {
      message = message.replace(this.token, '[REDACTED]');
    }

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 404:
        throw new NotFoundError(message);
      case 429: {
        const retryAfter = response.headers.get('Retry-After');
        throw new RateLimitError(
          message,
          retryAfter ? parseInt(retryAfter, 10) : undefined
        );
      }
      default:
        throw new MissiveAPIError(message, response.status);
    }
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>(path, { method: 'GET', params });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

// Per-token client cache using WeakRef for GC-friendly caching
const clientCache = new Map<string, WeakRef<MissiveClient>>();
const registry = new FinalizationRegistry<string>((token) => {
  clientCache.delete(token);
});

export function getClientForToken(token: string): MissiveClient {
  const ref = clientCache.get(token);
  const existing = ref?.deref();
  if (existing) return existing;

  const client = new MissiveClient(token);
  clientCache.set(token, new WeakRef(client));
  registry.register(client, token);
  return client;
}

// Singleton for stdio mode (backward compat)
let stdioClient: MissiveClient | null = null;

export function getClient(): MissiveClient {
  if (!stdioClient) {
    const token = process.env.MISSIVE_API_TOKEN;
    if (!token) {
      throw new Error('MISSIVE_API_TOKEN environment variable is required');
    }
    stdioClient = new MissiveClient(token);
  }
  return stdioClient;
}
