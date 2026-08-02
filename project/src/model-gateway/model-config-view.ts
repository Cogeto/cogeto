import type { ResolvedModelProviders } from './provider-config';

/**
 * What `/api/settings/model-config` displays: the resolved provider
 * configuration plus the redaction posture.
 *
 * The controller used to inject the whole `CogetoConfig` from `entrypoints/`,
 * which no module may import (V2.0 item 3.6 part 2). The gateway already
 * receives both of these when the composition root registers it, so the two
 * fields are simply named here and provided from the same options.
 */
export interface ModelConfigView {
  modelProviders: ResolvedModelProviders;
  redactionEnabled: boolean;
}

export const MODEL_CONFIG_VIEW = Symbol('MODEL_CONFIG_VIEW');
