# 🐿️ Squrly

[![NPM Version](https://img.shields.io/npm/v/squrly)](https://www.npmjs.com/package/squrly)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![NPM Downloads](https://img.shields.io/npm/dm/squrly)](https://www.npmjs.com/package/squrly)

A Node.js command-line tool that parses a file or stdin for URLs enclosed in square brackets, fetches them, extracts key information, and outputs the results as JSON.

This project is built with TypeScript and is designed as a hybrid package, meaning it can be run as a CLI and also used as a library in other Node.js projects. It is compatible with both modern ECMAScript Modules (ESM) and older CommonJS (CJS) environments, ensuring broad compatibility across different Node.js versions and project setups.

## Usage

There are two primary ways to use `squrly`: as a global command-line tool or as a library in your own project.

### 1. As a Global CLI Tool

This is the most common way to use `squrly`. You install it once and can run it from anywhere on your system.

**Installation**

```bash
npm install -g squrly
```

**Usage**

First, ensure the required `IM_SECRET` environment variable is set:

```bash
export IM_SECRET="your-secret-key"
```

Then, you can run the command by piping data to it or providing a file path.

```bash
# Process from stdin
echo "[https://www.google.com]" | squrly

# Process from a file
squrly path/to/your/file.txt
```

### 2. As a Library in a Node.js Project

You can also use `squrly` as a dependency to build more complex data pipelines.

**Installation**

```bash
npm install squrly
```

**Usage**

You can import and use the `UrlParser` and `UrlProcessor` transform streams in your code.

```javascript
import { UrlParser, UrlProcessor } from 'squrly';
import { Readable } from 'stream';

// Set the required secret
process.env.IM_SECRET = 'your-secret-key';

// Create a source stream
const inputStream = Readable.from([
  'Some text with a url [https://www.google.com]',
]);

// Instantiate the streams
const urlParser = new UrlParser();
const urlProcessor = new UrlProcessor();

// Pipe them together and listen for data
inputStream
  .pipe(urlParser)
  .pipe(urlProcessor)
  .on('data', (chunk) => {
    const processedData = JSON.parse(chunk.toString());
    console.log(processedData);
    // => { url: 'https://www.google.com', title: 'Google' }
  });
```

## Features

- Parses URLs from a file or `stdin`.
- Extracts the *last* URL from within valid `[]` brackets.
- Handles nested brackets and escaped `\\[` characters.
- Fetches URLs with a 1 request/second rate limit.
- Retries failed requests once after a 60-second delay.
- Extracts the `<title>` and the first email address from the response body.
- Hashes the found email using a secret key (`IM_SECRET`).
- De-duplicates URLs to process each unique URL only once.
- Outputs results as a stream of newline-delimited JSON objects.

## Development Setup

If you wish to contribute to or modify this project, follow these steps.

### Prerequisites

You must set the `IM_SECRET` environment variable. For development, you can create a `.env` file in the project root.

```
IM_SECRET=your-dev-secret
```

### Installation & Building

1.  Clone the repository:
    ```bash
    git clone https://github.com/ivanbogdan-git/squrly.git
    cd squrly
    ```

2.  Install the dependencies using `pnpm`:
    ```bash
    pnpm install
    ```

3.  Build the project. This compiles the TypeScript source to JavaScript in the `dist/` directory.
    ```bash
    pnpm run build
    ```

### Running the Script Locally

The script can be run in two ways:

**1. Processing a File**

Provide the path to a text file as a command-line argument.

```bash
# Using the 'start' script from package.json
pnpm start -- <path/to/your/file.txt>
```

**2. Processing from stdin**

If no file path is provided, the script will read from the standard input stream.

```bash
# Pipe a file into the script
cat <path/to/your/file.txt> | pnpm start
```

### Running Tests

This project uses `vitest` for testing. To run the complete test suite:

```bash
pnpm test
```