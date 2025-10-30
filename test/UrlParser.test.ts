import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import { UrlParser } from '../src/lib/UrlParser.js';

/**
 * Helper function to test the UrlParser stream.
 * It creates a Readable stream from an array of chunks,
 * pipes it through UrlParser, and collects the output.
 */
function testStreamParser(chunks: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const readable = Readable.from(chunks, { highWaterMark: 1 });

    const parser = new UrlParser();

    const output: string[] = [];

    parser.on('data', (data) => {
      output.push(data.toString());
    });

    parser.on('end', () => {
      resolve(output);
    });

    parser.on('error', (err) => {
      reject(err);
    });

    readable.pipe(parser);
  });
}

describe('UrlParser', () => {
  it('should find a simple URL in brackets', async () => {
    const input = ['text [www.google.com] more text'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.google.com]']);
  });

  it('should ignore URLs not in brackets', async () => {
    const input = ['text www.google.com more text'];
    const output = await testStreamParser(input);
    expect(output).toEqual([]);
  });

  it('should find multiple URLs in separate brackets', async () => {
    const input = ['[www.a.com] text [www.b.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.a.com]', '[www.b.com]']);
  });

  it('should handle brackets split across multiple chunks', async () => {
    const input = ['text [www.go', 'ogle.com] more', ' text [www.b.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.google.com]', '[www.b.com]']);
  });

  it('should correctly handle nested brackets (outermost wins)', async () => {
    const input = ['[level1 [level2] www.google.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[level1 [level2] www.google.com]']);
  });

  it('should ignore escaped brackets', async () => {
    const input = ['\\[www.google.com] text [www.bing.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.bing.com]']);
  });

  it('should handle escaped escape characters (no special rule)', async () => {
    // Per the spec: "it does not escape other escape characters"
    // So \\[ means the first \ escapes the second \, and the [ is real.
    // --- FIX: Use 4 backslashes to create a literal `\\[` string ---
    const input = ['text \\\\[www.google.com] more text'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.google.com]']);
  });

  it('should ignore unmatched closing brackets', async () => {
    const input = ['text ] [www.google.com] ] more text'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.google.com]']);
  });

  it('should ignore unclosed opening brackets at end of stream', async () => {
    const input = ['[www.a.com] text [www.b.com'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.a.com]']);
  });

  it('should handle complex mixed case', async () => {
    const input = [
      'level1 [www.a.com [www.b.com]] text \\[www.c.com] [www.d.com]',
    ];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.a.com [www.b.com]]', '[www.d.com]']);
  });

  it('should handle escaped closing bracket inside', async () => {
    const input = ['[a.com \\] b.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[a.com \\] b.com]']);
  });

  it('should handle escaped bracket at end of chunk', async () => {
    const input = ['[a.com \\', '] b.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[a.com \\] b.com]']);
  });

  it('should handle prompt example: asdf \\\\[www.google.com]', async () => {
    // `\\` -> escaped backslash.
    // `[` -> real bracket.
    // Result: `\[www.google.com]` is output.
    const input = ['asdf \\\\[www.google.com]'];
    const output = await testStreamParser(input);
    expect(output).toEqual(['[www.google.com]']);
  });
});
