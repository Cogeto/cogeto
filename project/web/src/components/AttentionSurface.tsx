import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttentionFeedDto, AttentionItem } from '@cogeto/shared';
import { dismissAttentionItem, fetchAttention, markAttentionSeen } from '../api';
import type { Session } from '../auth/oidc';
import { KIND_ICON, groupItems, surfaceState } from './attention-model';

/**
 * The attention-first hero (Post-v1 Priority 2): the first thing on the
 * dashboard, answering "what needs me right now". A dark instrument panel
 * (navy gradient, one sparing teal rim-glow) over the computed attention feed —
 * grouped, human-phrased, every line deep-linking to its object.
 *
 * Unread is honest and calm: viewing the surface clears the indicator (we mark
 * seen on mount and drop the nav badge to zero), while the "new" highlight on
 * each item stays for THIS view so you can see what changed. Digest lines can be
 * dismissed one by one; a live count ("3 items in review") never can.
 */
export function AttentionSurface({ session }: { session: Session }) {
  const qc = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['attention'],
    queryFn: () => fetchAttention(session),
  });

  // Viewing clears the indicator: mark seen once, then zero the nav badge in the
  // cache WITHOUT wiping this view's per-item "new" marks (decision 0039).
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !data) return;
    marked.current = true;
    void markAttentionSeen(session)
      .then((res) => {
        qc.setQueryData<AttentionFeedDto>(['attention'], (old) =>
          old ? { ...old, unreadCount: 0, lastSeenAt: res.lastSeenAt } : old,
        );
      })
      .catch(() => undefined);
  }, [data, qc, session]);

  const dismiss = useMutation({
    mutationFn: (key: string) => dismissAttentionItem(session, key),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['attention'] }),
  });

  const state = surfaceState({
    isPending,
    isError,
    isEmpty: !!data && data.items.length === 0,
  });
  const groups = data ? groupItems(data.items) : [];
  const unread = data?.unreadCount ?? 0;

  return (
    <section
      className="animate-rise overflow-hidden rounded-lg bg-gradient-to-br from-brand-navy via-brand-navy-deep to-brand-navy-900 p-6 text-white shadow-glow ring-1 ring-brand-teal/20"
      aria-labelledby="attention-heading"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="attention-heading" className="text-base font-semibold text-white">
          What needs you right now
        </h2>
        {state === 'ready' && unread > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-teal/15 px-2.5 py-1 text-xs font-semibold text-brand-teal ring-1 ring-brand-teal/40">
            <span aria-hidden="true">●</span>
            {unread} new
          </span>
        )}
      </div>

      {/* Screen readers hear the change politely, once. */}
      <p role="status" aria-live="polite" className="sr-only">
        {state === 'ready'
          ? unread > 0
            ? `${unread} ${unread === 1 ? 'item needs' : 'items need'} your attention`
            : 'Nothing needs your attention right now'
          : ''}
      </p>

      {state === 'loading' && <FeedSkeleton />}
      {state === 'error' && (
        <div className="rounded-md bg-white/5 px-4 py-3 text-sm text-white/80" role="alert">
          <span>We couldn&apos;t load your attention feed just now.</span>{' '}
          <button
            type="button"
            onClick={() => void refetch()}
            className="font-semibold text-brand-teal underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      )}
      {state === 'empty' && (
        <div className="flex items-center gap-3 rounded-md bg-white/[0.04] px-4 py-5 ring-1 ring-white/10">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 place-items-center rounded-full bg-brand-teal/15 text-brand-teal"
          >
            ✓
          </span>
          <div>
            <p className="text-sm font-semibold text-white">Nothing needs you right now</p>
            <p className="text-sm text-white/60">
              Due work, quiet commitments, review items, approvals and last night&apos;s changes
              will surface here.
            </p>
          </div>
        </div>
      )}
      {state === 'ready' && (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.group.key}>
              <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-white/50">
                <span aria-hidden="true" className="text-brand-teal">
                  {g.group.icon}
                </span>
                {g.group.label}
                {g.unread > 0 && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-brand-teal"
                    aria-label={`${g.unread} new`}
                  />
                )}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((item) => (
                  <AttentionRow
                    key={item.key}
                    item={item}
                    onDismiss={item.dismissible ? () => dismiss.mutate(item.key) : undefined}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AttentionRow({ item, onDismiss }: { item: AttentionItem; onDismiss?: () => void }) {
  return (
    <li className="group flex items-center gap-3 rounded-md bg-white/[0.03] px-3 py-2 ring-1 ring-white/5 transition-colors hover:bg-white/[0.07]">
      <span
        aria-hidden="true"
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs ${
          item.unread ? 'bg-brand-teal/20 text-brand-teal' : 'bg-white/10 text-white/60'
        }`}
      >
        {KIND_ICON[item.kind]}
      </span>
      <a href={item.href} className="min-w-0 flex-1 text-sm text-white/90 hover:text-white">
        <span className="underline decoration-white/20 underline-offset-2 group-hover:decoration-brand-teal">
          {item.title}
        </span>
        {item.unread && <span className="sr-only"> (new)</span>}
      </a>
      {typeof item.count === 'number' && (
        <span className="rounded-full bg-white/10 px-1.5 text-xs font-semibold text-white/80">
          {item.count}
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-white/30 transition-colors hover:bg-white/10 hover:text-white/70"
          aria-label={`Dismiss: ${item.title}`}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </li>
  );
}

function FeedSkeleton() {
  return (
    <div
      className="space-y-2"
      role="status"
      aria-busy="true"
      aria-label="Loading your attention feed…"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={`h-9 rounded-md bg-white/[0.06] ${i === 3 ? 'w-2/3' : 'w-full'}`}
          aria-hidden="true"
        />
      ))}
      <span className="sr-only">Loading your attention feed…</span>
    </div>
  );
}
