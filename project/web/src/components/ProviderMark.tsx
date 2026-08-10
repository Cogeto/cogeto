import { useTranslation } from 'react-i18next';
import type { StoredProviderType } from '@cogeto/shared';

/**
 * How a provider is recognised at a glance (V2.4 item 7.1).
 *
 * Three companies and one you, and the icon set says so before the label does:
 * each vendor's own mark, and a **drawn rack glyph** for Self-hosted in the
 * design system's own line style. That contrast is the point, not a stylistic
 * accident, which is why the glyph is deliberately not given a tile.
 *
 * **The marks are used unmodified.** No recolouring, no restyling, no cropping,
 * no `invert()` filter. Two of the three are published as a single dark-on-
 * transparent file, which would vanish on the dark surface, so every vendor mark
 * is rendered on a **constant light tile** in both themes. A background is not a
 * modification, and "use on a light background" is what the brand guidance asks
 * for in the first place; it is also the one treatment that works identically
 * for all three, so the set reads as one system rather than three exceptions.
 *
 * Provenance and terms for every file: `public/vendor-marks/README.md`.
 * Nothing here implies endorsement, partnership or affiliation.
 */

/**
 * The vendor marks in `public/vendor-marks/`. Adding one is a file, a row in
 * that README, and a line here; anything not listed falls through to the
 * neutral placeholder, which is a correct answer rather than a gap.
 */
const MARK_FILES: Partial<Record<StoredProviderType, string>> = {
  openai: '/vendor-marks/openai-blossom-black.svg',
  anthropic: '/vendor-marks/anthropic-icon.png',
  mistral: '/vendor-marks/mistral-icon.png',
};

/** The line style shared with the nav rail's glyph family. */
const G = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * The tile every vendor mark sits on. White in both themes, with a hairline so
 * it has an edge against the light surface too, and an inset so no glyph runs
 * to the border.
 */
const TILE =
  'inline-grid shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-white p-1.5 dark:border-slate-300/20';

export function ProviderMark({
  type,
  className = 'h-10 w-10',
}: {
  type: StoredProviderType;
  /** Sized to the label it sits beside; the default matches a two-line row. */
  className?: string;
}) {
  const { t } = useTranslation('providers');
  const label = t(`type.${type}.name`);
  const mark = MARK_FILES[type];

  if (mark) {
    return (
      <span className={`${TILE} ${className}`} title={label}>
        <img src={mark} alt="" aria-hidden="true" className="h-full w-full object-contain" />
      </span>
    );
  }

  if (type === 'self_hosted' || type === 'ollama') {
    // The rack: two units and their status lamps, drawn rather than borrowed,
    // because there is no company to identify. Authored in a 40-unit viewBox so
    // a 1.6 stroke renders at the same optical weight the nav rail's glyphs
    // have at their own size, rather than doubling when the icon grows.
    return (
      <span
        className={`inline-grid shrink-0 place-items-center text-slate-500 ${className}`}
        title={label}
      >
        <svg viewBox="0 0 40 40" {...G} className="h-full w-full" role="img" aria-label={label}>
          <rect x="5" y="7" width="30" height="11" rx="2.6" />
          <rect x="5" y="22" width="30" height="11" rx="2.6" />
          <path d="M10.5 12.5h0.01M10.5 27.5h0.01" strokeWidth="2.6" />
          <path d="M17 12.5h13M17 27.5h13" opacity="0.55" />
        </svg>
      </span>
    );
  }

  // The neutral placeholder: a quiet tile carrying the provider's initial, with
  // the name always beside it in the surrounding row. Deliberately not a
  // logo-shaped thing.
  return (
    <span
      className={`inline-grid shrink-0 place-items-center rounded-lg border border-slate-300 bg-slate-100 text-base font-bold uppercase text-slate-500 ${className}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {label.slice(0, 1)}
    </span>
  );
}
