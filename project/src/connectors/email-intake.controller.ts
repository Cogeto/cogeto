import {
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../identity/index';
import { EmailIntakeService } from './email-intake.service';
import { MailIntakeGuard } from './mail-intake.guard';

/**
 * The internal email-intake endpoint (Session O4, decision 0028 ruling 7):
 * the Haraka queue hook POSTs the full raw RFC822 here (Content-Type
 * message/rfc822; envelope in X-Cogeto-Mail-From / X-Cogeto-Rcpt-To) with the
 * shared-secret bearer. It is NOT public — it opts out of the global bearer
 * guard (@Public) and applies MailIntakeGuard instead — and is reachable only on
 * the internal network (the mail service). The HTTP status IS the SMTP verdict
 * Haraka relays to the sending server:
 *   200 → 250 queued · 403 → 550 refused · 413 → 552 too large.
 *
 * The raw body is parsed by an express.raw() handler scoped to this path in the
 * app bootstrap (message-sized limit), so `req.body` is a Buffer here.
 */
@Public()
@Controller('email/intake')
@UseGuards(MailIntakeGuard)
export class EmailIntakeController {
  constructor(private readonly intake: EmailIntakeService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('cache-control', 'no-store')
  async receive(@Req() request: Request): Promise<{ status: string; emailId?: string }> {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (raw.length === 0) {
      throw new HttpException('empty message', HttpStatus.BAD_REQUEST);
    }
    const envelope = {
      mailFrom: headerValue(request, 'x-cogeto-mail-from'),
      rcptTo: headerValue(request, 'x-cogeto-rcpt-to'),
    };
    const result = await this.intake.intake(raw, envelope);
    if (result.accepted) return { status: 'queued', emailId: result.emailId };

    const status =
      result.status === 'too_large'
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : result.status === 'bad_recipient'
          ? HttpStatus.FORBIDDEN
          : HttpStatus.FORBIDDEN;
    throw new HttpException({ status: 'refused', reason: result.reason }, status);
  }
}

function headerValue(request: Request, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
