import { BadRequestException, Injectable } from '@nestjs/common';
import { MemoryStore } from '../memory/index';
import type { ActionDefinition } from './action-types';
import { buildBulkOutdateAction } from './actions/bulk-outdate.action';
import { buildEmailReplyDraftAction } from './actions/email-reply-draft.action';

@Injectable()
export class ActionRegistry {
  private readonly byType: Map<string, ActionDefinition>;

  constructor(memory: MemoryStore) {
    const definitions: ActionDefinition[] = [
      buildBulkOutdateAction(memory) as ActionDefinition,
      // Email reply draft (O4): finalise-only, no sending (roadmap O4).
      buildEmailReplyDraftAction() as ActionDefinition,
      // Future actions (bulk delete, …) register here.
    ];
    this.byType = new Map(definitions.map((d) => [d.actionType, d]));
  }

  get(actionType: string): ActionDefinition {
    const def = this.byType.get(actionType);
    if (!def) throw new BadRequestException(`unknown action type '${actionType}'`);
    return def;
  }

  /** Parses the stored/raw payload against the action's schema (throws on mismatch). */
  parse(actionType: string, raw: unknown): unknown {
    const def = this.get(actionType);
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(
        `invalid payload for '${actionType}': ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return parsed.data;
  }
}
