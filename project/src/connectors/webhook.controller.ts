import {
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  DRIZZLE,
  InMemoryRateLimitStore,
  RateLimitStore,
  untranslatedError,
  withTransactionalEnqueue,
} from '../infrastructure/index';
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
  /**
   * Never absent (issue #636). It used to be an optional field the request
   * path skipped entirely when unbound, which made the ONE unauthenticated
   * endpoint in the product the only rate-limited surface whose limiter could
   * silently not be there. `LimitsModule` is global and binds a durable store
   * in both composition roots, so the gap was latent rather than live — but an
   * unauthenticated endpoint is the wrong one to leave conditional, and the
   * other two limiter call sites (`RateLimitGuard`, the mail intake) already
   * fall back to an in-process store rather than to nothing. This does the
   * same: a bare construction gets a working limiter with a per-process
   * window, which is the pre-durable behaviour, not an open door.
   */
  private readonly limiter: RateLimitStore;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONNECTORS_OPTIONS) private readonly options: ConnectorsOptions,
    private readonly registry: ConnectorRegistry,
    private readonly store: ConnectorStore,
    @Optional() limiter?: RateLimitStore,
  ) {
    this.limiter = limiter ?? new InMemoryRateLimitStore();
  }

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
      throw untranslatedError.tooLarge('refused');
    }

    // ONE refusal for every pre-verification failure (issue #636).
    //
    // These used to answer 404 for an unknown, inactive or non-webhook
    // connector and 403 for a bad signature, which made the endpoint an
    // EXISTENCE ORACLE: an unauthenticated caller with no secret could walk
    // identifiers and read the difference between the two responses to learn
    // which connectors an instance has and which of them are live. The
    // identifier is a uuid so the walk is not cheap, but the endpoint is the
    // hostile-facing one and it should not answer questions at all.
    //
    // Every branch below now answers the same 403 with the same body. The
    // caller cannot distinguish "no such connector" from "wrong signature",
    // and the log keeps the real reason with the identifier for the operator.
    // A response-time difference remains (an unknown id skips the HMAC), which
    // is a far weaker signal than a status code and not worth contorting the
    // order of operations to hide.
    const refused = (reason: string): Error => {
      this.logger.warn(`webhook refused (${reason}) for connector ${connectorId}`);
      return untranslatedError.forbidden('refused');
    };

    if (!/^[0-9a-f-]{36}$/i.test(connectorId)) throw refused('malformed_id');
    const connector = await this.store.byId(connectorId);
    if (!connector) throw refused('unknown_connector');
    if (!SYNCABLE_STATES.includes(connector.state)) throw refused('connector_not_syncable');
    const descriptor = this.registry.get(connector.kind);
    if (!descriptor?.webhook) throw refused('kind_has_no_webhook');

    // Durable per-connector rate limit (the email-intake precedent). The one
    // refusal that is deliberately NOT uniform: 429 is the answer an honest
    // upstream must be able to read, and it is reached only for an identifier
    // the lookup above already accepted.
    const max = this.options.webhookMaxPerWindow ?? WEBHOOK_MAX_PER_WINDOW_DEFAULT;
    const windowMs =
      (this.options.webhookRateWindowSeconds ?? WEBHOOK_RATE_WINDOW_SECONDS_DEFAULT) * 1000;
    const { count } = await this.limiter.hit(
      connectorId,
      'connector_webhook',
      windowMs,
      Date.now(),
    );
    if (count > max) throw untranslatedError.tooManyRequests('slow down');

    // Signature over the raw bytes, before anything is parsed.
    const secret = await this.store.openWebhookSecret(connectorId);
    // Named WITHOUT the column's own identifier: `webhook-secret-confinement`
    // asserts that name appears in exactly one file, and a log string that
    // happened to contain it would quietly spend that guard's meaning.
    if (!secret) throw refused('secret_unavailable');
    const headers = lowercaseHeaders(request);
    const verdict = verifyWebhookSignature(descriptor.webhook, secret, raw, headers, new Date());
    if (!verdict.ok) throw refused(verdict.refusal);

    // Only now is the body parsed, and only identifiers leave the parse.
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw untranslatedError.badRequest('unparseable');
    }
    const event = descriptor.webhook.parseEvent(payload, headers);
    if (!event) throw untranslatedError.badRequest('unparseable');

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
