import { Controller, Get, Inject } from '@nestjs/common';
import { loadInstancePublicKey } from '../infrastructure/index';
import { Public } from '../identity/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * GET /api/instance/public-key — the shareable half of the instance signing
 * keypair (§B.1, decision 0008). Unauthenticated by design, like /api/health:
 * a public key is public, and anyone holding an exported deletion receipt must
 * be able to fetch it to verify the signature independently.
 */
@Public()
@Controller('instance')
export class InstanceController {
  private publicKeyPem?: string;

  constructor(@Inject(COGETO_CONFIG) private readonly config: CogetoConfig) {}

  @Get('public-key')
  async publicKey(): Promise<{ algorithm: 'ed25519'; publicKeyPem: string }> {
    this.publicKeyPem ??= await loadInstancePublicKey(this.config.instanceKeyDir);
    return { algorithm: 'ed25519', publicKeyPem: this.publicKeyPem };
  }
}
