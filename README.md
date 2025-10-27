# URL Parser CLI

A Node.js command-line script to parse a text file or `stdin` for URLs, fetch them, and process the results.

## Features

- Parses URLs from within `[]` brackets, including complex nested/escaped cases.
- Fetches URLs with rate-limiting (1/sec) and one-time retry on failure.
- Parses `<title>` and email addresses from the response.
- Hashes the first found email with `IM_SECRET`.
- Zero runtime dependencies.
- Dual CJS/ESM build.

## Installation

```sh
# Clone the repository
git clone https://github.com/your-username/url-parser-cli.git
cd url-parser-cli

# Install dependencies (pnpm is enforced)
pnpm install
```

## Usage

### From a file

```sh
# Set the secret for email hashing
export IM_secret='your-secret-here'

# Run the script against a file
pnpm start ./path/to/your-file.txt
```

### From stdin

```sh
# Set the secret
export IM_secret='your-secret-here'

# Pipe content into the script
echo "some text [[www.google.com](https://www.google.com)] and [[www.bing.com](https://www.bing.com)]" | pnpm start
```

## Development

### Build

```sh
pnpm build
```

### Test

```sh
pnpm test
```

### Lint/Format

```sh
pnpm check  # Uses Biome
```