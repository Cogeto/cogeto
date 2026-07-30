// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { Nav } from './Nav';

/**
 * The primary navigation rail.
 *
 * Both assertions here are regression guards for the same failure mode: a
 * sidebar redesign quietly removing something an operator depends on.
 *
 *   nav_shows_version — the running version is rendered. It was dropped by the
 *     redesign that moved identity into the rail, which left the build-time
 *     `__APP_VERSION__` define with no consumer at all, so "check the version
 *     in the nav" (the runbook's own upgrade verification step) had nothing to
 *     read for three releases.
 *   nav_pins_to_viewport — the rail is pinned to the viewport rather than
 *     stretched over the document. Without this, Sign out sits at the bottom
 *     of a long page instead of on screen.
 *   nav_a11y — axe passes on the rendered rail.
 */

/** The canonical version, read the same way vite.config.ts injects it. */
const version = (
  JSON.parse(
    readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

// isDemoSession() reads sessionStorage, which jsdom provides; unset means a
// real session, so the Sign out button renders.
const html = renderToStaticMarkup(
  <Nav active="dashboard" showSystem userName="Ana Kovac" orgName="Cogeto" />,
);

describe('nav_shows_version', () => {
  it('renders the build-time version alongside the session controls', () => {
    expect(html).toContain(`v${version}`);
    expect(html).toContain('Cogeto version');
  });

  it('keeps Sign out, which the version line must not displace', () => {
    expect(html).toContain('Sign out');
  });
});

describe('nav_pins_to_viewport', () => {
  const rail = /<nav[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';

  it('is sticky at the top of the viewport, not stretched over the document', () => {
    // self-start defeats the flex parent's default stretch; without it the
    // rail is as tall as the page and sticky has nowhere to travel.
    for (const cls of ['sticky', 'top-0', 'h-screen', 'self-start']) {
      expect(rail.split(/\s+/), `nav is missing "${cls}"`).toContain(cls);
    }
  });

  it('lets the section list scroll on its own when it outgrows the rail', () => {
    expect(html).toMatch(/<ul[^>]*class="[^"]*overflow-y-auto/);
  });
});

describe('nav_a11y', () => {
  it('axe passes on the rendered rail', async () => {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const results = await axe.run(host);
      const summary = results.violations
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)
        .join('\n');
      expect(results.violations, summary).toEqual([]);
    } finally {
      host.remove();
    }
  });
});
