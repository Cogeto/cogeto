import {
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { DRIZZLE, RateLimitStore, withTransactionalEnqueue } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { Public } from '../identity/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { verifyWebhookSignature } from './domain/webhook-verify';
import { CONNECTOR_WEBHOOK_JOB_TYPE } from './connector-jobs';
import {
  CONNECTORS_OPTIONS,
  WEBHOOK_MAX_BYTES_DEFAULT,
  WEBHOOK_MAX_PER_WINDOW_DEFAULT,
  WEBHOOK_RATE_WINDOW_SECONDS_DEFAULT,
} from './connectors.options';
import type { ConnectorsOptions } from './connectors.options';
import { SYNCABLE_STATES } from './domain/lifecycle';

/**
 * The shared webhook ingress (V2.5 item 8.1, issue D). Unauthenticated by
 * nature and therefore hostile-facing; the order of operations is the
 * defence:
 *
 * 1. size cap at the transport (express.raw in app.ts, the email-intake
 *    precedent) and re-checked here;
 * 2. per-connector durable rate limit BEFORE any crypto work;
 * 3. signature verification over the RAW bytes with the descriptor's
 *    declared scheme, timestamp tolerance included, before anything parses;
 * 4. bounded JSON parse, identifier extraction ONLY (payloads are signals,
 *    never content: nothing from the body is stored except the event id and
 *    item references, and nothing from it ever reaches a model);
 * 5. delivery dedup by (connector, event id): a replayed delivery
 *    acknowledges 200 and does nothing;
 * 6. transactional enqueue of the processing job, then an immediate 200, so
 *    slow ingestion can never cause upstream retry storms.
 */
@Public()
@Controller('connectors/webhooks')
export class ConnectorWebhookController {
  private readonly logger = new Logger(ConnectorWebhookController.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONNECTORS_OPTIONS) private readonly options: ConnectorsOptions,
    private readonly registry: ConnectorRegistry,
    private readonly store: ConnectorStore,
    @Optional() private readonly limiter?: RateLimitStore,
  ) {}

  @Post(':connectorId')
  @HttpCode(HttpStatus.OK)
  @Header('cache-control', 'no-store')
  async receive(
    @Param('connectorId') connectorId: string,
    @Req() request: Request,
  ): Promise<{
    accepted: boolean;
  }> {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const maxBytes = this.options.webhookMaxBytes ?? WEBHOOK_MAX_BYTES_DEFAULT;
    if (raw.length === 0 || raw.length > maxBytes) {
      throw new HttpException('refused', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    // Cheap refusals first: unknown connector ids and inactive connectors
    // answer 404 before any crypto or rate bookkeeping.
    if (!/^[0-9a-f-]{36}$/i.test(connectorId)) {
      throw new HttpException('unknown', HttpStatus.NOT_FOUND);
    }
    const connector = await this.store.byId(connectorId);
    if (!connector || !SYNCABLE_STATES.includes(connector.state)) {
      throw new HttpException('unknown', HttpStatus.NOT_FOUND);
    }
    const descriptor = this.registry.get(connector.kind);
    if (!descriptor?.webhook) throw new HttpException('unknown', HttpStatus.NOT_FOUND);

    // Durable per-connector rate limit (the email-intake precedent).
    if (this.limiter) {
      const max = this.options.webhookMaxPerWindow ?? WEBHOOK_MAX_PER_WINDOW_DEFAULT;
      const windowMs =
        (this.options.webhookRateWindowSeconds ?? WEBHOOK_RATE_WINDOW_SECONDS_DEFAULT) * 1000;
      const { count } = await this.limiter.hit(
        connectorId,
        'connector_webhook',
        windowMs,
        Date.now(),
      );
      if (count > max) throw new HttpException('slow down', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Signature over the raw bytes, before anything is parsed.
    const secret = await this.store.openWebhookSecret(connectorId);
    if (!secret) throw new HttpException('refused', HttpStatus.FORBIDDEN);
    const headers = lowercaseHeaders(request);
    const verdict = verifyWebhookSignature(descriptor.webhook, secret, raw, headers, new Date());
    if (!verdict.ok) {
      // Refusal detail goes to the log (identifiers only), never the caller.
      this.logger.warn(`webhook refused (${verdict.refusal}) for connector ${connectorId}`);
      throw new HttpException('refused', HttpStatus.FORBIDDEN);
    }

    // Only now is the body parsed, and only identifiers leave the parse.
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpException('unparseable', HttpStatus.BAD_REQUEST);
    }
    const event = descriptor.webhook.parseEvent(payload, headers);
    if (!event) throw new HttpException('unparseable', HttpStatus.BAD_REQUEST);

    // Dedup by event id; a duplicate delivery is a harmless 200.
    const enqueued = await this.db.transaction(async (tx) => {
      const delivery = await this.store.recordDelivery(tx, {
        connectorId,
        eventId: event.eventId,
        itemRefs: event.items,
      });
      if (!delivery) return false;
      await withTransactionalEnqueue(
        tx,
        {
          type: 'connector.webhook_received',
          payload: { connector_id: connectorId, delivery_id: delivery.id },
        },
        {
          type: CONNECTOR_WEBHOOK_JOB_TYPE,
          payload: { source_type: 'connector_webhook', source_id: delivery.id },
          principalId: connector.ownerId,
        },
      );
      return true;
    });
    return { accepted: enqueued };
  }
}

function lowercaseHeaders(request: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}
