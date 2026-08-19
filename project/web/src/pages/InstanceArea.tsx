import { useEffect } from 'react';
import type { Session } from '../auth/oidc';
import { InstanceShell } from '../components/InstanceShell';
import type { InstanceSection } from '../components/InstanceShell';
import { Audit } from './Audit';
import { InstanceSettings } from './InstanceSettings';
import { ModelConfiguration } from './ModelConfiguration';
import { Providers } from './Providers';
import { System } from './System';
import { Users } from './Users';

export type { InstanceSection } from '../components/InstanceShell';

/**
 * The instance area (docs/features/spaces.md section 3): one route family,
 * one frame, six sections. Legacy paths (/providers, /models, /system,
 * /audit, /users) render the same surface and are normalized here to their
 * canonical /instance/... URL, so every pre-existing deep link, banner and
 * runbook step keeps resolving.
 */
export function InstanceArea({ session, section }: { session: Session; section: InstanceSection }) {
  useEffect(() => {
    const canonical = `/instance/${section}`;
    if (window.location.pathname !== canonical) {
      window.history.replaceState(null, '', canonical + window.location.search);
    }
  }, [section]);

  return (
    <InstanceShell session={session} section={section}>
      {section === 'settings' && <InstanceSettings session={session} />}
      {section === 'providers' && <Providers session={session} />}
      {section === 'models' && <ModelConfiguration session={session} />}
      {section === 'system' && <System session={session} />}
      {section === 'users' && <Users session={session} />}
      {section === 'audit' && <Audit session={session} />}
    </InstanceShell>
  );
}
