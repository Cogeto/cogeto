import { spawn } from 'node:child_process';

/**
 * Running one of the local reading tools (V2.1 item 4.1): poppler for
 * rendering, Tesseract for OCR.
 *
 * Bytes in over stdin, bytes out over stdout, nothing on disk. That is a
 * deliberate property rather than a convenience: a scanned contract that
 * becomes a temporary file is a copy of the document somewhere nobody is
 * tracking, outside the object store, outside the deletion saga, and outside
 * every promise this product makes about erasure.
 *
 * `spawn` rather than `execFile` because only spawn gives us a writable stdin,
 * and every invocation is bounded three ways: a wall-clock timeout, a ceiling
 * on collected output, and no shell anywhere (arguments are an array, so
 * nothing a filename contains can become a command).
 */

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export class BinaryRunError extends Error {
  constructor(
    message: string,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BinaryRunError';
  }
}

export interface RunOptions {
  input?: Buffer;
  timeoutMs: number;
  /** Hard ceiling on stdout; exceeding it kills the child. */
  maxOutputBytes: number;
}

export async function runBinary(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let collected = 0;
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new BinaryRunError(`${command} did not finish within ${options.timeoutMs} ms`, 'timeout'),
        ),
      );
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      collected += chunk.length;
      if (collected > options.maxOutputBytes) {
        child.kill('SIGKILL');
        finish(() =>
          reject(
            new BinaryRunError(
              `${command} produced more than ${options.maxOutputBytes} bytes`,
              'output too large',
            ),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded: a broken tool can be noisy, and the message is for a log line.
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      finish(() =>
        reject(
          new BinaryRunError(
            `${command} could not be started: ${error.message}`,
            'not executable',
            error,
          ),
        ),
      );
    });

    child.on('close', (code) => {
      finish(() => resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim(), code }));
    });

    if (options.input) {
      // A tool that exits early (a bad page, a refused file) closes its stdin
      // while we are still writing; that EPIPE is the tool's exit code's story
      // to tell, not a separate failure.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** True when the binary exists and answers. Used to report a tier as available. */
export async function binaryAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await runBinary(command, args, { timeoutMs: 5_000, maxOutputBytes: 1 << 20 });
    return result.code === 0;
  } catch {
    return false;
  }
}
