/**
 * Name-conflict resolution, shared by upload, rename, move and folder creation so that all
 * four behave identically. One resolver means a user who learns the rule in one place knows
 * it everywhere.
 */

export const NAME_ATTEMPT_LIMIT = 100;

export type ConflictStrategy =
  /** Refuse and let the UI ask the user. */
  | 'fail'
  /** Keep both by appending a counter. */
  | 'rename'
  /** Files only: add a version to the existing file instead of creating a node. */
  | 'newVersion';

export interface SplitName {
  stem: string;
  /** Includes the leading dot, or empty when the name has no extension. */
  extension: string;
}

/**
 * Splits on the last dot.
 *
 * A leading dot is part of the stem: `.env` has no extension, and treating "env" as one
 * would rename the file to `. (2)env`. Compound extensions are not special-cased —
 * `archive.tar.gz` becomes `archive.tar (2).gz`, which is predictable and reversible.
 * Recognising `.tar.gz` would start a list of exceptions that never ends.
 */
export function splitName(name: string): SplitName {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) };
}

/**
 * Returns the candidate for a given attempt: attempt 1 is the name as typed, attempt 2 is
 * `name (2)`, and so on.
 *
 * The counter is always **appended**; existing parentheses are never interpreted. Reading
 * `Report (2024).pdf` as "counter 2024" and producing `Report (2025).pdf` would silently
 * change what the document claims to be — the kind of failure nobody notices until it
 * matters. Appending is loud and reversible.
 */
export function nameForAttempt(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const { stem, extension } = splitName(name);
  return `${stem} (${attempt})${extension}`;
}
