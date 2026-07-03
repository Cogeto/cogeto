import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatFactDto } from '@cogeto/shared';
import { askChat, fetchChatMessages } from '../api';
import type { Session } from '../auth/oidc';
import { CitationChip } from '../components/CitationChip';
import type { ChipTarget } from '../components/CitationChip';
import { Shell } from '../components/Shell';
import { SourceDrawer } from '../components/SourceDrawer';

/**
 * Chat (S3-A): grounded answers over the user's memories. Assistant messages
 * carry inline citation markers — `[F#]` while streaming (resolved via the SSE
 * sources event), `[[mem:<id>]]` once persisted (resolved via the memory API).
 */

const MARKER = /\[\[mem:([0-9a-fA-F-]{36})\]\]|\[(F\d+)\]/g;

function MessageBody({
  session,
  content,
  facts,
  onSource,
}: {
  session: Session;
  content: string;
  facts?: ChatFactDto[];
  onSource: (target: ChipTarget) => void;
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let ordinal = 0;
  for (const match of content.matchAll(MARKER)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(content.slice(last, at));
    ordinal += 1;
    const memoryId = match[1];
    const marker = match[2];
    const fact = marker
      ? facts?.find((f) => f.marker === marker)
      : facts?.find((f) => f.memoryId === memoryId);
    parts.push(
      <CitationChip
        key={`${at}-${ordinal}`}
        session={session}
        ordinal={ordinal}
        memoryId={memoryId}
        fact={fact}
        onSource={onSource}
      />,
    );
    last = at + match[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{parts}</p>;
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 ${
          role === 'user'
            ? 'bg-brand-navy-deep text-white'
            : 'border border-slate-200 bg-white text-slate-800 shadow-sm'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function Chat({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const { data: history, isPending } = useQuery({
    queryKey: ['chat-messages'],
    queryFn: () => fetchChatMessages(session),
  });

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [liveQuestion, setLiveQuestion] = useState<string | null>(null);
  const [liveText, setLiveText] = useState('');
  const [liveFacts, setLiveFacts] = useState<ChatFactDto[]>([]);
  const [drawer, setDrawer] = useState<ChipTarget | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [history, liveText, liveQuestion]);

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    setFailed(false);
    setDraft('');
    setLiveQuestion(content);
    setLiveText('');
    setLiveFacts([]);
    try {
      await askChat(session, content, (event) => {
        if (event.type === 'sources') setLiveFacts(event.facts);
        else if (event.type === 'token') setLiveText((text) => text + event.text);
        else if (event.type === 'error') setFailed(true);
      });
    } catch {
      setFailed(true);
    }
    await queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
    setLiveQuestion(null);
    setLiveText('');
    setLiveFacts([]);
    setBusy(false);
  };

  const onSource = (target: ChipTarget) => {
    if (target.sourceType === 'user_note') setDrawer(target);
  };

  const empty = !isPending && (history?.length ?? 0) === 0 && !liveQuestion;

  return (
    <Shell session={session} title="Chat" active="chat">
      <section className="flex min-h-[60vh] flex-col rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
        <div className="flex-1 space-y-3">
          {isPending && <p className="text-sm text-slate-400">Loading conversation…</p>}
          {empty && (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
              <p className="font-medium text-slate-600">Ask about anything you have captured.</p>
              <p className="mt-1">
                Answers come only from your memories — every claim carries a citation chip that
                opens its source. Nothing on record yet? Capture a note on the{' '}
                <a href="/memories" className="text-brand-teal hover:underline">
                  Memories
                </a>{' '}
                page first.
              </p>
            </div>
          )}
          {history?.map((message) => (
            <Bubble key={message.id} role={message.role}>
              <MessageBody session={session} content={message.content} onSource={onSource} />
            </Bubble>
          ))}
          {liveQuestion && (
            <Bubble role="user">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{liveQuestion}</p>
            </Bubble>
          )}
          {liveQuestion && (
            <Bubble role="assistant">
              {liveText ? (
                <MessageBody
                  session={session}
                  content={liveText}
                  facts={liveFacts}
                  onSource={onSource}
                />
              ) : (
                <p className="text-sm text-slate-400">Searching your memories…</p>
              )}
            </Bubble>
          )}
          {failed && <p className="text-sm text-red-600">Answer generation failed — ask again.</p>}
          <div ref={bottomRef} />
        </div>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your commitments, decisions, people…"
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="rounded-md bg-brand-teal px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Answering…' : 'Ask'}
          </button>
        </form>
      </section>
      {drawer && (
        <SourceDrawer
          session={session}
          sourceId={drawer.sourceId}
          onClose={() => setDrawer(null)}
        />
      )}
    </Shell>
  );
}
