import { Injectable } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { FileReadReportStore } from './persistence/file-read-report';

/**
 * Deletion coverage for the file read report (V2.1 item 4.1).
 *
 * The row holds sheet names, which are the document's own words, so it is
 * content-bearing and a content-bearing table the saga does not reach is a
 * regression against the product's central promise (spec §11.1). It joins the
 * cascade the way every other derived artifact does: memory defines
 * `DerivedCascade`, the module that OWNS the table implements it, the
 * composition root binds it, and the saga never names another module's table.
 *
 * Only the by-source leg applies. A read report describes a SOURCE, not any
 * particular memory: it exists before the first fact is admitted, it exists
 * when zero facts were admitted (the honest "nothing readable here" case), and
 * it must go when its source goes, which `cascadeForSource` guarantees for the
 * primary source and for every cascaded member (an email's attachments).
 */
@Injectable()
export class FileReadReportCascade implements DerivedCascade {
  readonly artifact = 'file_read_reports';

  constructor(private readonly reports: FileReadReportStore) {}

  async cascadeForMemories(): Promise<number> {
    // A read report is not derived from a memory; erasing one memory of a file
    // says nothing about the file's read. The by-source leg covers this table.
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    if (sourceType !== 'file') return 0;
    return this.reports.deleteForSources(tx, [sourceId]);
  }
}
