import { Module } from '@nestjs/common';

/**
 * ingestion — the ingest → chunk → extract → verify → embed + store → reconcile
 * pipeline (scope §4.9, Addendum §B.3). Worker-only; arrives with the Notes
 * vertical slice. Shell module until then.
 */
@Module({})
export class IngestionModule {}
