import type { ConversationDto, DeletionPreviewDto } from '@cogeto/shared';

/**
 * Pure presentation logic for the conversations sidebar (P6.9, decision 0056),
 * React-free so the lifecycle rules are unit-testable: display naming, the
 * active/archived split and ordering, deep-link parsing, and the
 * consequence-stating delete confirmation built from the REAL preview numbers.
 */

/** The sidebar's display name: the title, or the placeholder until titled. */
export function conversationLabel(conversation: Pick<ConversationDto, 'title'>): string {
  return conversation.title ?? 'New conversation';
}

/** Preview line under the label: the last message's first characters. */
export function conversationPreview(
  conversation: Pick<ConversationDto, 'lastMessagePreview'>,
): string | null {
  const preview = conversation.lastMessagePreview;
  if (!preview) return null;
  const flat = preview.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** Active list (recency order, as served) and the collapsed archived section. */
export function splitConversations(conversations: ConversationDto[]): {
  active: ConversationDto[];
  archived: ConversationDto[];
} {
  return {
    active: conversations.filter((c) => !c.archived),
    archived: conversations.filter((c) => c.archived),
  };
}

/** The conversation the page should open: deep link first, else most recent. */
export function initialConversationId(
  conversations: ConversationDto[],
  deepLinkId: string | null,
): string | null {
  if (deepLinkId && conversations.some((c) => c.id === deepLinkId)) return deepLinkId;
  const { active, archived } = splitConversations(conversations);
  return active[0]?.id ?? archived[0]?.id ?? null;
}

/** Parses /chat?c=<conversation>&m=<message> — the deep-link contract. */
export function parseChatLink(search: string): {
  conversationId: string | null;
  messageId: string | null;
} {
  const params = new URLSearchParams(search);
  return { conversationId: params.get('c'), messageId: params.get('m') };
}

/** Writes the current conversation (and optional message) back to the URL. */
export function chatLink(conversationId: string, messageId?: string): string {
  const params = new URLSearchParams({ c: conversationId });
  if (messageId) params.set('m', messageId);
  return `/chat?${params.toString()}`;
}

/**
 * The delete confirmation, stating exactly what the saga will do — built from
 * the preview endpoint's numbers, never guessed. Archive is offered as the
 * safe alternative; user-approved memories and derived tasks are called out so
 * the user deletes knowingly.
 */
export function deleteConversationConfirm(
  label: string,
  preview: Pick<
    DeletionPreviewDto,
    'memoryCount' | 'messageCount' | 'userApprovedCount' | 'taskCount'
  >,
): string {
  const messages = preview.messageCount ?? 0;
  const memories = preview.memoryCount;
  const lines = [
    `Delete "${label}"?`,
    '',
    `This deletes the conversation, its ${messages} message${messages === 1 ? '' : 's'}, ` +
      `and the ${memories} memor${memories === 1 ? 'y' : 'ies'} derived from them, with a signed receipt.`,
  ];
  const knowing: string[] = [];
  if ((preview.userApprovedCount ?? 0) > 0) {
    knowing.push(
      `${preview.userApprovedCount} of those memories ${preview.userApprovedCount === 1 ? 'was' : 'were'} approved by you`,
    );
  }
  if ((preview.taskCount ?? 0) > 0) {
    knowing.push(
      `${preview.taskCount} task${preview.taskCount === 1 ? '' : 's'} derived from them will be removed too`,
    );
  }
  if (knowing.length > 0) lines.push(`Note: ${knowing.join('; ')}.`);
  lines.push('', 'Archiving keeps everything instead. This cannot be undone.');
  return lines.join('\n');
}
