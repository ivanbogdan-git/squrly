import * as crypto from 'crypto';
import { Readable, Writable } from 'stream';
import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { UrlProcessor } from '../src/lib/UrlProcessor.js';
import type { OutputData } from '../src/lib/types.js';

// --- Mocks ---

// Mock 'crypto' to return a predictable hash
vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => 'hashed-email-result'),
    })),
  })),
}));

/**
 * Helper to simulate a successful fetch response
 */
function mockFetchResponse(
  body: string,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    clone: function () {
      return this;
    },
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'default' as ResponseType,
    url: '',
  } as Response;
}

/**
 * Helper to simulate a fetch error
 */
function mockFetchError(errorMessage: string): Error {
  const error = new Error(errorMessage);
  error.name = 'TypeError'; // fetch typically throws TypeError for network errors
  return error;
}

// --- Test Helper ---

/**
 * Helper function to test the UrlProcessor stream.
 */
function testStreamProcessor(
  processor: UrlProcessor,
  inputs: string[]
): Promise<OutputData[]> {
  return new Promise((resolve) => {
    const readable = Readable.from(inputs);
    const output: string[] = [];

    // Custom writable stream to collect output
    const outputStream = new Writable({
      objectMode: true,
      write(chunk, encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
      final(callback) {
        // This is called when the pipeline is finished
        const results = output.filter(Boolean).map((s) => JSON.parse(s.trim()));
        resolve(results);
        callback();
      },
    });

    readable.pipe(processor).pipe(outputStream);
  });
}

// --- Tests ---

describe('UrlProcessor', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.useRealTimers(); // Use real timers for rate-limit test
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      const body = '<html><head><title>Default Title</title></head></html>';
      return Promise.resolve(mockFetchResponse(body, 200));
    });
    (crypto.createHash as Mock).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch, parse title, and hash email correctly', async () => {
    const body =
      '<html><head><title>Test Title</title></head><body>test@example.com</body></html>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(body, 200)
    );

    const processor = new UrlProcessor('test-secret');
    const results = await testStreamProcessor(processor, ['[www.google.com]']);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      url: 'https://www.google.com',
      title: 'Test Title',
      email: 'hashed-email-result',
    });
  });

  it('should only process the last URL in a bracket', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockFetchResponse('<html><title>B</title></html>', 200)
    );

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.a.com www.b.com]',
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://www.b.com');
    expect(global.fetch).toHaveBeenCalledTimes(1); // Only one call was made
  });

  it('should handle a successful response with a title but no email', async () => {
    const body =
      '<html><head><title>Title Only</title></head><body>No email here.</body></html>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(body, 200)
    );

    const processor = new UrlProcessor('test-secret');
    const results = await testStreamProcessor(processor, [
      '[www.title-only.com]',
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      url: 'https://www.title-only.com',
      title: 'Title Only',
    });
  });

  it('should handle a successful response with no title and no email', async () => {
    const body = '<html><body>Just some content.</body></html>';
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(body, 200)
    );

    const processor = new UrlProcessor('test-secret');
    const results = await testStreamProcessor(processor, ['[www.no-data.com]']);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      url: 'https://www.no-data.com',
    });
  });

  it('should produce no output if no URLs are found', async () => {
    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      'some text without urls',
    ]);
    expect(results).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should de-duplicate URLs', async () => {
    // Relies on the default mock from beforeEach
    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.google.com]',
      '[https://www.google.com]',
    ]);

    expect(results).toHaveLength(1); // Only one output
    expect(global.fetch).toHaveBeenCalledTimes(1); // Only one network request
  });

  it('should enforce 1-second rate limit', async () => {
    // Relies on the default mock from beforeEach
    const processor = new UrlProcessor('secret');
    const startTime = Date.now();

    const results = await testStreamProcessor(processor, [
      '[www.a.com]',
      '[www.b.com]',
    ]);

    const endTime = Date.now();

    expect(results).toHaveLength(2);
    expect(endTime - startTime).toBeGreaterThanOrEqual(1000); // Must take at least 1 sec
  });

  it('should retry once on a 503 error, then succeed', async () => {
    // First call: fail with 503
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse('Server Error', 503))
      // Second call: succeed
      .mockResolvedValueOnce(
        mockFetchResponse('<html><title>Success</title></html>', 200)
      );

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, ['[www.retry.com]']);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Success');
    expect(global.fetch).toHaveBeenCalledTimes(2); // Was called twice
  });

  it('should fail after two 503 errors and log to stderr', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Both calls fail
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockFetchResponse('Server Error', 503))
      .mockResolvedValueOnce(mockFetchResponse('Server Error', 503));

    // Set NODE_ENV to test to get shorter retry delay
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, ['[www.fail.com]']);

    // Restore NODE_ENV
    process.env.NODE_ENV = originalEnv;

    expect(results).toHaveLength(1); // Still outputs the base {url: '...'}
    expect(results[0].title).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2); // Was called twice
    // Check for retry scheduled message (with test delay)
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[RETRY SCHEDULED] https://www.fail.com in 10ms')
    );
    // Check for final failure message
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[FINAL FAILED] https://www.fail.com')
    );

    stderrSpy.mockRestore();
  });

  it('should fall back to http on a certificate error', async () => {
    // 1. Mock HTTPS to fail with a cert error (TypeError is what fetch throws)
    vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(mockFetchError('certificate verify failed'))
      // 2. Mock HTTP to succeed
      .mockResolvedValueOnce(
        mockFetchResponse('<html><title>HTTP Success</title></html>', 200)
      );

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.cert-fail.com]',
    ]);

    // 3. Assert the fallback worked
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('HTTP Success');
    expect(results[0].url).toBe('https://www.cert-fail.com'); // URL is still the original
    expect(global.fetch).toHaveBeenCalledTimes(2); // HTTPS failed, then HTTP succeeded
    // Verify it tried HTTPS first, then HTTP
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://www.cert-fail.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'squrly/1.1.0',
        }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://www.cert-fail.com',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'squrly/1.1.0',
        }),
      })
    );
  });
});
