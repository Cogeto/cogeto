// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { PROVIDER_TYPES } from '@cogeto/shared';
import type { StoredProviderType } from '@cogeto/shared';
import { ProviderMark } from './ProviderMark';

/**
 * How a provider is recognised (V2.4 item 7.1, issue D).
 *
 *   every_type_renders_a_mark — no provider type is a blank space; the ones
 *     without a vendor file fall through to a labelled placeholder or the
 *     drawn glyph, which are answers rather than gaps.
 *   marks_exist_on_disk — a filename in the component that is not a file in
 *     `public/vendor-marks/` is a broken image nobody notices until an admin
 *     opens the page.
 *   self_hosted_is_drawn_not_borrowed — the rack glyph carries the meaning
 *     ("three companies and one you"), so it must stay an inline SVG in the
 *     design system's line style with no vendor file behind it.
 *   marks_are_legible_in_both_themes — the vendor files are dark-on-
 *     transparent, so they are only visible on the light tile; losing the tile
 *     would make two of the three invisible on the dark surface.
 *   mark_a11y — every mark carries a name, and none conveys anything by
 *     colour alone.
 */

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const ALL_TYPES: StoredProviderType[] = [...PROVIDER_TYPES, 'ollama'];

const render = (type: StoredProviderType): string =>
  renderToStaticMarkup(<ProviderMark type={type} />);

describe('provider marks', () => {
  it('every_type_renders_a_mark: no provider type is a blank space', () => {
    for (const type of ALL_TYPES) {
      const html = render(type);
      const hasImage = html.includes('<img');
      const hasGlyph = html.includes('<svg');
      const hasInitial = />[A-Za-z]<\/span>/.test(html);
      expect(hasImage || hasGlyph || hasInitial, `${type} rendered nothing`).toBe(true);
      // The name always travels with the mark, so a mark nobody recognises is
      // still identified in words.
      expect(html).toContain('title=');
    }
  });

  it('marks_exist_on_disk: every referenced file is really there', () => {
    for (const type of ALL_TYPES) {
      for (const src of [...render(type).matchAll(/src="([^"]+)"/g)].map((m) => m[1]!)) {
        expect(() => readFileSync(path.join(PUBLIC_DIR, src)), `${type} -> ${src}`).not.toThrow();
      }
    }
  });

  it('self_hosted_is_drawn_not_borrowed, and has no tile', () => {
    const html = render('self_hosted');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
    // The tile is what separates a vendor's mark from our own drawing.
    expect(html).not.toContain('bg-white');
    // Same line style as the nav rail's glyph family.
    expect(html).toContain('stroke-width="1.6"');
    // The legacy Ollama type is the same drawing, so an instance seeded from a
    // local runtime does not get a placeholder where a glyph belongs.
    expect(render('ollama')).toContain('<svg');
  });

  it('marks_are_legible_in_both_themes: the vendor tile is light in both', () => {
    for (const type of ['openai', 'anthropic', 'mistral'] as StoredProviderType[]) {
      const html = render(type);
      expect(html, `${type} lost its tile`).toContain('bg-white');
      // No filter trick: the files are used as published.
      expect(html).not.toMatch(/invert|hue-rotate|grayscale/);
    }
  });

  it('mark_a11y: named, and never colour alone', async () => {
    const html = ALL_TYPES.map((type) => render(type)).join('');
    document.body.innerHTML = `<main>${html}</main>`;
    const results = await axe.run(document.body, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
