import { MAX_CHAT_ATTACHMENTS } from '@cogeto/shared';

/**
 * Staging files on the chat composer (issue #584): the decision, separated
 * from the React state and the copy so it can be tested on its own, the way
 * `conversations-model` and `projects-model` are.
 *
 * The rules are all about NOT losing what the user already had:
 *
 * - Each file is judged on its own. One unsupported file in a multi-select or
 *   a drag does not reject the batch, and never clears what is already staged.
 * - The cap is STATED. Dropping six files with four allowed attaches four and
 *   says so; silently keeping the first four is the same bug as truncating a
 *   list without a "N more".
 * - Refusals name the file. With one file "unsupported type" is clear; with
 *   five it is a guess.
 */

/** One file staged for the next send, with its own remembered/transient choice. */
export interface PendingFile {
  file: File;
  transient: boolean;
  /** Stable across re-renders so removing one cannot reorder the rest. */
  key: string;
}

export interface StageOutcome {
  /** Files to append to what is already staged. */
  accepted: PendingFile[];
  /** `${name}: ${reason}` for each file that cannot be attached. */
  refused: string[];
  /** True when at least one otherwise-valid file did not fit under the cap. */
  capReached: boolean;
}

/** A file's identity for React keys: name, size and mtime together. */
export const pendingKey = (file: File): string => `${file.name}:${file.size}:${file.lastModified}`;

export function stageAttachments(
  staged: readonly PendingFile[],
  incoming: readonly File[],
  validate: (file: File) => string | null,
  cap: number = MAX_CHAT_ATTACHMENTS,
): StageOutcome {
  const accepted: PendingFile[] = [];
  const refused: string[] = [];
  let capReached = false;

  for (const file of incoming) {
    const problem = validate(file);
    if (problem) {
      refused.push(`${file.name}: ${problem}`);
      continue;
    }
    // Checked AFTER validation: an unsupported file must not consume a slot,
    // or dropping junk would block the good file behind it.
    if (staged.length + accepted.length >= cap) {
      capReached = true;
      continue;
    }
    accepted.push({ file, transient: false, key: pendingKey(file) });
  }
  return { accepted, refused, capReached };
}

/**
 * Does this drag carry FILES?
 *
 * A drag of selected TEXT fires the same events, and claiming it would stop
 * the browser dropping that text into the textarea, which is a thing people
 * do. `types` is the only part of a DataTransfer readable during a drag: the
 * files themselves are not exposed until the drop.
 */
export const dragHasFiles = (transfer: DataTransfer | null | undefined): boolean =>
  !!transfer && [...transfer.types].includes('Files');
