import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDto } from '@cogeto/shared';
import {
  createConversation,
  deleteSource,
  fetchConversations,
  fetchDeletionImpact,
  renameConversation,
  setConversationArchived,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterSourceDeletion } from '../query-invalidation';
import { timeAgo } from './status';
import {
  conversationLabel,
  conversationPreview,
  deleteConversationConfirm,
  splitConversations,
} from './conversations-model';

/**
 * The conversations sidebar (P6.9, decision 0056): workspaces over one memory.
 * Create, switch, rename inline, archive to a collapsed section, and delete,
 * where deletion is the SOURCE deletion through the saga, confirmed with the
 * preview's real numbers and archive named as the safe alternative.
 */

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}

function Row({
  session,
  conversation,
  active,
  onSelect,
  onDeleted,
}: {
  session: Session;
  conversation: ConversationDto;
  active: boolean;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['conversations'] });
  const rename = useMutation({
    mutationFn: (title: string) => renameConversation(session, conversation.id, title),
    onSuccess: () => {
      setEditing(false);
      void refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => setConversationArchived(session, conversation.id, archived),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const preview = await fetchDeletionImpact(session, 'chat_conversation', conversation.id);
      const message = deleteConversationConfirm(conversationLabel(conversation), preview);
      if (!window.confirm(message)) return null;
      return deleteSource(session, 'chat_conversation', conversation.id);
    },
    onSuccess: (result) => {
      if (!result) return;
      void invalidateAfterSourceDeletion(queryClient);
      void refresh();
      onDeleted(conversation.id);
    },
  });

  const label = conversationLabel(conversation);
  const preview = conversationPreview(conversation);

  return (
    <li
      className={`group rounded-lg border transition-colors ${
        active
          ? 'border-brand-teal/40 bg-brand-teal/10'
          : 'border-transparent hover:border-slate-200 hover:bg-surface'
      }`}
    >
      {editing ? (
        <form
          className="flex items-center gap-1.5 px-2.5 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            const title = draft.trim();
            if (title) rename.mutate(title);
          }}
        >
          <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
            Conversation title
          </label>
          <input
            id={`rename-${conversation.id}`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
            }}
            maxLength={120}
            className="w-full rounded border border-slate-300 bg-surface px-1.5 py-0.5 text-sm text-slate-800 outline-none focus:border-brand-teal"
          />
          <button
            type="submit"
            disabled={rename.isPending || !draft.trim()}
            className="text-xs font-semibold text-brand-teal-ink disabled:opacity-40 dark:text-brand-teal"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="px-2.5 py-2">
          <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-current={active ? 'true' : undefined}
            className="block w-full text-left"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={`truncate text-sm ${active ? 'font-semibold text-slate-800' : 'text-slate-700'}`}
              >
                {label}
              </span>
              <span
                className="shrink-0 font-mono text-[0.62rem] text-slate-400"
                title={conversation.updatedAt}
              >
                {timeAgo(conversation.updatedAt)}
              </span>
            </span>
            {preview && (
              <span className="mt-0.5 block truncate text-xs text-slate-400">{preview}</span>
            )}
          </button>
          <div className="mt-1 hidden items-center gap-2.5 group-focus-within:flex group-hover:flex">
            <button
              type="button"
              onClick={() => {
                setDraft(conversation.title ?? '');
                setEditing(true);
              }}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink dark:hover:text-brand-teal"
            >
              Rename
            </button>
            <button
              type="button"
              onClick={() => archive.mutate(!conversation.archived)}
              disabled={archive.isPending}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
            >
              {conversation.archived ? 'Unarchive' : 'Archive'}
            </button>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-slate-400 hover:text-red-600 disabled:opacity-40 dark:hover:text-red-300"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ConversationSidebar({
  session,
  activeId,
  onSelect,
  onCreated,
  onDeleted,
}: {
  session: Session;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreated: (conversation: ConversationDto) => void;
  onDeleted: (id: string) => void;
}) {
  const { data: conversations } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => fetchConversations(session),
    // Auto-titles land asynchronously (the worker's conversation.title job) —
    // a light refetch picks them up without any push machinery.
    refetchInterval: 15_000,
  });
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const create = useMutation({
    mutationFn: () => createConversation(session),
    onSuccess: (conversation) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onCreated(conversation);
    },
  });

  const { active, archived } = splitConversations(conversations ?? []);

  return (
    <aside
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col border-r border-slate-200"
    >
      <div className="flex items-center justify-between px-3 pt-1 pb-2">
        <span className="font-mono text-[0.68rem] uppercase tracking-[0.12em] text-slate-400">
          Conversations
        </span>
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          title="New conversation"
          aria-label="New conversation"
          className="grid h-6 w-6 place-items-center rounded-full border border-slate-300 text-slate-500 transition-colors hover:border-brand-teal hover:text-brand-teal-ink disabled:opacity-40 dark:hover:text-brand-teal"
        >
          <PlusIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {active.length === 0 && archived.length === 0 && (
          <p className="px-1.5 py-2 text-xs leading-relaxed text-slate-400">
            A conversation is a workspace for one thread of thinking: a client, a contract, quick
            questions. Start one and ask.
          </p>
        )}
        <ul className="space-y-1">
          {active.map((c) => (
            <Row
              key={c.id}
              session={session}
              conversation={c}
              active={c.id === activeId}
              onSelect={onSelect}
              onDeleted={onDeleted}
            />
          ))}
        </ul>
        {archived.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
              className="px-1.5 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-slate-400 hover:text-slate-600"
            >
              {showArchived ? '▾' : '▸'} Archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="mt-1 space-y-1 opacity-80">
                {archived.map((c) => (
                  <Row
                    key={c.id}
                    session={session}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={onSelect}
                    onDeleted={onDeleted}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <p className="border-t border-slate-200 px-3 py-2.5 text-[0.68rem] leading-relaxed text-slate-400">
        What Cogeto learns here is remembered everywhere: conversations organise talk, memory keeps
        knowledge.
      </p>
    </aside>
  );
}
