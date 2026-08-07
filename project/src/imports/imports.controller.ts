import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import type { ImportItemDto, ImportRunDetailDto, ImportRunDto } from '@cogeto/shared';
import { parseOrBadRequest, RateLimit, RateLimitGuard } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { DocumentUploadInterceptor } from '../files/index';
import { ImportService } from './import.service';
import { ZipUploadInterceptor } from './zip-upload.interceptor';

const folderSchema = z.object({
  sourceLabel: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(1_000),
        sizeBytes: z.number().int().min(0),
        contentHash: z.string().regex(/^[0-9a-f]{64}$/i, 'a sha256 hex hash'),
      }),
    )
    .min(1)
    .max(20_000),
});

const s3Schema = z.object({
  url: z.url(),
  accessKey: z.string().min(1).max(200),
  secretKey: z.string().min(1).max(200),
  bucket: z.string().min(1).max(200),
  prefix: z.string().max(500).optional(),
});

const excludeSchema = z.object({ itemIds: z.array(z.uuid()).min(1).max(20_000) });
const confirmSchema = z.object({ s3: s3Schema.optional() });

/**
 * /api/imports — bulk import (V2.2 item 5.3): manifest first, confirm
 * explicitly, watch honestly, keep the record. Credentials in a confirm body
 * are used for the staging copy and never stored.
 */
@Controller('imports')
@UseGuards(BearerAuthGuard)
export class ImportsController {
  constructor(private readonly imports: ImportService) {}

  @Post('zip')
  @UseGuards(RateLimitGuard)
  @RateLimit('upload')
  @UseInterceptors(ZipUploadInterceptor)
  async zip(@Req() request: AuthenticatedRequest): Promise<ImportRunDetailDto> {
    const file = request.file;
    if (!file) throw new BadRequestException('no archive provided (field name must be "file")');
    return this.imports.createZipManifest(request.principal, {
      buffer: file.buffer,
      originalName: file.originalname,
    });
  }

  @Post('folder')
  async folder(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ImportRunDetailDto> {
    const parsed = parseOrBadRequest(folderSchema, body);
    return this.imports.createFolderManifest(request.principal, parsed);
  }

  @Post('s3')
  async s3(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ImportRunDetailDto> {
    const parsed = parseOrBadRequest(s3Schema, body);
    return this.imports.createS3Manifest(request.principal, parsed);
  }

  @Post(':id/items/:itemId/file')
  @UseGuards(RateLimitGuard)
  @RateLimit('upload')
  @UseInterceptors(DocumentUploadInterceptor)
  async stageItem(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<ImportItemDto> {
    const file = request.file;
    if (!file) throw new BadRequestException('no file provided (field name must be "file")');
    return this.imports.stageFolderItem(request.principal, id, itemId, {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
  }

  @Post(':id/exclude')
  async exclude(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ImportRunDetailDto> {
    const parsed = parseOrBadRequest(excludeSchema, body);
    await this.imports.exclude(request.principal, id, parsed.itemIds);
    return this.imports.detail(request.principal, id);
  }

  @Post(':id/confirm')
  async confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ImportRunDto> {
    const parsed = parseOrBadRequest(confirmSchema, body ?? {});
    return this.imports.confirm(request.principal, id, parsed);
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportRunDto> {
    return this.imports.cancel(request.principal, id);
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<ImportRunDto[]> {
    return this.imports.list(request.principal);
  }

  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportRunDetailDto> {
    return this.imports.detail(request.principal, id);
  }
}
