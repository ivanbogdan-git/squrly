import * as crypto from 'crypto';
import { Transform } from 'stream';
import { parse } from 'node-html-parser';
import type { OutputData } from './types.js';

// Type for the callback used by the _flush method
type FlushCallback = (error?: Error | null) => void;

// Constants
const RATE_LIMIT_DELAY_MS = 1000; // 1 request per second
const FETCH_TIMEOUT_MS = 30000; // 30 seconds
const RETRY_DELAY_MS = 60000; // 60 seconds in production
const RETRY_DELAY_TEST_MS = 10; // 10ms in test mode

// Regex patterns
const LAST_URL_REGEX =
  /(?:https?:\/\/)?(?:localhost(?::\d+)?|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?:\/[^\s]*)?/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

/**
 * A Transform stream that receives bracketed content (e.g., "[text www.url.com]"),
 * finds the *last* URL, fetches it, processes the body for title and email,
 * and outputs the result as a JSON string.
 *
 * It handles rate-limiting, retries, and de-duplication.
 */
export class UrlProcessor extends Transform {
  private seenUrls = new Set<string>();
  private secret: string;
  private taskQueue: (() => Promise<void>)[] = [];
  private isProcessing = false;
  private flushCallback: FlushCallback | null = null;
  private pendingRetries = 0;

  /**
   * Constructs a new UrlProcessor instance.
   * @param secret A secret string used for hashing email addresses.
   */
  constructor(secret: string) {
    // Takes object from UrlParser, outputs JSON strings.
    super({ readableObjectMode: true, writableObjectMode: true });
    this.secret = secret;
  }

  /**
   * Main transform function. Receives bracketed content from UrlParser.
   */
  _transform(
    chunk: string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    // First, strip the outer brackets from the input chunk
    let content = chunk.toString();
    if (content.startsWith('[') && content.endsWith(']')) {
      content = content.slice(1, -1);
    }

    const urls = Array.from(content.matchAll(LAST_URL_REGEX));

    if (urls.length === 0) {
      callback();
      return; // No URL found
    }

    // Get the last match
    const urlMatch = urls[urls.length - 1];
    let urlStr = urlMatch[0];

    // Ensure it has a protocol for the request
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = `https://${urlStr}`; // Default to HTTPS
    }

    if (this.seenUrls.has(urlStr)) {
      callback();
      return; // Already processed this URL
    }

    this.seenUrls.add(urlStr);

