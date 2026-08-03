import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModelGateway, probeVision } from '../../model-gateway/index';
import type { ResolvedModelProviders } from '../../model-gateway/index';
import { VisionSource } from '../file.source-reader';

/**
 * Deciding, per document, whether vision is usable right now (V2.1 item 4.1).
 *
 * The reading ladder must not be handed a gateway that cannot see. If it is,
 * every picture page becomes a slow failure instead of an honest label, and on
 * a local runtime "slow" means minutes per page. So this probes, and it caches
 * the answer for a short window rather than per call: a probe per document is
 * wasteful, and a probe once per process is a lie the moment the runtime is
 * restarted.
 *
 * The window is deliberately short. Discovering a dead runtime one document
 * late costs one document's pages, which are then labelled as needing vision
 * and can be reprocessed; discovering it an hour late costs an hour of reads
 * that all say the wrong thing.
 */

export const VISION_PROBE_TTL_MS = 60_000;
export const VISION_PROVIDERS = Symbol('VISION_PROVIDERS');

@Injectable()
export class ProbedVisionSource extends VisionSource {
  private readonly logger = new Logger('reading.vision');
  private cached: { at: number; gateway: ModelGateway | null } | null = null;

  constructor(
    private readonly gateway: ModelGateway,
    @Optional() @Inject(VISION_PROVIDERS) private readonly providers?: ResolvedModelProviders,
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  async visionGateway(): Promise<ModelGateway | null> {
    if (!this.providers?.vision) return null;
    const at = this.now();
    if (this.cached && at - this.cached.at < VISION_PROBE_TTL_MS) return this.cached.gateway;

    const probe = await probeVision(this.gateway, this.providers, { timeoutMs: 15_000 });
    if (!probe.ok) {
      // Logged once per window, not once per page: a broken runtime should be
      // one line an operator can act on, not a wall of identical warnings.
      this.logger.warn(`vision is configured but not usable (${probe.reason}): ${probe.error}`);
    }
    const gateway = probe.ok ? this.gateway : null;
    this.cached = { at, gateway };
    return gateway;
  }
}
