import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReceiptDetailDto, ReceiptListItem } from '@cogeto/shared';
import { fetchChainStatus, fetchInstancePublicKey, fetchReceipt, fetchReceipts } from '../api';
import type { Session } from '../auth/oidc';
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
 * Forgotten (§B.1): the permanent, read-only ledger of deletion receipts —
 * newest first, each backed by the hash chain and the instance signature.
 * Pending receipts poll until the worker confirms; sweep-flagged receipts
 * show as alerting. Receipts cannot be deleted; that permanence is the point.
 */

function ReceiptStatus({ receipt }: { receipt: ReceiptListItem }) {
  if (receipt.alerting)
    return (
      <Pill tone="danger" icon="⚠">
        alerting
      </Pill>
    );
  if (receipt.status === 'pending')
    return (
      <Pill tone="warning" className="animate-pulse">
        pending…
      </Pill>
    );
  return (
    <Pill tone="positive" icon="✓">
      confirmed
    </Pill>
  );
}

function sourceLabel(receipt: ReceiptListItem): string {
  const type = receipt.sourceType.replace('_', ' ');
  const id = receipt.sourceId.length > 24 ? `${receipt.sourceId.slice(0, 24)}…` : receipt.sourceId;
  return `${type} · ${id}`;
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
 * The print/PDF artifact (decision 0022 §4 — the money screenshot). Hidden on
 * screen (`.receipt-print`); the print stylesheet shows only this. A clean,
 * single-page deletion certificate anyone can save as PDF from the browser.
 */
function PrintableReceipt({ detail }: { detail: ReceiptDetailDto }) {
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
        {value ?? '—'}
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
        <div style={{ fontSize: '22px', fontWeight: 700, color: '#1c2150' }}>Cogeto</div>
        <div style={{ fontSize: '15px', color: '#334155' }}>
          Deletion receipt — provable forgetting
        </div>
      </div>
      {row('Receipt id', detail.id)}
      {row('Source', `${detail.sourceType} / ${detail.sourceId}`)}
      {row('Status', detail.status)}
      {row('Requested / signed', detail.signedAt)}
      {row('Confirmed', detail.confirmedAt)}
      <div style={{ marginBottom: '10px' }}>
        <div
          style={{
            fontSize: '10px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#64748b',
          }}
        >
          What was removed
        </div>
        <pre
          style={{ fontSize: '11px', background: '#f8fafc', padding: '8px', borderRadius: '6px' }}
        >
          {JSON.stringify(detail.countsJson, null, 2)}
        </pre>
      </div>
      {row('Previous hash', detail.prevHash)}
      {row('Hash (SHA-256)', detail.hash)}
      {row('Signature (ed25519, base64)', detail.signature)}
      <div
        style={{
          marginTop: '18px',
          fontSize: '11px',
          color: '#64748b',
          borderTop: '1px solid #e2e8f0',
          paddingTop: '10px',
        }}
      >
        Hash-chained to the previous receipt and signed by this Cogeto instance. Verify
        independently with the instance public key at /api/instance/public-key. This record is
        permanent.
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
  const { data, isPending, isError } = useQuery({
    queryKey: ['receipt', receiptId],
    queryFn: () => fetchReceipt(session, receiptId),
  });

  const field = (label: string, value: string | null) => (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="break-all font-mono text-xs text-slate-700">{value ?? '— (pending)'}</p>
    </div>
  );

  return (
    <Drawer title="Deletion receipt" onClose={onClose}>
      {isPending && <SkeletonRows rows={4} label="Loading receipt…" />}
      {isError && <ErrorState>We couldn’t load this receipt right now.</ErrorState>}
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
                    ? 'Print or save the receipt as a PDF certificate'
                    : 'Available once the receipt is confirmed'
                }
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 rounded-md border border-brand-teal px-3 py-1.5 text-xs font-semibold text-brand-teal-ink transition-colors hover:bg-brand-teal-surface disabled:opacity-40"
              >
                Save as PDF
              </button>
              <button
                type="button"
                disabled={data.status !== 'confirmed'}
                title={
                  data.status === 'confirmed'
                    ? 'Download the receipt with its verification key'
                    : 'Available once the receipt is confirmed'
                }
                onClick={() => void exportReceiptJson(data)}
                className={btnPrimary}
              >
                Export JSON
              </button>
            </div>
          </div>
          {field('Receipt id', data.id)}
          {field('Source', `${data.sourceType} / ${data.sourceId}`)}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Canonical payload (counts_json)
            </p>
            <pre className="max-h-64 overflow-auto rounded-md bg-slate-50 p-2 text-xs text-slate-700">
              {JSON.stringify(data.countsJson, null, 2)}
            </pre>
          </div>
          {field('Signed at', data.signedAt)}
          {field('Confirmed at', data.confirmedAt)}
          {field('Previous hash', data.prevHash)}
          {field('Hash (SHA-256)', data.hash)}
          {field('Signature (ed25519, base64)', data.signature)}
          <p className="rounded-md bg-slate-50 p-2 text-xs text-slate-500">
            The exported JSON contains this receipt plus the instance public key — a self-contained
            artifact anyone can verify without access to Cogeto. “Save as PDF” prints a clean,
            single-page certificate.
          </p>
          <PrintableReceipt detail={data} />
        </>
      )}
    </Drawer>
  );
}

