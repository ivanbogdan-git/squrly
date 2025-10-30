/**
 * @module Main
 * This is the main entry point for the URL Parser CLI application.
 * It reads from a file or stdin, parses URLs, processes them,
 * and outputs the results as JSON strings to stdout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { UrlParser } from './lib/UrlParser.js';
import { UrlProcessor } from './lib/UrlProcessor.js';

/**
 * The main function that orchestrates the CLI application.
 * It performs the following steps:
 * 1. Retrieves a required secret from the environment variables.
 * 2. Initializes the `UrlParser` and `UrlProcessor` transform streams.
 * 3. Determines the input source (a file path from argv or stdin).
 * 4. Sets up a pipeline to stream data from the input, through the
 *    parser and processor, and finally to stdout.
 * 5. Handles errors and stream completion gracefully.
 */
function main() {
  // 1. Get the secret from environment variables
  const secret = process.env.IM_SECRET;
  if (!secret) {
    process.stderr.write(
      'Error: IM_SECRET environment variable is not set.\\n'
    );
    process.exit(1);
  }

  // 2. Initialize our transform streams
  const urlParser = new UrlParser();
  const urlProcessor = new UrlProcessor(secret);

  // 3. Determine the input source (file or stdin)
  // Handle arguments passed via `pnpm start --`
  let filePathArg = process.argv[2];
  if (filePathArg === '--' && process.argv.length > 3) {
    filePathArg = process.argv[3];
  }

  let inputStream: fs.ReadStream | typeof process.stdin;

  if (filePathArg) {
    // Argument provided, read from file
    const filePath = path.resolve(process.cwd(), filePathArg);
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`Error: File not found: ${filePath}\\n`);
      process.exit(1);
    }
    if (fs.statSync(filePath).isDirectory()) {
      process.stderr.write(
        `Error: Path is a directory, not a file: ${filePath}\\n`
      );
      process.exit(1);
    }
    inputStream = fs.createReadStream(filePath);
  } else {
    // No argument, read from stdin
    inputStream = process.stdin;
    process.stdin.setEncoding('utf8');
  }

  // 4. Set up the stream pipeline
  inputStream
    .pipe(urlParser)
    .on('error', (err: Error) => {
      process.stderr.write(`Error in parser: ${err.message}\\n`);
    })
    .pipe(urlProcessor)
    .on('error', (err: Error) => {
      process.stderr.write(`Error in processor: ${err.message}\\n`);
    })
    // Listen for our custom 'alldone' event from the processor
    .on('alldone', () => {
      // This is the definitive signal that all work is complete.
      // We can now safely exit.
      process.exit(0);
    })
    .pipe(process.stdout) // Final output is JSON strings
    .on('error', (err: Error) => {
      // Handle stdout errors (e.g., broken pipe)
      process.stderr.write(`Error writing to stdout: ${err.message}\\n`);
    });

  // The 'end' event will propagate through the pipes automatically.
  // When the input stream ends, it calls .end() on the next, and so on.
}

// Self-executing async function to handle conditional dotenv loading.
(async () => {
  // Conditionally load .env file in non-production environments
  if (process.env.NODE_ENV !== 'production') {
    try {
      await import('dotenv/config');
    } catch (e) {
      // It's a dev dependency, so it might not be there.
      // We can safely ignore this error.
    }
  }

  // Run the main function
  main();
})();
