// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { Nav } from '../components/Nav';
import { Review } from './Review';
import type { Session } from '../auth/oidc';

/**
 * The Review surface after V2.0 item 3.3.
 *
 * The uncertain queue is gone: those facts are resolved automatically, demoted
 * in retrieval, framed softly in answers, and explained in the suppressed-fact
 * log, with no human step anywhere. What is left on this page is
 * contradictions, which are surfaced rather than queued.
 *
 *   no_uncertain_queue — the surface exposes no uncertain adjudication path.
 *   badge_counts_contradictions_only — the nav badge counts conflicts alone.
 */

const session = { accessToken: 'test-token' } as unknown as Session;

/** Rendered with an empty, non-fetching client: the markup is what we assert. */
const render = (node: React.ReactElement): string => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
};

describe('no_uncertain_queue', () => {
  const html = render(<Review session={session} />);

  it('offers no tab strip, because one queue needs no tabs', () => {
    expect(html).not.toContain('Uncertain');
    expect(html).not.toMatch(/role="tab"/);
  });

  it('offers no approve or reject action for an extracted fact', () => {
    // The two verbs of the old queue. Confirming a fact is still possible, from
    // the fact's own drawer, where its evidence is in front of you.
    expect(html).not.toContain('>Approve<');
    expect(html).not.toContain('>Reject<');
  });

  it('names itself for what it now holds', () => {
    expect(html).toContain('Contradictions');
    expect(html).not.toContain('awaits review');
    expect(html).not.toContain('review queue');
  });

  it('keeps the contradiction empty state, which is the surface it still serves', () => {
    // The query is disabled here, so the empty state is not rendered; what must
    // hold is that nothing else claims the page.
    expect(html).not.toContain('Nothing awaits review');
  });
});

describe('badge_counts_contradictions_only', () => {
  it('labels the nav entry and its badge for contradictions', () => {
    const html = renderToStaticMarkup(<Nav active="review" reviewCount={3} showSystem={false} />);
    expect(html).toContain('Contradictions');
    expect(html).toContain('open contradictions');
    // The count itself still renders: contradictions ARE a chore list, and the
    // one Cogeto is allowed to keep.
    expect(html).toContain('3');
    expect(html).not.toContain('items to review');
  });

  it('shows no badge when there are no contradictions', () => {
    const html = renderToStaticMarkup(<Nav active="review" reviewCount={0} showSystem={false} />);
    expect(html).not.toContain('open contradictions');
  });
});
