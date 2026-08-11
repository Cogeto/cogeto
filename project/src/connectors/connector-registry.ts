import { Injectable } from '@nestjs/common';
import { isRegisteredSourceType, sourceTypeDescriptor } from '@cogeto/shared';
import type { ConnectorDescriptor } from './connector-descriptor';

/**
 * The connector registry (V2.5 item 8.1, issue A): descriptors registered
 * through the composition roots (`ConnectorsModule.register({ connectors })`),
 * validated once at construction. Adding a connector touches its own module
 * and the registration only; the validation here is what makes the
 * source-type guarantee real rather than aspirational: the declared type
 * must already be registered in the shared registry (which is code, not a
 * database type, spec 15.3), so no connector can require a memory migration.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly byKind = new Map<string, ConnectorDescriptor>();

  constructor(descriptors: ConnectorDescriptor[] = []) {
    for (const descriptor of descriptors) this.add(descriptor);
  }

  add(descriptor: ConnectorDescriptor): void {
    if (this.byKind.has(descriptor.kind)) {
      throw new Error(`connector kind '${descriptor.kind}' registered twice`);
    }
    if (!isRegisteredSourceType(descriptor.sourceType)) {
      throw new Error(
        `connector '${descriptor.kind}' declares unregistered source type ` +
          `'${descriptor.sourceType}': register it in @cogeto/shared first (spec 15.3)`,
      );
    }
    const type = sourceTypeDescriptor(descriptor.sourceType);
    if (!type?.extraction) {
      throw new Error(
        `connector '${descriptor.kind}' declares source type '${descriptor.sourceType}', ` +
          `which is not extraction-capable`,
      );
    }
    // Authorship must be consistent with the source type's own contract: an
    // observed connector may not ride a userAuthored: 'always' type, which
    // would turn third-party obligations into the user's own.
    if (descriptor.authorship === 'observed' && type.userAuthored === 'always') {
      throw new Error(
        `connector '${descriptor.kind}' is observed but its source type ` +
          `'${descriptor.sourceType}' declares userAuthored: 'always'`,
      );
    }
    if (descriptor.hasSubScopes && !descriptor.listSubScopes) {
      throw new Error(`connector '${descriptor.kind}' has sub-scopes but no listSubScopes`);
    }
    if (descriptor.auth === 'oauth2' && !descriptor.refresh) {
      throw new Error(`connector '${descriptor.kind}' uses oauth2 but declares no refresh`);
    }
    this.byKind.set(descriptor.kind, descriptor);
  }

  get(kind: string): ConnectorDescriptor | null {
    return this.byKind.get(kind) ?? null;
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}
