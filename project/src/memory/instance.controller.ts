import { Controller, Get, Inject } from '@nestjs/common';
import { loadInstancePublicKey } from '../infrastructure/index';
import { Public } from '../identity/index';
import { INSTANCE_KEY_DIR } from './deletion-saga';

/**
 * GET /api/instance/public-key — the shareable half of the instance signing
 * keypair (spec §11.1). Unauthenticated by design, like /api/health/live: a
 * public key is public, and anyone holding an exported deletion receipt must be
 * able to fetch it to verify the signature independently.
 *
 * Lives in `memory` (V2.0 item 3.6 part 2): this is the verification key for
 * the artifacts this module signs, so it belongs beside `/api/receipts` and
 * `/api/integrity`, which is also where `INSTANCE_KEY_DIR` already is.
 */
@Public()
@Controller('instance')
export class InstanceController {
  private publicKeyPem?: string;

  constructor(@Inject(INSTANCE_KEY_DIR) private readonly keyDir: string) {}

  @Get('public-key')
  async publicKey(): Promise<{ algorithm: 'ed25519'; publicKeyPem: string }> {
    this.publicKeyPem ??= await loadInstancePublicKey(this.keyDir);
    return { algorithm: 'ed25519', publicKeyPem: this.publicKeyPem };
  }
}
