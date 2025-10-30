# URL Parser CLI

A Node.js command-line tool that parses a file or stdin for URLs enclosed in square brackets, fetches them, extracts key information, and outputs the results as JSON.

This project is built with TypeScript and is designed as a hybrid package, meaning it can be run as a CLI and also used as a library in other Node.js projects. It is compatible with both modern ECMAScript Modules (ESM) and older CommonJS (CJS) environments, ensuring broad compatibility across different Node.js versions and project setups. 

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

## Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd url-parser-cli
    ```

2.  Install the dependencies using `pnpm`:
    ```bash
    pnpm install
    ```

3.  Build the project. This compiles the TypeScript source to JavaScript in the `dist/` directory.
    ```bash
    pnpm run build
    ```

## Usage

### Prerequisites

You must set the `IM_SECRET` environment variable. This secret is used to hash the email addresses found.

You can set it in your shell:
```bash
export IM_SECRET="your-super-secret-key"
```
Or, for development, you can create a `.env` file in the project root. An example is provided in `.env.example`.

### Running the Script

The script can be run in two ways:

**1. Processing a File**

Provide the path to a text file as a command-line argument.

```bash
# Using the 'start' script from package.json
pnpm start -- <path/to/your/file.txt>

# Or by executing the compiled script directly
node dist/cli.js <path/to/your/file.txt>
```

**2. Processing from stdin**

If no file path is provided, the script will read from the standard input stream.

```bash
# Pipe a file into the script
cat <path/to/your/file.txt> | pnpm start

# Or pipe an echo command
echo "[www.google.com]" | pnpm start
```

### Output Format

The script outputs a JSON object for each processed URL, one per line.

```json
{"url": "www.page.com", "title": "some title"}
{"url": "www.page1.com", "title": "some other title", "email": "<sha256_hash_of_email>"}
{"url": "www.page2.com"}
```

## Development

### Running Tests

This project uses `vitest` for testing. To run the complete test suite:

```bash
pnpm test
```

This will execute both the unit tests and the end-to-end integration tests.