import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskDto } from '@cogeto/shared';
import { fetchTasks, taskOperation } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';

const STATUS_STYLE: Record<TaskDto['status'], string> = {
  open: 'bg-brand-teal/15 text-brand-teal',
  blocked_on_condition: 'bg-amber-100 text-amber-700',
  done: 'bg-slate-200 text-slate-500',
  dismissed: 'bg-slate-200 text-slate-500',
};

function TaskItem({ session, task }: { session: Session; task: TaskDto }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const op = useMutation({
    mutationFn: (operation: 'reopen' | 'dismiss' | 'complete') =>
      taskOperation(session, task.id, operation),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const settled = task.status === 'done' || task.status === 'dismissed';

  return (
    <li className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <p className="text-sm text-slate-800">{task.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_STYLE[task.status]}`}>
          {task.status.replace(/_/g, ' ')}
        </span>
        {task.conditionText && !task.conditionMet && (
          <span className="text-amber-700">waiting: {task.conditionText}</span>
        )}
        {task.due && (
          <span className="text-slate-500">due {new Date(task.due).toLocaleDateString()}</span>
        )}
        {task.dormant && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">quiet</span>
        )}
        {task.fromUncertain && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-600">unconfirmed</span>
        )}
        {task.primaryPerson && <span className="text-slate-400">· {task.primaryPerson}</span>}
        <span className="ml-auto flex gap-1">
          {settled ? (
            <button
              type="button"
              onClick={() => op.mutate('reopen')}
              className="rounded border border-slate-300 px-2 py-0.5 text-slate-600"
            >
              Reopen
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => op.mutate('complete')}
                className="rounded bg-brand-teal px-2 py-0.5 font-semibold text-white"
              >
                Done
              </button>
              <button
                type="button"
                onClick={() => op.mutate('dismiss')}
                className="rounded border border-slate-300 px-2 py-0.5 text-slate-600"
              >
                Dismiss
              </button>
            </>
          )}
        </span>
        <span className="text-slate-400" title={task.createdAt}>
          {timeAgo(task.createdAt)}
        </span>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </li>
  );
}

/**
 * Deliberately provisional (decision 0013; the real Tasks UI is O2 per
 * docs/handoff/F3-tasks.md): a plain list over GET /api/tasks with the three
 * audited operations. Enough to see and steer the engine, nothing more.
 */
export function Tasks({ session }: { session: Session }) {
  const [includeSettled, setIncludeSettled] = useState(false);
  const { data, isPending, isError } = useQuery({
    queryKey: ['tasks', includeSettled],
    queryFn: () => fetchTasks(session, { includeSettled }),
  });

  return (
    <Shell session={session} title="Tasks (provisional)" active="tasks">
      <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
        Debug surface — the full Tasks experience (reminders, digest, filters) ships with O2.
      </p>
      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={includeSettled}
          onChange={(e) => setIncludeSettled(e.target.checked)}
        />
        Show done &amp; dismissed
      </label>
      {isPending && <p className="text-sm text-slate-400">Loading tasks…</p>}
      {isError && <p className="text-sm text-red-600">Could not load tasks.</p>}
      {data && data.length === 0 && (
        <section className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Nothing here — commitments and open loops you capture become tasks automatically.
        </section>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((task) => (
            <TaskItem key={task.id} session={session} task={task} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
