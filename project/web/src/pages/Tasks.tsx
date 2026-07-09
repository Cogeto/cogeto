import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskDto } from '@cogeto/shared';
import { fetchTasks, taskOperation } from '../api';
import type { Session } from '../auth/oidc';
import { MemoryDrawer } from '../components/MemoryDrawer';
import { Shell } from '../components/Shell';
import { dueLabel, timeAgo } from '../components/status';

type View = 'open' | 'done' | 'dismissed';

/** Reads ?open=<memory id> so digest task lines can deep-link a deriving fact. */
function openedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

function TaskRow({
  session,
  task,
  onOpenMemory,
}: {
  session: Session;
  task: TaskDto;
  onOpenMemory: (memoryId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const op = useMutation({
    mutationFn: (operation: 'reopen' | 'dismiss' | 'complete') =>
      taskOperation(session, task.id, operation),
    onSuccess: async () => {
      setError(null);
      // Lists, the nav badge, and the digest all reflect the settle at once.
      await queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const settled = task.status === 'done' || task.status === 'dismissed';
  const due = task.due ? dueLabel(task.due) : null;
  const blocked = task.status === 'blocked_on_condition';

  return (
    <li
      className={`rounded-lg border bg-white p-3 shadow-sm ${
        task.fromUncertain ? 'border-amber-200' : 'border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {task.primaryPerson && (
              <span className="font-medium text-slate-600">{task.primaryPerson}</span>
            )}
            {task.entities
              .filter((e) => e !== task.primaryPerson)
              .map((entity) => (
                <span key={entity} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                  {entity}
                </span>
              ))}
            {due && !settled && (
              <span className={due.overdue ? 'font-semibold text-red-600' : 'text-slate-500'}>
                {due.text}
              </span>
            )}
            {task.dormant && !settled && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                gone quiet
              </span>
            )}
            {task.fromUncertain && (
              <a
                href="/review"
                className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 no-underline"
                title="Derived from a memory still awaiting your review"
              >
                unconfirmed
              </a>
            )}
          </div>
          {blocked && task.conditionText && !task.conditionMet && (
            <p className="mt-1 text-xs text-amber-700">waiting on {task.conditionText}</p>
          )}
          {settled && task.closedByMemoryId && (
            <p className="mt-1 text-xs text-slate-400">
              closed{' '}
              <button
                type="button"
                onClick={() => onOpenMemory(task.closedByMemoryId!)}
                className="underline decoration-slate-300 underline-offset-2 hover:text-brand-teal"
              >
                by this memory
              </button>{' '}
              · {timeAgo(task.updatedAt)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-1">
            {settled ? (
              <button
                type="button"
                disabled={op.isPending}
                onClick={() => op.mutate('reopen')}
                className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-40"
              >
                Reopen
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={op.isPending}
                  onClick={() => op.mutate('complete')}
                  className="rounded bg-brand-teal px-2 py-0.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Done
                </button>
                <button
                  type="button"
                  disabled={op.isPending}
                  onClick={() => op.mutate('dismiss')}
                  className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 disabled:opacity-40"
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenMemory(task.derivedFromMemoryId)}
            className="text-xs text-slate-400 underline decoration-slate-300 underline-offset-2 hover:text-brand-teal"
          >
            deriving memory
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

/**
 * The Tasks surface (O2-A; docs/handoff/F3-tasks.md §4) — replaces the
 * provisional panel. Tasks are DERIVED from your commitments (§4.7): there is
 * no create form. Row actions map only to the three audited engine operations
 * (reopen / dismiss / complete). Views split by status; the remaining filters
 * refine the Open list client-side.
 */
export function Tasks({ session }: { session: Session }) {
  const [view, setView] = useState<View>('open');
  const [entity, setEntity] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [dormantOnly, setDormantOnly] = useState(false);
  const [unconfirmedOnly, setUnconfirmedOnly] = useState(false);
  const [openMemory, setOpenMemory] = useState<string | null>(openedFromUrl);

  const status = view === 'open' ? undefined : view;
  const { data, isPending, isError } = useQuery({
    queryKey: ['tasks', view, entity],
    queryFn: () => fetchTasks(session, { status, entity }),
  });

  const openDrawer = (memoryId: string | null) => {
    setOpenMemory(memoryId);
    window.history.replaceState(null, '', memoryId ? `/tasks?open=${memoryId}` : '/tasks');
  };

  // Open-view refinements (F3 §4): due window, dormant-only, unconfirmed.
  const rows = (data ?? []).filter((t) => {
    if (view !== 'open') return true;
    if (dueOnly && !t.due) return false;
    if (dormantOnly && !t.dormant) return false;
    if (unconfirmedOnly && !t.fromUncertain) return false;
    return true;
  });

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-semibold ${
      active ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`;

  return (
    <Shell session={session} title="Tasks" active="tasks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex w-fit gap-1 rounded-lg bg-slate-200/70 p-1">
          <button
            type="button"
            className={tabClass(view === 'open')}
            onClick={() => setView('open')}
          >
            Open
          </button>
          <button
            type="button"
            className={tabClass(view === 'done')}
            onClick={() => setView('done')}
          >
            Done
          </button>
          <button
            type="button"
            className={tabClass(view === 'dismissed')}
            onClick={() => setView('dismissed')}
          >
            Dismissed
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
        <input
          type="search"
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          placeholder="Filter by person or entity…"
          className="w-56 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
        {view === 'open' && (
          <>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={dueOnly}
                onChange={(e) => setDueOnly(e.target.checked)}
              />
              Has due date
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={dormantOnly}
                onChange={(e) => setDormantOnly(e.target.checked)}
              />
              Gone quiet
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={unconfirmedOnly}
                onChange={(e) => setUnconfirmedOnly(e.target.checked)}
              />
              Unconfirmed
            </label>
          </>
        )}
      </div>

      {isPending && <p className="text-sm text-slate-400">Loading tasks…</p>}
      {isError && <p className="text-sm text-red-600">Could not load tasks.</p>}

      {data && rows.length === 0 && (
        <section className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          {view === 'open' ? (
            <>
              <p className="font-medium text-slate-600">Nothing is still open.</p>
              <p className="mt-1">
                Tasks aren’t typed by hand — commitments you capture (“I’ll send Luka the offer”)
                become tasks automatically, derived from your memory.
              </p>
            </>
          ) : (
            'None yet.'
          )}
        </section>
      )}

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((task) => (
            <TaskRow key={task.id} session={session} task={task} onOpenMemory={openDrawer} />
          ))}
        </ul>
      )}

      {openMemory && (
        <MemoryDrawer
          session={session}
          memoryId={openMemory}
          onClose={() => openDrawer(null)}
          onNavigate={openDrawer}
        />
      )}
    </Shell>
  );
}
