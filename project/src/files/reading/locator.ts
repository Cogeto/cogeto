/**
 * The locator vocabulary and resolution moved to `@cogeto/shared` (V2.2 item
 * 5.2): the Sources surface and the findings report consume locators from
 * OUTSIDE this module (ingestion persists them at admission), and shared is
 * the one leaf everything may read without a cycle. This re-export keeps every
 * reader-internal import site and the files barrel exactly as they were.
 */
export type {
  ReadGranularity,
  PageLocator,
  ParagraphLocator,
  SheetRowLocator,
  DocumentLocator,
  ReadLocator,
  ReadSegment,
} from '@cogeto/shared';
export { describeLocator, locateSpan } from '@cogeto/shared';
