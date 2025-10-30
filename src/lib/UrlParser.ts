import { Transform } from 'stream';
import type { TransformCallback } from 'stream';

/**
 * A Transform stream that parses chunks of text, identifying content
 * within valid, top-level square brackets `[]`, respecting escape characters `\`.
 *
 * It correctly handles nested brackets and unclosed/irregular brackets.
 * It emits each fully matched bracketed content as a separate chunk.
 *
 * @example
 * // Input: "abc [123] def [456 [inner] \]]"
 * // Output (chunks): "[123]", "[456 [inner] \]]"
 */
export class UrlParser extends Transform {
  private buffer = '';
  private bracketLevel = 0;
  private currentContent = '';
  private isEscaped = false;

  /**
   * Constructs a new UrlParser instance.
   */
  constructor() {
    // Set highWaterMark to 1 for byte-by-byte processing to handle streams.
    // objectMode: false, as we are reading/writing strings/buffers.
    super({ readableObjectMode: true, writableHighWaterMark: 1 });
  }

  /**
   * Processes each chunk of data from the input stream, character by character,
   * to identify and extract content enclosed in top-level square brackets.
   * @param chunk The chunk of data to transform (string or buffer).
   * @param encoding The encoding of the chunk.
   * @param callback A function to call when processing is complete for the chunk.
   */
  _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const str = chunk.toString();

    for (const char of str) {
      if (this.isEscaped) {
        // If we are in an escaped state, add the character
        // to the current content (if we are inside brackets)
        // and reset the escape flag.
        if (this.bracketLevel > 0) {
          this.currentContent += char;
        }
        this.isEscaped = false;
      } else if (char === '\\') {
        // Enter escaped state.
        this.isEscaped = true;
        // Add the escape character itself if we're inside brackets.
        // This preserves it for the output, e.g., "[\\]"
        if (this.bracketLevel > 0) {
          this.currentContent += char;
        }
      } else if (char === '[') {
        this.bracketLevel++;
        // If this is the *first* level bracket, start capturing.
        if (this.bracketLevel === 1) {
          this.currentContent = '[';
        } else {
          // This is a nested bracket, just append it.
          this.currentContent += char;
        }
      } else if (char === ']') {
        if (this.bracketLevel > 0) {
          this.currentContent += char;
          this.bracketLevel--;

          // If we just closed the *outermost* bracket,
          // we have a complete match. Push it to the readable side
          // and reset for the next match.
          if (this.bracketLevel === 0) {
            this.push(this.currentContent);
            this.currentContent = '';
          }
        }
        // If bracketLevel is 0, this is an unmatched closing bracket,
        // so we ignore it.
      } else {
        // Any other character.
        if (this.bracketLevel > 0) {
          this.currentContent += char;
        }
      }
    }

    callback();
  }

  /**
   * Called when the input stream ends. This method ensures that any
   * content from unclosed brackets is discarded, as it does not form a
   * complete, valid match.
   * @param callback A function to call when the flush operation is complete.
   */
  _flush(callback: TransformCallback): void {
    // If the stream ends and bracketLevel is not 0,
    // it means there was an unclosed bracket. We discard
    // this.currentContent by not pushing it.
    callback();
  }
}
