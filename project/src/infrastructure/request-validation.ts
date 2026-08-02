import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validate a request body or query at the boundary, or 400 with the schema's
 * own messages (V2.0 item 3.7).
 *
 * Zod at every boundary is the rule (AGENTS.md), and eighteen controllers spelled
 * the adaptation out identically:
 *
 * ```ts
 * const parsed = schema.safeParse(body);
 * if (!parsed.success) {
 *   throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
 * }
 * ```
 *
 * One definition, byte-identical behaviour: the same joiner, the same order,
 * the same exception, so no response body changes. `timeline.controller.ts` had
 * already extracted exactly this privately; this is that helper, hoisted.
 *
 * Deliberately NOT a Nest pipe: a pipe would move validation off the call site
 * and into decorator metadata, and the controllers here read better with the
 * schema named beside the handler that owns it.
 *
 * The controllers that throw a FIXED message instead ("body must be { key }")
 * are left alone: they answer differently, and a shared helper with a flag to
 * make it answer both ways would be the merge this repository does not want.
 */
export function parseOrBadRequest<T>(schema: ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}