    // Add this URL processing task to our rate-limiting queue
    this.taskQueue.push(() => this.processUrl(urlStr));
    this.processQueue(); // Start processing if not already
    callback();
  }

  /**
   * Called when the input stream ends (e.g., file is fully read).
   * We must wait for all pending network requests in the queue
   * and all scheduled retries to finish before we signal that we are done.
   */
  _flush(callback: FlushCallback): void {
    // If we're not busy, the queue is empty, and there are no pending retries, we're done now.
    if (
      this.taskQueue.length === 0 &&
      !this.isProcessing &&
      this.pendingRetries === 0
    ) {
      callback();
    } else {
      // Otherwise, store the callback.
      // processQueue will call it when it's truly finished.
      this.flushCallback = callback;

      // If it's idle, give it a kick to start processing
      if (!this.isProcessing) {
        this.processQueue();
      }
    }
  }

  /**
   * Checks if we can flush and does so if conditions are met.
   * This is called after tasks complete to ensure we don't exit prematurely.
   */
  private checkAndFlush(): void {
    if (
      this.flushCallback &&
      this.taskQueue.length === 0 &&
      !this.isProcessing &&
      this.pendingRetries === 0
    ) {
      this.flushCallback();
      this.flushCallback = null;
      // Only emit 'alldone' when we actually flush (everything is truly complete)
      this.emit('alldone');
    }
  }

  /**
   * Manages the task queue to enforce rate limiting (1 request/second).
   * Processes tasks sequentially with delays between them.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (task) {
        await task();
        // Rate limit: wait before processing next task if queue is not empty
        if (this.taskQueue.length > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, RATE_LIMIT_DELAY_MS)
          );
        }
      }
    }

    this.isProcessing = false;
    this.checkAndFlush();
  }

  /**
   * Processes a single URL: fetches it, extracts title and email, and outputs the result.
   * @param urlStr The URL to fetch and process.
   * @param isRetry A flag to indicate if this is a retry attempt.
   */
  private async processUrl(urlStr: string, isRetry = false): Promise<void> {
    const output: OutputData = { url: urlStr };

    try {
      const body = await this.fetchOnce(urlStr, isRetry);

      // Parse HTML and extract data
      const root = parse(body);
      const titleElement = root.querySelector('title');
      if (titleElement) {
        const titleText = titleElement.textContent.trim();
        if (titleText) {
          output.title = titleText;
        }
      }

      // Extract email from raw HTML body using regex
      const emailMatch = body.match(EMAIL_REGEX);
      if (emailMatch?.[0]) {
        output.email = this.hashEmail(emailMatch[0]);
      }

      this.push(`${JSON.stringify(output)}\n`);
    } catch (error) {
      if (isRetry) {
        // Final failure after retry - log and output basic info
        process.stderr.write(`[FINAL FAILED] ${urlStr}: ${error}\n`);
        this.push(`${JSON.stringify(output)}\n`);
      } else {
        // First failure - schedule a retry
        this.scheduleRetry(urlStr);
      }
    }
  }

  /**
   * Schedules a retry for a failed URL after a delay.
   * The retry is added to the queue as a new task, allowing other URLs to be processed.
   * @param urlStr The URL that failed and needs to be retried.
   */
  private scheduleRetry(urlStr: string): void {
    const retryDelay =
      process.env.NODE_ENV === 'test' ? RETRY_DELAY_TEST_MS : RETRY_DELAY_MS;
    const retryDelayDisplay =
      retryDelay >= 1000 ? `${retryDelay / 1000}s` : `${retryDelay}ms`;

    process.stderr.write(
      `[RETRY SCHEDULED] ${urlStr} in ${retryDelayDisplay}\n`
    );
    this.pendingRetries++;

    setTimeout(() => {
      this.taskQueue.push(async () => {
        try {
          await this.processUrl(urlStr, true);
        } finally {
          this.pendingRetries--;
        }
      });

      // Resume queue processing to handle the retry task
      this.processQueue();
    }, retryDelay);
  }

  /**
   * Performs a single fetch attempt (no retries).
   * @param urlStr The URL to fetch.
   * @param isRetry A flag to indicate if this is a retry attempt, used for fallback logic.
   * @returns A promise that resolves with the response body as a string.
   */
  private async fetchOnce(urlStr: string, isRetry = false): Promise<string> {
    return this.fetch(urlStr, isRetry);
  }

  /**
   * Performs a single HTTP(S) GET request for the given URL using native fetch.
   * Handles certificate errors by falling back to HTTP on first attempt.
   * @param urlStr The URL to fetch.
   * @param isRetry A flag to indicate if this is a retry attempt, used for fallback logic.
   * @returns A promise that resolves with the response body as a string.
   */
  private async fetch(urlStr: string, isRetry = false): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(urlStr, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'squrly/1.1.0',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`Request Failed. Status Code: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle certificate errors by falling back to HTTP (only on first attempt)
      if (
        !isRetry &&
        urlStr.startsWith('https://') &&
        error instanceof Error &&
        (error.message.includes('certificate') ||
          error.message.includes('cert') ||
          error.name === 'TypeError')
      ) {
        const httpUrl = urlStr.replace('https://', 'http://');
        return this.fetch(httpUrl, true);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Hashes an email address using SHA-256 and the provided secret.
   * @param email The email address to hash.
   * @returns The hexadecimal SHA-256 hash string.
   */
  private hashEmail(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email + this.secret)
      .digest('hex');
  }
}
