/**
 * Error sanitization for logs and the dead_letter ledger (FIX-3 QS-22).
 *
 * A `ModelGatewayError` can embed Zod validation fragments — and Zod's enum /
 * literal messages quote the RECEIVED value, which is raw model output (e.g.
 * "Invalid enum value ... received 'maybe'"). That value must never reach a log
 * line or the `dead_letter.error` column in plaintext. `describeError` reduces
 * any error to its class + a scrubbed, length-capped message; `scrubMessage`
 * strips the "received <value>" fragments and caps length.
 */

const MAX_MESSAGE_CHARS = 400;

/** Remove Zod "received <value>" fragments (raw model output) and cap length. */
export function scrubMessage(message: string): string {
  return (
    message
      // received "x" / 'x' / `x` / bareword — the value is model output.
      .replace(/received\s+("[^"]*"|'[^']*'|`[^`]*`|\S+)/gi, 'received [redacted]')
      .slice(0, MAX_MESSAGE_CHARS)
  );
}

/** Class + scrubbed message; never the stack or any extra error properties. */
export function describeError(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    return { type: error.name || error.constructor.name, message: scrubMessage(error.message) };
  }
  return { type: 'Unknown', message: scrubMessage(String(error)) };
}

/** One-line "Class: scrubbed message" — for the dead_letter.error column + top-level catches. */
export function describeErrorLine(error: unknown): string {
  const { type, message } = describeError(error);
  return `${type}: ${message}`;
}
