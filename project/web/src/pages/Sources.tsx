import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { SourceDrawer } from '../components/SourceDrawer';
import { UploadCard, PendingUpload } from '../components/UploadCard';
import type { UploadOutcome } from '../components/UploadCard';

/** Reads ?open=<object key> — the chat attachment card deep-links here. */
function openedFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get('open');
}

/**
 * Sources (V2.2 item 5.1): the deliberate door. Chat is where things enter
 * conversationally; this page is where you add documents you intend to keep
 * and audit, and where their progress and honest outcomes are visible. The
 * three-level source list is item 5.2 and lands here next; bulk import (item
 * 5.3) joins the upload as a second deliberate entry.
 */
export function Sources({ session }: { session: Session }) {
  const { t } = useTranslation('sources');
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<{ objectKey: string; filename: string }[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(openedFromUrl);

  const openDrawer = (objectKey: string | null) => {
    setOpenKey(objectKey);
    const url = objectKey ? `/sources?open=${encodeURIComponent(objectKey)}` : '/sources';
    window.history.replaceState(null, '', url);
  };

  // Rows are KEPT after they settle (read, unread, or failed): on this page
  // the row itself is the completion surface, and the settle rule stays the
  // reading layer's (a job can succeed having read nothing, so the read
  // report decides what the row says — V2.1 item 4.1).
  const settleUpload = (_objectKey: string, _outcome: UploadOutcome) => {
    void queryClient.invalidateQueries({ queryKey: ['memories'] });
  };

  return (
    <Shell session={session} title={t('navigation:section.sources')} active="sources">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-slate-700">{t('page.uploadHeading')}</h2>
        <p className="text-sm text-slate-500">{t('page.uploadIntro')}</p>
      </div>
      <UploadCard
        session={session}
        onUploaded={(objectKey, filename) =>
          setUploads((items) => [...items, { objectKey, filename }])
        }
      />
      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((upload) => (
            <div key={upload.objectKey} className="space-y-1">
              <PendingUpload
                session={session}
                objectKey={upload.objectKey}
                filename={upload.filename}
                onSettled={settleUpload}
              />
              <button
                type="button"
                onClick={() => openDrawer(upload.objectKey)}
                className="text-xs font-semibold text-slate-500 underline underline-offset-2 hover:text-slate-700"
              >
                {t('page.openDetails')}
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">{t('page.note')}</p>
      {openKey && (
        <SourceDrawer
          session={session}
          sourceType="file"
          sourceId={openKey}
          onClose={() => openDrawer(null)}
          onDeleted={() => openDrawer(null)}
        />
      )}
    </Shell>
  );
}
