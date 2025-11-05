import * as crypto from 'crypto';
import { Transform } from 'stream';
import { parse } from 'node-html-parser';
import type { OutputData } from './types.js';

/**
 * Defines the structure for our JSON output.
 * We are not exporting this, as OutputData is the public type.
 */
interface ParsedOutput {
  url: string;
  title?: string;
  email?: string;
}

// Define a type for the callback used by the _flush method
type FlushCallback = (error?: Error | null) => void;

// This is a more robust regex that handles standard domains, localhost with ports,
// and optional paths, without being overly greedy.
const LAST_URL_REGEX =
  /(?:https?:\/\/)?(?:localhost(?::\d+)?|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})(?:\/[^\s]*)?/g;

// Simple regex for the first email
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
   * to finish before we signal that we are done.
   */
  _flush(callback: FlushCallback): void {
    // If we're not busy and the queue is empty, we're done now.
    if (this.taskQueue.length === 0 && !this.isProcessing) {
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
   * Manages the task queue to enforce a 1 request/second rate limit.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (task) {
        await task();
        // Wait 1 second before processing the next item,
        // but only if there are more tasks still in the queue.
        if (this.taskQueue.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    this.isProcessing = false;

    if (this.flushCallback) {
      this.flushCallback();
      this.flushCallback = null;
    }
    // Signal that all processing is complete.
    this.emit('alldone');
  }

  /**
   * The core logic for processing a single URL.
   * This is called by the queue manager.
   * @param urlStr The URL to fetch and process.
   */
  private async processUrl(urlStr: string): Promise<void> {
    const output: OutputData = { url: urlStr };

    try {
      const body = await this.fetchWithRetry(urlStr);

      // Parse the HTML using node-html-parser
      const root = parse(body);

      // Extract title from the <title> tag
      const titleElement = root.querySelector('title');
      if (titleElement) {
        const titleText = titleElement.textContent.trim();
        if (titleText) {
          output.title = titleText;
        }
      }

      // Extract email from the raw HTML body using regex
      // This maintains backward compatibility with the original regex-based approach
      // while still benefiting from the HTML parser for title extraction
      const emailMatch = body.match(EMAIL_REGEX);
      if (emailMatch?.[0]) {
        output.email = this.hashEmail(emailMatch[0]);
      }
    } catch (error) {
      // Fetch failed twice, log to stderr and output basic info
      process.stderr.write(`Failed to fetch ${urlStr}: ${error}\n`);
    }

    // Push the JSON result as a string
    this.push(`${JSON.stringify(output)}\n`);
  }

  /**
   * Fetches a URL, retrying once on failure after a delay.
   * @param urlStr The URL to fetch.
   * @param isRetry A flag to indicate if this is the retry attempt.
   * @returns A promise that resolves with the response body as a string.
   */
  private fetchWithRetry(urlStr: string, isRetry = false): Promise<string> {
    return new Promise((resolve, reject) => {
      this.fetch(urlStr)
        .then(resolve) // Success
        .catch(async (error) => {
          if (isRetry) {
            return reject(error);
          }

          // --- KEEP THIS ---
          // This check IS correct. We only want a short delay for
          // the *retry* test, not the rate-limit test.
          const retryDelay = process.env.NODE_ENV === 'test' ? 10 : 60000;
          await new Promise((r) => setTimeout(r, retryDelay));
          // --- END KEEP THIS ---

          this.fetch(urlStr, true).then(resolve).catch(reject);
        });
    });
  }

  /**
   * Performs a single HTTP(S) GET request for the given URL using native fetch.
   * @param urlStr The URL to fetch.
   * @param isRetry A flag to indicate if this is a retry attempt, used for fallback logic.
   * @returns A promise that resolves with the response body as a string.
   */
  private async fetch(urlStr: string, isRetry = false): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const response = await fetch(urlStr, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'squrly/1.1.0',
        },
        redirect: 'follow', // Follow redirects automatically (default limit is ~20)
      });

      if (!response.ok) {
        throw new Error(`Request Failed. Status Code: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle certificate errors by falling back to HTTP
      // This preserves the original behavior for self-signed certificates
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
