import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { eq, inArray, isNull, not, and } from 'drizzle-orm';
import { SourceContextStore, SourceRevisionStore } from '../ingestion/index';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { IMPORT_IN_FLIGHT } from './import-jobs';
import { ImportCoordinator } from './import-coordinator';
import { ImportService } from './import.service';
import { ImportsController } from './imports.controller';
import { ZipUploadInterceptor, IMPORT_ZIP_MAX_BYTES } from './zip-upload.interceptor';
import { importItem } from './persistence/tables';

/**
 * imports — bulk import (V2.2 item 5.3): the manifest, the queued ingestion
 * coordinator, and the import record. A capture-orchestration context: it
 * owns `import_run` + `import_item` and reaches every other module through
 * its public interface (files' upload path, memory's stores, ingestion's
 * anchoring/revision reads). The app registers the controller + service; the
 * worker registers the coordinator.
 */
@Module({})
export class ImportsModule {
  static register(
    options: { zipMaxBytes?: number; imports?: ModuleMetadata['imports'] } = {},
  ): DynamicModule {
    return {
      module: ImportsModule,
      imports: [...(options.imports ?? [])],
      controllers: [ImportsController],
      providers: [
        ImportService,
        ZipUploadInterceptor,
        ...(options.zipMaxBytes !== undefined
          ? [{ provide: IMPORT_ZIP_MAX_BYTES, useValue: options.zipMaxBytes }]
          : []),
      ],
      exports: [ImportService],
    };
  }

  /** The worker-side slice: the coordinator plus its collaborators. */
  static forWorker(options: {
    inFlight?: number;
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: ImportsModule,
      imports: [...(options.imports ?? [])],
      providers: [
        ImportCoordinator,
        SourceRevisionStore,
        SourceContextStore,
        ...(options.inFlight !== undefined
          ? [{ provide: IMPORT_IN_FLIGHT, useValue: options.inFlight }]
          : []),
      ],
      exports: [ImportCoordinator],
    };
  }
}

/**
 * Deletion coverage for import items (V2.2 item 5.3, issue D2): an item row
 * names a file, so when its ingested SOURCE is erased the row is TOMBSTONED —
 * the name cleared (no orphaned filename survives a provable deletion), the
 * outcome kept as arithmetic so the record's counts stay honest. Returns 0:
 * nothing is removed, and receipts count removals.
 */
@Injectable()
export class ImportItemCascade implements DerivedCascade {
  readonly artifact = 'import_items';

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    if (sourceType !== 'file') return 0;
    await tx
      .update(importItem)
      .set({ name: null, state: 'tombstoned', updatedAt: new Date() })
      .where(
        and(
          eq(importItem.objectKey, sourceId),
          not(inArray(importItem.state, ['tombstoned'])),
          not(isNull(importItem.objectKey)),
        ),
      );
    return 0;
  }
}

/** Own module, the cascade-family precedent: table access only. */
@Module({
  providers: [ImportItemCascade],
  exports: [ImportItemCascade],
})
export class ImportItemCascadeModule {}
