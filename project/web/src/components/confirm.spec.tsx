// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider, useConfirm } from './confirm';
import { ConfirmDialog, consequenceOf } from './ui';
import type { ConfirmRequest } from './ui';

/**
 * The product's confirmation (issue #528).
 *
 *   confirm_renders_every_field — title, consequence, note and alternative all
 *     reach the screen as their own elements. Under `window.confirm` these
 *     were paragraphs glued with newlines into a browser dialog, and NONE of
 *     this was assertable at all: jsdom implements no `window.confirm`, so the
 *     old tests could only check the string builders.
 *   confirm_destructive_styling — a destructive action gets the red button and
 *     opens focused on Cancel, so the Enter reflex does not delete.
 *   confirm_resolves — the promise resolves true on confirm, false on cancel,
 *     false on Escape, and false on a backdrop click.
 *   confirm_never_strands_a_caller — a second request answers the first as
 *     cancelled rather than leaving it awaiting forever.
 *   confirm_missing_provider_throws — a wiring mistake fails loudly instead of
 *     silently turning every guarded delete into an unguarded one.
 *   confirm_a11y — axe passes, and the dialog carries alertdialog semantics.
 */

const FULL: ConfirmRequest = {
  title: 'Delete the project "Client A"?',
  consequence: 'The project groups 5 things. Deleting removes the project only.',
  note: '2 memories you approved will go with it.',
  alternative: 'Archiving keeps everything instead.',
  confirmLabel: 'Delete',
  destructive: true,
};

/** Mounts into a real jsdom tree so clicks and keys actually run. */
function mount(ui: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {
    host,
    unmount: () => act(() => root.unmount()),
  };
}

const click = (element: Element | null | undefined) =>
  act(() => {
    (element as HTMLElement).click();
  });

const buttonNamed = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('confirm dialog', () => {
  it('confirm_renders_every_field: each part is its own element, not a glued string', () => {
    const html = renderToStaticMarkup(<ConfirmDialog request={FULL} onResolve={() => undefined} />);
    expect(html).toContain('Delete the project &quot;Client A&quot;?');
    expect(html).toContain('The project groups 5 things');
    expect(html).toContain('2 memories you approved will go with it.');
    expect(html).toContain('Archiving keeps everything instead.');
    // The structure the browser dialog could not express: no \n\n anywhere.
    expect(html).not.toContain('\\n\\n');
    // And the button carries a verb, not the browser's "OK".
    expect(html).toContain('>Delete<');
  });

  it('confirm_destructive_styling: red button, and focus starts on Cancel', () => {
    const destructive = renderToStaticMarkup(
      <ConfirmDialog request={FULL} onResolve={() => undefined} />,
    );
    expect(destructive).toContain('bg-red-600');

    const gentle = renderToStaticMarkup(
      <ConfirmDialog request={{ title: 'Ingest again?' }} onResolve={() => undefined} />,
    );
    expect(gentle).not.toContain('bg-red-600');

    // Enter is a reflex; the reflex must not be the one that deletes.
    const { host, unmount } = mount(<ConfirmDialog request={FULL} onResolve={() => undefined} />);
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
    expect(buttonNamed(host, 'Delete')).toBeTruthy();
    unmount();
  });

  it('confirm_resolves: true on confirm, false on cancel, Escape and backdrop', async () => {
    for (const [label, expected] of [
      ['Delete', true],
      ['Cancel', false],
    ] as const) {
      const onResolve = vi.fn();
      const { host, unmount } = mount(<ConfirmDialog request={FULL} onResolve={onResolve} />);
      click(buttonNamed(host, label));
      expect(onResolve).toHaveBeenCalledWith(expected);
      unmount();
    }

    const onEscape = vi.fn();
    const escape = mount(<ConfirmDialog request={FULL} onResolve={onEscape} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onEscape).toHaveBeenCalledWith(false);
    escape.unmount();

    const onBackdrop = vi.fn();
    const backdrop = mount(<ConfirmDialog request={FULL} onResolve={onBackdrop} />);
    click(backdrop.host.querySelector('[aria-hidden="true"]'));
    expect(onBackdrop).toHaveBeenCalledWith(false);
    backdrop.unmount();
  });

  it('confirm_a11y: alertdialog semantics, and axe is clean', async () => {
    const { host, unmount } = mount(<ConfirmDialog request={FULL} onResolve={() => undefined} />);
    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // The question names the dialog and the consequence describes it, so a
    // screen reader announces WHAT is being asked, not just "dialog".
    expect(dialog?.getAttribute('aria-labelledby')).toBe('confirm-title');
    expect(dialog?.getAttribute('aria-describedby')).toBe('confirm-consequence');
    const results = await axe.run(host, {
      rules: { region: { enabled: false }, 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    unmount();
  });
});

describe('legacy confirm copy', () => {
  it('consequenceOf_drops_the_restated_question: no translation had to be rewritten', () => {
    // These strings were written for `window.confirm` and end with a blank
    // line and the question again. The dialog asks it in the title and answers
    // it on the button, so the tail is dropped at the call site instead of by
    // rewording source strings that are genuinely translated into three
    // languages. Every translation preserved the blank line, so the split is
    // language-agnostic.
    expect(consequenceOf('This removes 4 memories. This cannot be undone.\n\nDelete?')).toBe(
      'This removes 4 memories. This cannot be undone.',
    );
    expect(consequenceOf('Entfernt 4 Erinnerungen.\n\nLöschen?')).toBe('Entfernt 4 Erinnerungen.');
    // A string with no tail is returned whole, so a reworded key needs no
    // special casing here.
    expect(consequenceOf('Just the consequence.')).toBe('Just the consequence.');
  });
});

describe('useConfirm', () => {
  function Harness({ onAnswer }: { onAnswer: (answer: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <button type="button" onClick={() => void confirm(FULL).then(onAnswer)}>
        ask
      </button>
    );
  }

  it('confirm_resolves_the_awaited_promise: the call site keeps its one-line guard', async () => {
    const answers: boolean[] = [];
    const { host, unmount } = mount(
      <ConfirmProvider>
        <Harness onAnswer={(answer) => answers.push(answer)} />
      </ConfirmProvider>,
    );
    click(buttonNamed(host, 'ask'));
    // The dialog is rendered by the provider, not by the caller.
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    click(buttonNamed(document.body, 'Delete'));
    await act(async () => undefined);
    expect(answers).toEqual([true]);
    // It closes on answer, so nothing lingers over the page.
    expect(document.querySelector('[role="alertdialog"]')).toBe(null);
    unmount();
  });

  it('confirm_never_strands_a_caller: a second request cancels the first', async () => {
    const answers: boolean[] = [];
    const { host, unmount } = mount(
      <ConfirmProvider>
        <Harness onAnswer={(answer) => answers.push(answer)} />
      </ConfirmProvider>,
    );
    click(buttonNamed(host, 'ask'));
    click(buttonNamed(host, 'ask'));
    await act(async () => undefined);
    // The first promise settled false rather than hanging forever.
    expect(answers).toEqual([false]);
    click(buttonNamed(document.body, 'Cancel'));
    await act(async () => undefined);
    expect(answers).toEqual([false, false]);
    unmount();
  });

  it('confirm_missing_provider_throws: a wiring mistake never becomes an unguarded delete', () => {
    // Rendering without the provider must fail loudly. Resolving true by
    // default would silently remove every confirmation in the app.
    expect(() => renderToStaticMarkup(<Harness onAnswer={() => undefined} />)).toThrow(
      /ConfirmProvider/,
    );
  });
});
