import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReceiptDetailDto, ReceiptListItem } from '@cogeto/shared';
import { fetchChainStatus, fetchInstancePublicKey, fetchReceipt, fetchReceipts } from '../api';
import type { Session } from '../auth/oidc';
import { i18next } from '../i18n';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';
import {
  btnPrimary,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';

/**
 * Forgotten (spec §11.1): the permanent, read-only ledger of deletion receipts —
 * newest first, each backed by the hash chain and the instance signature.
 * Pending receipts poll until the worker confirms; sweep-flagged receipts
 * show as alerting. Receipts cannot be deleted; that permanence is the point.
 */

function ReceiptStatus({ receipt }: { receipt: ReceiptListItem }) {
  const { t } = useTranslation('forgotten');
  if (receipt.alerting)
    return (
      <Pill tone="danger" icon="⚠">
        {t('receiptStatus.alerting')}
      </Pill>
    );
  if (receipt.status === 'pending')
    return (
      <Pill tone="warning" className="animate-pulse">
        {t('receiptStatus.pending')}
      </Pill>
    );
  return (
    <Pill tone="positive" icon="✓">
      {t('receiptStatus.confirmed')}
    </Pill>
  );
}

function sourceLabel(receipt: ReceiptListItem): string {
  const type =
    receipt.sourceType === 'chat_conversation'
      ? i18next.t('forgotten:sourceKind.conversation')
      : receipt.sourceType.replace('_', ' ');
  const id = receipt.sourceId.length > 24 ? `${receipt.sourceId.slice(0, 24)}…` : receipt.sourceId;
  return i18next.t('forgotten:sourceLabel', { kind: type, id });
}

/** The exportable artifact: receipt + everything needed to verify it alone. */
async function exportReceiptJson(detail: ReceiptDetailDto): Promise<void> {
  const publicKey = await fetchInstancePublicKey();
  const artifact = {
    cogetoDeletionReceipt: {
      id: detail.id,
      source: { type: detail.sourceType, id: detail.sourceId },
      counts: detail.countsJson,
      status: detail.status,
      signedAt: detail.signedAt,
      confirmedAt: detail.confirmedAt,
      prevHash: detail.prevHash,
      hash: detail.hash,
      signature: detail.signature,
    },
    verification: {
      algorithm: publicKey.algorithm,
      publicKeyPem: publicKey.publicKeyPem,
      publicKeyEndpoint: '/api/instance/public-key',
      // The verification recipe is a TECHNICAL SPECIFICATION inside an exported
      // artifact a third party parses, not interface copy. It stays English in
      // every locale so a receipt verifies identically wherever it was exported.
      how:
        'hash = SHA-256 hex over the canonical JSON (keys sorted at every depth) of ' +
        '{id, source_type, source_id, counts_json, signed_at, confirmed_at, prev_hash}; ' +
        'signature = ed25519 over the hash string, base64. prev_hash chains to the ' +
        'previous confirmed receipt (genesis: "cogeto:deletion-receipt-chain:genesis").',
    },
  };
  const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cogeto-deletion-receipt-${detail.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The print/PDF artifact (§4 — the money screenshot). Hidden on
 * screen (`.receipt-print`); the print stylesheet shows only this. A clean,
 * single-page deletion certificate anyone can save as PDF from the browser.
 */
function PrintableReceipt({ detail }: { detail: ReceiptDetailDto }) {
  const { t } = useTranslation('forgotten');
  const row = (label: string, value: string | null) => (
    <div style={{ marginBottom: '10px' }}>
      <div
        style={{
          fontSize: '10px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#64748b',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#0f172a',
          wordBreak: 'break-all',
        }}
      >
        {value ?? t('receipt.none')}
      </div>
    </div>
  );
  return (
    <div
      className="receipt-print"
      style={{ color: '#0f172a', maxWidth: '640px', margin: '0 auto' }}
    >
      <div
        style={{ borderBottom: '3px solid #21c29a', paddingBottom: '12px', marginBottom: '20px' }}
      >
        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1c2150' }}>
          {t('common:productName')}
        </div>
        <div style={{ fontSize: '15px', color: '#334155' }}>{t('receipt.printSubtitle')}</div>
      </div>
      {row(t('receipt.field.id'), detail.id)}
      {row(t('receipt.field.source'), `${detail.sourceType} / ${detail.sourceId}`)}
      {row(t('receipt.field.status'), detail.status)}
      {row(t('receipt.field.requestedSigned'), detail.signedAt)}
      {row(t('receipt.field.confirmed'), detail.confirmedAt)}
      <div style={{ marginBottom: '10px' }}>
        <div
          style={{
            fontSize: '10px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#64748b',
          }}
        >
          {t('receipt.field.whatRemoved')}
        </div>
        <pre
          style={{ fontSize: '11px', background: '#f8fafc', padding: '8px', borderRadius: '6px' }}
        >
          {JSON.stringify(detail.countsJson, null, 2)}
        </pre>
      </div>
      {row(t('receipt.field.prevHash'), detail.prevHash)}
      {row(t('receipt.field.hash'), detail.hash)}
      {row(t('receipt.field.signature'), detail.signature)}
      <div
        style={{
          marginTop: '18px',
          fontSize: '11px',
          color: '#64748b',
          borderTop: '1px solid #e2e8f0',
          paddingTop: '10px',
        }}
      >
        {t('receipt.printFooter')}
      </div>
    </div>
  );
}

function ReceiptDrawer({
  session,
  receiptId,
  onClose,
}: {
  session: Session;
  receiptId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('forgotten');
  const { data, isPending, isError } = useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => fetchReceipt(session, receiptId),
  });

  const field = (label: string, value: string | null) => (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="break-all font-mono text-xs text-slate-700">
        {value ?? t('receipt.fieldPending')}
      </p>
    </div>
  );

  return (
    <Drawer title={t('receipt.drawerTitle')} onClose={onClose}>
      {isPending && <SkeletonRows rows={4} label={t('receipt.loading')} />}
      {isError && <ErrorState>{t('receipt.error')}</ErrorState>}
      {data && (
        <>
          <div className="flex items-center justify-between">
            <ReceiptStatus receipt={data} />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={data.status !== 'confirmed'}
                title={
                  data.status === 'confirmed'
                    ? t('receipt.printTitle')
                    : t('receipt.availableWhenConfirmed')
                }
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 rounded-md border border-brand-teal px-3 py-1.5 text-xs font-semibold text-brand-teal-ink dark:text-brand-teal transition-colors hover:bg-brand-teal-surface dark:hover:bg-brand-teal/15 disabled:opacity-40"
              >
                {t('receipt.savePdf')}
              </button>
              <button
                type="button"
                disabled={data.status !== 'confirmed'}
                title={
                  data.status === 'confirmed'
                    ? t('receipt.exportTitle')
                    : t('receipt.availableWhenConfirmed')
                }
                onClick={() => void exportReceiptJson(data)}
                className={btnPrimary}
              >
                {t('receipt.exportJson')}
              </button>
            </div>
          </div>
          {field(t('receipt.field.id'), data.id)}
          {field(t('receipt.field.source'), `${data.sourceType} / ${data.sourceId}`)}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              {t('receipt.field.canonicalPayload')}
            </p>
            <pre className="max-h-64 overflow-auto rounded-md bg-slate-50 p-2 text-xs text-slate-700">
              {JSON.stringify(data.countsJson, null, 2)}
            </pre>
          </div>
          {field(t('receipt.field.signedAt'), data.signedAt)}
          {field(t('receipt.field.confirmedAt'), data.confirmedAt)}
          {field(t('receipt.field.prevHash'), data.prevHash)}
          {field(t('receipt.field.hash'), data.hash)}
          {field(t('receipt.field.signature'), data.signature)}
          <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
            {t('receipt.exportExplainer')}
          </p>
          <PrintableReceipt detail={data} />
        </>
      )}
    </Drawer>
  );
}

export function Forgotten({ session }: { session: Session }) {
  const { t } = useTranslation('forgotten');
  const [openId, setOpenId] = useState<string | null>(null);

  const receiptsQuery = useQuery({
    queryKey: ['receipts'],
    queryFn: () => fetchReceipts(session),
    // A saga mid-flight resolves in seconds — poll until nothing is pending.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'pending') ? 3_000 : 30_000,
  });
  const chainQuery = useQuery({
    queryKey: ['chain-status'],
    queryFn: () => fetchChainStatus(session),
    refetchInterval: 30_000,
  });
  const receipts = receiptsQuery.data;

  return (
    <Shell session={session} title={t('navigation:section.forgotten')} active="forgotten">
      <Card>
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <SectionTitle>{t('heading')}</SectionTitle>
          {chainQuery.data &&
            (chainQuery.data.ok ? (
              <Pill tone="positive" icon="✓">
                {t('chainVerified', { count: chainQuery.data.verified })}
              </Pill>
            ) : (
              <Pill tone="danger" icon="✗" className="cursor-help">
                <span title={chainQuery.data.error}>{t('chainFailed')}</span>
              </Pill>
            ))}
        </div>
        <p className="mb-3 text-xs text-slate-500">{t('permanenceNote')}</p>

        {receiptsQuery.isPending && <SkeletonRows rows={4} label={t('loading')} />}
        {receiptsQuery.isError && <ErrorState>{t('error')}</ErrorState>}
        {receipts && receipts.length === 0 && (
          <EmptyState icon="🧾" title={t('empty.title')}>
            {t('empty.body')}
          </EmptyState>
        )}
        {receipts && receipts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3">{t('column.source')}</th>
                  <th className="py-2 pr-3">{t('column.removed')}</th>
                  <th className="py-2 pr-3">{t('column.requested')}</th>
                  <th className="py-2 pr-3">{t('column.confirmed')}</th>
                  <th className="py-2 pr-3">{t('column.status')}</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr
                    key={receipt.id}
                    onClick={() => setOpenId(receipt.id)}
                    className="cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50"
                  >
                    <td className="py-2 pr-3 font-medium text-slate-700">
                      <button
                        type="button"
                        onClick={() => setOpenId(receipt.id)}
                        className="text-left hover:text-brand-teal-ink dark:hover:text-brand-teal"
                      >
                        {sourceLabel(receipt)}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {[
                        t('removed.memories', { count: receipt.memoryCount }),
                        t('removed.vectors', { count: receipt.memoryCount }),
                        t('removed.files', { count: receipt.objectCount }),
                        receipt.chatMessagesRemoved > 0
                          ? t('removed.messages', { count: receipt.chatMessagesRemoved })
                          : null,
                        receipt.chatMessagesRedacted > 0
                          ? t('removed.redacted', { count: receipt.chatMessagesRedacted })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-400" title={receipt.requestedAt}>
                      {timeAgo(receipt.requestedAt)}
                    </td>
                    <td
                      className="py-2 pr-3 text-xs text-slate-400"
                      title={receipt.confirmedAt ?? undefined}
                    >
                      {receipt.confirmedAt ? timeAgo(receipt.confirmedAt) : t('notYet')}
                    </td>
                    <td className="py-2 pr-3">
                      <ReceiptStatus receipt={receipt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && (
        <ReceiptDrawer session={session} receiptId={openId} onClose={() => setOpenId(null)} />
      )}
    </Shell>
  );
}
