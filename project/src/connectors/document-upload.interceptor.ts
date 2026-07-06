import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { Observable } from 'rxjs';
import { FILE_UPLOAD_OPTIONS } from './file-upload-options';
import type { FileUploadOptions } from './file-upload-options';

/**
 * Streams the single multipart `file` field into memory, with the configured
 * size cap enforced by multer itself (a stock FileInterceptor's limit is fixed
 * at decoration time — this injects the runtime value instead). The worker
 * needs the bytes only briefly; memory storage is right for note-sized docs at
 * worker concurrency 2 (§A.3). Text fields (scope, sensitive) land on req.body.
 */
@Injectable()
export class DocumentUploadInterceptor implements NestInterceptor {
  private readonly middleware: ReturnType<ReturnType<typeof multer>['single']>;

  constructor(@Inject(FILE_UPLOAD_OPTIONS) options: FileUploadOptions) {
    this.middleware = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: options.uploadMaxBytes, files: 1 },
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
          return reject(new PayloadTooLargeException('the uploaded file exceeds the size limit'));
        }
        return reject(error);
      });
    });

    return next.handle();
  }
}