export function Forgotten({ session }: { session: Session }) {
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
    <Shell session={session} title="Forgotten" active="forgotten">
      <Card>
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <SectionTitle>Deletion receipts</SectionTitle>
          {chainQuery.data &&
            (chainQuery.data.ok ? (
              <Pill tone="positive" icon="✓">
                chain verified · {chainQuery.data.verified} receipt
                {chainQuery.data.verified === 1 ? '' : 's'}
              </Pill>
            ) : (
              <Pill tone="danger" icon="✗" className="cursor-help">
                <span title={chainQuery.data.error}>chain verification FAILED</span>
              </Pill>
            ))}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Receipts are permanent and cannot be deleted — that permanence is the point: each one is
          hash-chained to the last and signed by this instance, so the record of what was forgotten
          can itself never be quietly rewritten.
        </p>

        {receiptsQuery.isPending && <SkeletonRows rows={4} label="Loading receipts…" />}
        {receiptsQuery.isError && (
          <ErrorState>We couldn’t load the deletion receipts right now.</ErrorState>
        )}
        {receipts && receipts.length === 0 && (
          <EmptyState icon="🧾" title="No deletions yet">
            A deletion receipt is the signed, tamper-evident proof Cogeto issues when it permanently
            removes a source and everything derived from it. Delete a note from its source drawer
            and the receipt appears here — permanently.
          </EmptyState>
        )}
        {receipts && receipts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3">Removed</th>
                  <th className="py-2 pr-3">Requested</th>
                  <th className="py-2 pr-3">Confirmed</th>
                  <th className="py-2 pr-3">Status</th>
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
                        className="text-left hover:text-brand-teal-ink"
                      >
                        {sourceLabel(receipt)}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {receipt.memoryCount} memor{receipt.memoryCount === 1 ? 'y' : 'ies'} ·{' '}
                      {receipt.memoryCount} vector{receipt.memoryCount === 1 ? '' : 's'} ·{' '}
                      {receipt.objectCount} file{receipt.objectCount === 1 ? '' : 's'}
                      {receipt.chatMessagesRedacted > 0 &&
                        ` · ${receipt.chatMessagesRedacted} chat answer${
                          receipt.chatMessagesRedacted === 1 ? '' : 's'
                        } redacted`}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-400" title={receipt.requestedAt}>
                      {timeAgo(receipt.requestedAt)}
                    </td>
                    <td
                      className="py-2 pr-3 text-xs text-slate-400"
                      title={receipt.confirmedAt ?? undefined}
                    >
                      {receipt.confirmedAt ? timeAgo(receipt.confirmedAt) : '—'}
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
