/**
 * Defines the structure for the final JSON output for each processed URL.
 */
export interface OutputData {
  /** The URL that was processed. */
  url: string;
  /** The title extracted from the HTML <title> tag of the URL. */
  title?: string;
  /** A SHA-256 hash of the first email address found on the page. */
  email?: string;
}
