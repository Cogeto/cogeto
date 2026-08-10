import { useTranslation } from 'react-i18next';
import type { StoredProviderType } from '@cogeto/shared';

/**
 * How a provider is recognised at a glance (V2.4 item 7.1).
 *
 * Three companies and one you, and the icon set says so before the label does:
 * a vendor's own mark for the vendors whose published brand resources make one
 * available for third-party identification, and a **drawn rack glyph** for
 * Self-hosted, in the design system's own line style at the nav rail's stroke
 * weight. That contrast is the point, not a stylistic accident.
 *
 * Where a mark could not be obtained from the owner's own brand or press
 * resource under terms covering this use, there is a **neutral labelled
 * placeholder** and a note in `public/vendor-marks/README.md` saying which
 * brand and why. A placeholder is a correct answer; a redrawn imitation is not,
 * and neither is a copy from a logo aggregator whose provenance and currency
 * cannot be checked.
 *
 * Nothing here implies endorsement, partnership or affiliation. A mark is
 * rendered at icon size beside the provider's own label and never larger or
 * more prominent than Cogeto's own marks.
 */

/**
 * The vendor marks present in `public/vendor-marks/`, black and white as the
 * owner publishes them. Adding one is a file, a row in that README, and a line
 * here. Everything not listed falls through to the placeholder.
 */
const MARK_FILES: Partial<Record<StoredProviderType, { light: string; dark: string }>> = {
  openai: {
    // OpenAI publishes a black and a white Blossom; the theme picks one and
    // no filter is applied to either, which is what "unmodified" means.
    light: '/vendor-marks/openai-blossom-black.svg',
    dark: '/vendor-marks/openai-blossom-white.svg',
  },
};

/** The line style shared with the nav rail's glyph family. */
const G = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function ProviderMark({
  type,
  className = 'h-5 w-5',
}: {
  type: StoredProviderType;
  className?: string;
}) {
  const { t } = useTranslation('providers');
  const label = t(`type.${type}.name`);
  const mark = MARK_FILES[type];

  if (mark) {
    return (
      <span className={`inline-grid shrink-0 place-items-center ${className}`} title={label}>
        <img
          src={mark.light}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-contain dark:hidden"
        />
        <img
          src={mark.dark}
          alt=""
          aria-hidden="true"
          className="hidden h-full w-full object-contain dark:block"
        />
      </span>
    );
  }

  if (type === 'self_hosted' || type === 'ollama') {
    // The rack: two units and their status lamps, drawn rather than borrowed,
    // because there is no company to identify — the hardware is the operator's.
    return (
      <span
        className={`inline-grid shrink-0 place-items-center text-slate-600 ${className}`}
        title={label}
      >
        <svg viewBox="0 0 20 20" {...G} className="h-full w-full" role="img" aria-label={label}>
          <rect x="3.4" y="3.6" width="13.2" height="4.4" rx="1.4" />
          <rect x="3.4" y="12" width="13.2" height="4.4" rx="1.4" />
          <path d="M6 5.8h0.01M6 14.2h0.01" strokeWidth="2" />
          <path d="M9.4 5.8h4.2M9.4 14.2h4.2" opacity="0.6" />
        </svg>
      </span>
    );
  }

  // The neutral placeholder: a quiet chip carrying the provider's initial, with
  // the name always beside it in the surrounding row. Deliberately not a
  // logo-shaped thing.
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-md border border-slate-300 bg-slate-100 text-[0.65rem] font-bold uppercase text-slate-500 ${className}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {label.slice(0, 1)}
    </span>
  );
}
