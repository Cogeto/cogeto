import { Module } from '@nestjs/common';

/**
 * agents — the server-side approval state machine (Addendum §A.8):
 * draft → pending_approval → approved → executed (+ rejected, expired).
 * Only the worker executes. Shell module until the approval slice.
 */
@Module({})
export class AgentsModule {}
