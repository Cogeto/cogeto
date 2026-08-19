import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { resolveSpaceId } from '@cogeto/shared';
import {
  DRIZZLE,
  parseOrBadRequest,
  userError,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { BearerAuthGuard, ConnectorCredentialStore } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { CONNECTOR_SYNC_JOB_TYPE, ConnectorStore } from '../connectors/index';
import {
  ConfluenceClient,
  ConfluenceHttpError,
  ConfluenceNotAConfluenceError,
  ConfluenceUnreachableError,
  normalizeSiteUrl,
} from './client';
import { CONFLUENCE_KIND } from './descriptor';
import { CONFLUENCE_ESTIMATE_JOB_TYPE } from './jobs';

/**
 * The Confluence connect surface (V2.5 item 8.2, issue A1): the one flow
 * that holds the token in hand, so validation happens HERE, before sealing,
 * with a specific answer for what failed. This never violates the
 * worker-only opener rule: nothing here reads a sealed credential back.
 * Everything operational afterwards is the platform's own surface.
 */

const connectSchema = z.object({
  name: z.string().min(1).max(200),
  siteUrl: z.string().min(1).max(500),
  email: z.string().min(3).max(320),
  apiToken: z.string().min(1).max(8192),
});

const reconnectSchema = connectSchema.omit({ name: true });

export type ConnectFailure = 'wrong_site' | 'bad_credentials' | 'no_permission' | 'unreachable';

/** One read call, classified (issue A1's taxonomy). Exported for tests. */
export async function validateConnection(
  client: ConfluenceClient,
): Promise<{ ok: true; spaces: number } | { ok: false; reason: ConnectFailure }> {
  try {
    const { spaces } = await client.listSpaces();
    if (spaces.length === 0) return { ok: false, reason: 'no_permission' };
    return { ok: true, spaces: spaces.length };
  } catch (error) {
    if (error instanceof ConfluenceUnreachableError) return { ok: false, reason: 'unreachable' };
    if (error instanceof ConfluenceNotAConfluenceError) return { ok: false, reason: 'wrong_site' };
    if (error instanceof ConfluenceHttpError) {
      if (error.status === 401) return { ok: false, reason: 'bad_credentials' };
      if (error.status === 403) return { ok: false, reason: 'no_permission' };
      if (error.status >= 500) return { ok: false, reason: 'unreachable' };
      return { ok: false, reason: 'wrong_site' };
    }
    return { ok: false, reason: 'unreachable' };
  }
}

@Controller('confluence')
@UseGuards(BearerAuthGuard)
export class ConfluenceController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly connectors: ConnectorStore,
    private readonly credentials: ConnectorCredentialStore,
  ) {}

  /**
   * Connect: normalize the site, make one READ call with the supplied
   * material, and only then create the connector, seal the credential and
   * enqueue the discovery sync. A failure names its reason and stores
   * nothing.
   */
  @Post('connect')
  async connect(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = parseOrBadRequest(connectSchema, body);
    const validated = await this.validate(parsed);
    if (!validated.ok) return { connected: false as const, reason: validated.reason };

    const row = await this.connectors.create({
      ownerId: request.principal.userId,
      orgId: request.principal.orgId,
      kind: CONFLUENCE_KIND,
      name: parsed.name,
    });
    await this.db.transaction(async (tx) => {
      await this.credentials.store(tx, {
        ownerId: row.ownerId,
        orgId: row.orgId,
        connectorId: row.id,
        material: {
          accessToken: parsed.apiToken,
          extras: { siteUrl: validated.siteUrl, email: parsed.email },
        },
        accountIdentity: `${parsed.email} on ${validated.siteUrl}`,
        scopes: ['read'],
        expiresAt: null,
      });
      await this.connectors.transition(tx, row, 'authorised', {
        actor: `user:${request.principal.userId}`,
      });
      await withTransactionalEnqueue(
        tx,
        { type: 'connector.sync_requested', payload: { connector_id: row.id } },
        {
          type: CONNECTOR_SYNC_JOB_TYPE,
          payload: { source_type: 'connector', source_id: row.id },
          principalId: row.ownerId,
        },
      );
    });
    return { connected: true as const, connectorId: row.id, spacesVisible: validated.spaces };
  }

  /** Reconnect after needs_reauth: same validation, same one-way storage. */
  @Post(':id/credentials')
  async reconnect(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const row = await this.connectors.byIdForOwner(
      id,
      request.principal.userId,
      resolveSpaceId(request.principal),
    );
    if (row.kind !== CONFLUENCE_KIND) {
      throw userError.badRequest('confluence.notConfluenceConnector', 'not a Confluence connector');
    }
    const parsed = parseOrBadRequest(reconnectSchema, body);
    const validated = await this.validate(parsed);
    if (!validated.ok) return { connected: false as const, reason: validated.reason };
    await this.db.transaction(async (tx) => {
      await this.credentials.store(tx, {
        ownerId: row.ownerId,
        orgId: row.orgId,
        connectorId: row.id,
        material: {
          accessToken: parsed.apiToken,
          extras: { siteUrl: validated.siteUrl, email: parsed.email },
        },
        accountIdentity: `${parsed.email} on ${validated.siteUrl}`,
        scopes: ['read'],
        expiresAt: null,
      });
      if (row.state === 'configured' || row.state === 'needs_reauth') {
        await this.connectors.transition(tx, row, 'authorised', {
          actor: `user:${request.principal.userId}`,
        });
      }
    });
    return { connected: true as const, spacesVisible: validated.spaces };
  }

  /** Enqueue the estimate pass (issue B2): counting needs the credential,
   * and the credential opens only in the worker. */
  @Post(':id/estimate')
  async estimate(@Req() request: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const row = await this.connectors.byIdForOwner(
      id,
      request.principal.userId,
      resolveSpaceId(request.principal),
    );
    if (row.kind !== CONFLUENCE_KIND) {
      throw userError.badRequest('confluence.notConfluenceConnector', 'not a Confluence connector');
    }
    await this.db.transaction(async (tx) => {
      await withTransactionalEnqueue(
        tx,
        { type: 'confluence.estimate_requested', payload: { connector_id: row.id } },
        {
          type: CONFLUENCE_ESTIMATE_JOB_TYPE,
          payload: { source_type: 'confluence', source_id: row.id },
          principalId: row.ownerId,
        },
      );
    });
    return { enqueued: true };
  }

  private async validate(input: {
    siteUrl: string;
    email: string;
    apiToken: string;
  }): Promise<
    { ok: true; spaces: number; siteUrl: string } | { ok: false; reason: ConnectFailure }
  > {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    if (!siteUrl) return { ok: false, reason: 'wrong_site' };
    const client = new ConfluenceClient({
      siteUrl,
      email: input.email,
      apiToken: input.apiToken,
    });
    const outcome = await validateConnection(client);
    if (!outcome.ok) return outcome;
    return { ok: true, spaces: outcome.spaces, siteUrl };
  }
}
