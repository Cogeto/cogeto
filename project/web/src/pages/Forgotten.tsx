import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReceiptDetailDto, ReceiptListItem } from '@cogeto/shared';
import { fetchChainStatus, fetchInstancePublicKey, fetchReceipt, fetchReceipts } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';

/**
 * Forgotten (§B.1): the permanent, read-only ledger of deletion receipts —
 * newest first, each backed by the hash chain and the instance signature.
 * Pending receipts poll until the worker confirms; sweep-flagged receipts
 * show as alerting. Receipts cannot be deleted; that permanence is the point.
 */

function StatusChip({ receipt }: { receipt: ReceiptListItem }) {
  if (receipt.alerting) {
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600">
        alerting
      </span>
    );
  }
  if (receipt.status === 'pending') {
    return (
      <span className="animate-pulse rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
        pending…
      </span>
    );
  }
  return (
    <span className="rounded-full bg-brand-teal/15 px-2 py-0.5 text-xs font-semibold text-brand-teal">
      confirmed
    </span>
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
    <div className="fixed inset-0 z-10" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-lg space-y-4 overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Deletion receipt
          </h3>
          <button type="button" onClick={onClose} className="text-sm text-slate-400">
            Close
          </button>
        </div>
        {isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {isError && <p className="text-sm text-red-600">Could not load the receipt.</p>}
        {data && (
          <>
            <div className="flex items-center justify-between">
              <StatusChip receipt={data} />
              <button
                type="button"
                disabled={data.status !== 'confirmed'}
                title={
                  data.status === 'confirmed'
                    ? 'Download the receipt with its verification key'
                    : 'Available once the receipt is confirmed'
                }
                onClick={() => void exportReceiptJson(data)}
                className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                Export JSON
              </button>
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
              The exported JSON contains this receipt plus the instance public key — a
              self-contained artifact anyone can verify without access to Cogeto.
            </p>
          </>
        )}
      </aside>
    </div>
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
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Deletion receipts
          </h2>
          {chainQuery.data &&
            (chainQuery.data.ok ? (
              <span className="rounded-full bg-brand-teal/15 px-2 py-0.5 text-xs font-semibold text-brand-teal">
                ✓ chain verified · {chainQuery.data.verified} receipt
                {chainQuery.data.verified === 1 ? '' : 's'}
              </span>
            ) : (
              <span
                className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600"
                title={chainQuery.data.error}
              >
                ✗ chain verification FAILED
              </span>
            ))}
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Receipts are permanent and cannot be deleted — that permanence is the point: each one is
          hash-chained to the last and signed by this instance, so the record of what was forgotten
          can itself never be quietly rewritten.
        </p>

        {receiptsQuery.isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {receiptsQuery.isError && (
          <p className="text-sm text-red-600">Could not load the receipts.</p>
        )}
        {receipts && receipts.length === 0 && (
          <p className="text-sm text-slate-400">
            A deletion receipt is the signed, tamper-evident proof Cogeto issues when it permanently
            removes a source and everything derived from it. Delete a note from its source drawer
            and the receipt will appear here.
          </p>
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
                    <td className="py-2 pr-3 font-medium text-slate-700">{sourceLabel(receipt)}</td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {receipt.memoryCount} memor{receipt.memoryCount === 1 ? 'y' : 'ies'} ·{' '}
                      {receipt.memoryCount} vector{receipt.memoryCount === 1 ? '' : 's'} ·{' '}
                      {receipt.objectCount} file{receipt.objectCount === 1 ? '' : 's'}
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
                      <StatusChip receipt={receipt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openId && (
        <ReceiptDrawer session={session} receiptId={openId} onClose={() => setOpenId(null)} />
      )}
    </Shell>
  );
}
