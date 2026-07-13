import { Catch, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ModelBudgetExceededError } from '../model-gateway/index';

/**
 * Maps a spent daily model budget (FIX-2 QS-2) to HTTP 429 for ordinary JSON
 * endpoints. The chat SSE endpoint handles it itself (headers are already sent
 * mid-stream), so this filter only fires when the response has not started —
 * it re-throws otherwise so the stream handler's own error path runs.
 */
@Catch(ModelBudgetExceededError)
export class ModelBudgetExceptionFilter implements ExceptionFilter {
  catch(exception: ModelBudgetExceededError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) throw exception;
    response.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: 'model_budget_exceeded',
      message: exception.message,
    });
  }
}
