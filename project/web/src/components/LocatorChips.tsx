import { useTranslation } from 'react-i18next';
import type { ReadLocator } from '@cogeto/shared';

/**
 * A fact's located span, rendered per format the way each is actually useful
 * (V2.2 item 5.2): page and tier for documents, paragraph for flowed text,
 * sheet and A1 cell range for spreadsheets. Locators are DATA; every visible
 * word resolves through the `sources:locator.*` value-to-key maps, so no
 * English travels from the server.
 *
 * `locators === null` renders the honest absence: for a note/chat/email/web
 * span there is no finer position than the source itself (nothing shows), and
 * for a file fact admitted before locators were persisted the caller shows
 * the "no location recorded" line instead.
 */
export function LocatorChips({ locators }: { locators: ReadLocator[] }) {
  const { t } = useTranslation('sources');
  if (locators.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {locators.map((locator, i) => (
        <span
          key={i}
          className="rounded border border-slate-300 bg-surface px-1.5 py-0.5 font-mono text-[0.66rem] tracking-[0.03em] text-slate-600"
        >
          {label(t, locator)}
        </span>
      ))}
    </span>
  );
}

function label(t: (key: string, opts?: Record<string, unknown>) => string, l: ReadLocator): string {
  switch (l.kind) {
    case 'page':
      // A page read by OCR or a vision model is weaker evidence than a text
      // layer; the tier is stated on the chip, never flattened away.
      return l.tier && l.tier !== 'text'
        ? t('locator.pageWithTier', { page: l.page, tier: t(`read.tier.${l.tier}`) })
        : t('locator.page', { page: l.page });
    case 'paragraph':
      return t('locator.paragraph', { paragraph: l.paragraph });
    case 'sheet_row':
      return l.sheet === null
        ? t('locator.row', { range: l.cellRange, row: l.row })
        : t('locator.sheetRange', { sheet: l.sheet, range: l.cellRange });
    case 'document':
      return t('locator.document');
  }
}
