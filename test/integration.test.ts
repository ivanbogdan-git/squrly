import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutputData } from '../src/lib/types.js';

const SCRIPT_PATH = path.resolve(__dirname, '../dist/cli.js');
const TEST_FILE_PATH = path.resolve(__dirname, 'test-input.txt');
const SECRET = 'integration-test-secret';

// --- Mock Server ---
let server: http.Server;
const serverResponses: Record<string, { status: number; body: string }> = {};

beforeAll(() => {
  server = http
    .createServer((req, res) => {
      const url = req.url?.slice(1); // Remove leading '/'
      if (url && serverResponses[url]) {
        const { status, body } = serverResponses[url];
        res.writeHead(status, { 'Content-Type': 'text/html' });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    })
    .listen(8080);
});

afterAll(() => {
  server.close();
  if (fs.existsSync(TEST_FILE_PATH)) {
    fs.unlinkSync(TEST_FILE_PATH);
  }
});

/**
 * Helper to run the CLI script as a child process.
 * @param args - Array of command-line arguments.
 * @param stdinData - Optional string to pipe to stdin.
 * @returns A promise that resolves with the stdout and stderr.
 */
function runScript(
  args: string[],
  stdinData?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const command = `node ${SCRIPT_PATH} ${args.join(' ')}`;
    const child = exec(command, {
      env: { ...process.env, IM_SECRET: SECRET }, // NODE_ENV will be included from process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }

    child.on('close', () => {
      resolve({ stdout, stderr });
    });
  });
}

describe('CLI Integration Tests', () => {
  it('should process a file correctly and output valid JSON', async () => {
    // 1. Setup mock server responses
    serverResponses['www.google.com'] = {
      status: 200,
      body: '<html><head><title>Google</title></head><body>search@google.com</body></html>',
    };
    serverResponses['www.example.com'] = {
      status: 200,
      body: '<html><head><title>Example Domain</title></head></html>',
    };
    serverResponses['www.no-title.com'] = {
      status: 200,
      body: '<html><body>no-reply@no-title.com</body></html>',
    };

    // 2. Create test input file
    const fileContent = `
      This is some text with ignored urls like www.ingemark.com.
      Here is a valid one: [http://localhost:8080/www.google.com]
      This one has nesting: [level1 [level2] http://localhost:8080/www.example.com]
      This one should be ignored due to escape: \\[http://localhost:8080/www.ignored.com]
      This one has no title tag: [http://localhost:8080/www.no-title.com]
      Duplicate url should be ignored: [http://localhost:8080/www.google.com]
    `;
    fs.writeFileSync(TEST_FILE_PATH, fileContent);

    // 3. Run the script
    const { stdout, stderr } = await runScript([TEST_FILE_PATH]);

    // 4. Assertions
    expect(stderr).toBe('');
    const results = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(results).toHaveLength(3);

    // Calculate expected hashes dynamically to avoid test data errors.
    const expectedEmailHashGoogle = crypto
      .createHash('sha256')
      .update(`search@google.com${SECRET}`)
      .digest('hex');
    const expectedEmailHashNoTitle = crypto
      .createHash('sha256')
      .update(`no-reply@no-title.com${SECRET}`)
      .digest('hex');

    expect(results).toContainEqual({
      url: 'http://localhost:8080/www.google.com',
      title: 'Google',
      email: expectedEmailHashGoogle,
    });
    expect(results).toContainEqual({
      url: 'http://localhost:8080/www.example.com',
      title: 'Example Domain',
    });
    expect(results).toContainEqual({
      url: 'http://localhost:8080/www.no-title.com',
      email: expectedEmailHashNoTitle,
    });
  }, 10000); // Increase timeout for integration test

  it('should process stdin correctly and output valid JSON', async () => {
    // 1. Setup mock server responses
    serverResponses['www.stdin-test.com'] = {
      status: 200,
      body: '<html><head><title>Stdin Test</title></head></html>',
    };

    // 2. Define stdin data
    const stdinData =
      'Some streamed text [http://localhost:8080/www.stdin-test.com] coming from stdin.';

    // 3. Run the script with no arguments, piping data to stdin
    const { stdout, stderr } = await runScript([], stdinData);

    // 4. Assertions
    expect(stderr).toBe('');
    const results = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(results).toHaveLength(1);

    expect(results[0]).toEqual({
      url: 'http://localhost:8080/www.stdin-test.com',
      title: 'Stdin Test',
    });
  }, 10000);

  it('should handle retries and log to stderr on final failure', async () => {
    // 1. Setup mock server responses
    // This URL will fail once, then succeed
    const retryUrl = 'www.retry.com';
    serverResponses[retryUrl] = { status: 503, body: 'Service Unavailable' };
    setTimeout(() => {
      serverResponses[retryUrl] = {
        status: 200,
        body: '<html><title>Retry Success</title></html>',
      };
    }, 50); // Succeed shortly after the first attempt

    // This URL will fail twice
    const failUrl = 'www.fail.com';
    serverResponses[failUrl] = { status: 500, body: 'Internal Server Error' };

    // 2. Define input data
    const inputData = `
      [http://localhost:8080/${retryUrl}]
      [http://localhost:8080/${failUrl}]
    `;

    // 3. Run the script
    // NOTE: We shorten the retry delay via env var for the test
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const { stdout, stderr } = await runScript([], inputData);
    process.env.NODE_ENV = originalEnv;

    // 4. Assertions
    // Check stderr for the retry scheduled message
    expect(stderr).toContain(
      '[RETRY SCHEDULED] http://localhost:8080/www.fail.com in 10ms'
    );
    // Check stderr for the final failure log
    expect(stderr).toContain(
      '[FINAL FAILED] http://localhost:8080/www.fail.com'
    );
    // Ensure no error was logged for the successful retry
    expect(stderr).not.toContain('www.retry.com');

    // Check stdout for the results
    const results = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(results).toHaveLength(2);

    // The retry URL should have its full data
    expect(results).toContainEqual({
      url: `http://localhost:8080/${retryUrl}`,
      title: 'Retry Success',
    });

    // The failed URL should only have its URL
    expect(results).toContainEqual({
      url: `http://localhost:8080/${failUrl}`,
    });
  }, 10000);
});
