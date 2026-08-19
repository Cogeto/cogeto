// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../locales/en/users.json';
import { instanceNavFor } from '../components/InstanceShell';
import { Nav } from '../components/Nav';

/**
 * The operator Users page (issue #638).
 *
 * The page's whole reason to exist is one irreversible act, so the guards here
 * are about the two things that make it safe to hand to someone:
 *
 *   users_warns_about_its_limits — the page states, in the copy itself, that
 *     it lists only people who have signed in, that it only erases data, and
 *     that accounts live in Zitadel. None of the three is guessable from the
 *     screen, and a redesign that quietly drops the warning leaves an
 *     administrator believing a partial list is complete.
 *   users_is_admin_only — the section is hidden from the rail for anyone
 *     without the operator role, exactly as System and Audit are. The server's
 *     AdminGuard stays the enforcement; this is the display half.
 */

describe('users_warns_about_its_limits', () => {
  it('states all three limits, and names Zitadel as where accounts are managed', () => {
    // Asserted against the COPY rather than a render, because these are
    // claims about what the page tells a person, and the copy is where a
    // translator or a redesign would weaken them.
    expect(en.limits.signedInOnly).toMatch(/signed in at least once/i);
    expect(en.limits.signedInOnly).toMatch(/never logged in/i);
    expect(en.limits.erasesOnly).toMatch(/only erases data/i);
    expect(en.limits.erasesOnly).toMatch(/cannot create an account/i);
    expect(en.limits.accountsElsewhere).toMatch(/Zitadel/);
    // Both directions of the independence, because getting either wrong is
    // how someone thinks a job is finished when half of it is not.
    expect(en.limits.accountsElsewhere).toMatch(/does not close their account/i);
    expect(en.limits.accountsElsewhere).toMatch(/does not erase their data/i);
  });

  it('tells the administrator the act cannot be undone before they confirm', () => {
    expect(en.preview.irreversible).toMatch(/cannot be undone/i);
  });

  it('states the shared-material rule where the decision is made', () => {
    expect(en.preview.sharedRule).toMatch(/never erased/i);
    // And the case the preview cannot count, said plainly rather than omitted.
    expect(en.preview.sharedRule).toMatch(/fact that came out of it/i);
  });
});

describe('users_is_admin_only', () => {
  // The operator surfaces moved from the rail to the instance area
  // (docs/features/spaces.md section 3): the space-scoped sidebar may hold
  // only surfaces that change with the switcher, so the display half of the
  // admin gate now lives in the instance area's nav. Same rule, new location;
  // the server's AdminGuard stays the enforcement.
  it('hides the section from a member and shows it to an operator', () => {
    expect(instanceNavFor(false)).not.toContain('users');
    expect(instanceNavFor(true)).toContain('users');
  });

  it('sits with the other operator surfaces, not among the everyday ones', () => {
    const admin = instanceNavFor(true);
    // If Users ever renders while System does not, the admin gate has been
    // applied to one and not the other.
    expect(admin).toContain('system');
    expect(admin).toContain('audit');
  });

  it('never returns to the space-scoped rail, whatever the role', () => {
    const railFor = (isAdmin: boolean) =>
      renderToStaticMarkup(
        <Nav active="dashboard" showSystem={isAdmin} userName="Ana" orgName="Cogeto" />,
      );
    expect(railFor(true)).not.toContain('/users');
    expect(railFor(false)).not.toContain('/users');
  });
});
