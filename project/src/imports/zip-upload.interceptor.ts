import { Inject, Injectable, Optional, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { IMPORT_ZIP_MAX_BYTES_DEFAULT } from './import.service';

export const IMPORT_ZIP_MAX_BYTES = Symbol('IMPORT_ZIP_MAX_BYTES');

/**
 * The archive-sized twin of the document upload interceptor: a ZIP holds a
 * whole corpus, so its cap (default 200 MiB, env-tunable) is deliberately
 * larger than the single-document cap; every ENTRY still faces the normal
 * per-file validation when it is ingested.
 */
@Injectable()
export class ZipUploadInterceptor implements NestInterceptor {
  private readonly middleware: ReturnType<ReturnType<typeof multer>['single']>;

  constructor(
    @Optional() @Inject(IMPORT_ZIP_MAX_BYTES) maxBytes: number = IMPORT_ZIP_MAX_BYTES_DEFAULT,
  ) {
    this.middleware = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxBytes, files: 1 },
    }).single('file');
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    await new Promise<void>((resolve, reject) => {
      this.middleware(request, response, (error: unknown) => {
        if (!error) return resolve();
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return reject(new PayloadTooLargeException('the archive exceeds the size limit'));
        }
        return reject(error);
      });
    });
    return next.handle();
  }
}
