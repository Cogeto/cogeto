import { Module } from '@nestjs/common';

/**
 * connectors — notes, calendar, email, in that order (§A.11; decision 0003
 * ruling 4: OAuth callbacks/webhooks in app; all sync as worker jobs; tokens
 * encrypted at callback, decrypted only in the worker). Shell module until
 * the Notes connector.
 */
@Module({})
export class ConnectorsModule {}
