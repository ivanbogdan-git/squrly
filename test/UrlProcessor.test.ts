import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
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

// Mock the 'http' and 'https' modules
vi.mock('http', () => ({
  get: vi.fn(),
}));
vi.mock('https', () => ({
  get: vi.fn(),
}));

// Mock 'crypto' to return a predictable hash
vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => 'hashed-email-result'),
    })),
  })),
}));

// Create a mock stream for the response
class MockResponse extends Readable {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;

  constructor(body: string, statusCode = 200, headers = {}) {
    super();
    this.body = body;
    this.statusCode = statusCode;
    this.headers = headers;
  }

  _read() {
    this.push(this.body);
    this.push(null); // Signal end
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setEncoding() {}
}

/**
 * Helper to simulate a response from http.get or https.get
 */
function mockResponse(
  client: Mock,
  body: string,
  statusCode = 200,
  headers: { [key: string]: string } = {}
) {
  client.mockImplementationOnce((options, callback) => {
    const res = new MockResponse(body, statusCode, headers);
    callback(res);
    return { on: vi.fn(), end: vi.fn() };
  });
}

/**
 * Helper to simulate a network error from http.get or https.get
 */
function mockError(client: Mock, errorMessage: string) {
  client.mockImplementationOnce(() => {
    const req = {
      on: vi.fn((event, cb) => {
        if (event === 'error') {
          // Simulate the error event being emitted
          cb(new Error(errorMessage));
        }
      }),
      end: vi.fn(),
    };
    return req;
  });
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
    (https.get as Mock).mockReset();
    (http.get as Mock).mockReset();
    (crypto.createHash as Mock).mockClear();

    // Default mock implementation
    (https.get as Mock).mockImplementation((options, callback) => {
      const body = '<html><head><title>Default Title</title></head></html>';
      callback(new MockResponse(body, 200));
      return { on: vi.fn(), end: vi.fn() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should fetch, parse title, and hash email correctly', async () => {
    const body =
      '<html><head><title>Test Title</title></head><body>test@example.com</body></html>';
    mockResponse(https.get as Mock, body, 200);

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
    mockResponse(https.get as Mock, '<html><title>B</title></html>', 200);

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.a.com www.b.com]',
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://www.b.com');
    expect((https.get as Mock).mock.calls).toHaveLength(1); // Only one call was made
  });

  it('should handle a successful response with a title but no email', async () => {
    const body =
      '<html><head><title>Title Only</title></head><body>No email here.</body></html>';
    mockResponse(https.get as Mock, body, 200);

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
    mockResponse(https.get as Mock, body, 200);

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
    expect((https.get as Mock).mock.calls).toHaveLength(0);
  });

  it('should de-duplicate URLs', async () => {
    // Relies on the default mock from beforeEach
    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.google.com]',
      '[https://www.google.com]',
    ]);

    expect(results).toHaveLength(1); // Only one output
    expect((https.get as Mock).mock.calls).toHaveLength(1); // Only one network request
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
    mockResponse(https.get as Mock, 'Server Error', 503);
    // Second call: succeed
    mockResponse(https.get as Mock, '<html><title>Success</title></html>', 200);

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, ['[www.retry.com]']);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Success');
    expect((https.get as Mock).mock.calls).toHaveLength(2); // Was called twice
  });

  it('should fail after two 503 errors and log to stderr', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    // Both calls fail
    mockResponse(https.get as Mock, 'Server Error', 503);
    mockResponse(https.get as Mock, 'Server Error', 503);

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, ['[www.fail.com]']);

    expect(results).toHaveLength(1); // Still outputs the base {url: '...'}
    expect(results[0].title).toBeUndefined();
    expect((https.get as Mock).mock.calls).toHaveLength(2); // Was called twice
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch https://www.fail.com')
    );

    stderrSpy.mockRestore();
  });

  it('should fall back to http on a certificate error', async () => {
    // 1. Mock HTTPS to fail with a cert error
    mockError(https.get as Mock, 'some certificate error');

    // 2. Mock HTTP to succeed
    mockResponse(
      http.get as Mock, // Note: http.get
      '<html><title>HTTP Success</title></html>',
      200
    );

    const processor = new UrlProcessor('secret');
    const results = await testStreamProcessor(processor, [
      '[www.cert-fail.com]',
    ]);

    // 3. Assert the fallback worked
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('HTTP Success');
    expect(results[0].url).toBe('https://www.cert-fail.com'); // URL is still the original
    expect(https.get as Mock).toHaveBeenCalledTimes(1);
    expect(http.get as Mock).toHaveBeenCalledTimes(1);
  });
});
