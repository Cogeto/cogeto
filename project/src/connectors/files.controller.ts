import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import type {
  FileDownloadDto,
  FileSourceDto,
  FileStatusDto,
  FileUploadedDto,
} from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { DocumentUploadInterceptor } from './document-upload.interceptor';
import { FilesService } from './files.service';

/** Zod at the boundary: the upload's scope selector + sensitive checkbox. */
const uploadFlagsSchema = z.object({
  scope: z.enum(MEMORY_SCOPES).default('private'),
  // Multipart text fields arrive as strings; accept the common truthy forms.
  sensitive: z
    .union([z.boolean(), z.enum(['true', 'false', 'on', 'off', '1', '0'])])
    .default(false)
    .transform((value) =>
      typeof value === 'boolean' ? value : value === 'true' || value === 'on' || value === '1',
    ),
});

/**
 * /api/files — the file source (O1), a sibling of /api/notes. Upload streams a
 * PDF/DOCX into the SAME ingestion pipeline as notes (extract → verify →
 * embed+store → reconcile). Deletion is NOT here: a file source is deleted
 * through the existing /api/sources saga, unchanged (F1 handoff).
 *
 * :key is the object key (path segments URL-encoded by the caller), exactly
 * like the source-deletion routes.
 */
@Controller('files')
@UseGuards(BearerAuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @UseInterceptors(DocumentUploadInterceptor)
  async upload(@Req() request: AuthenticatedRequest): Promise<FileUploadedDto> {
    const file = request.file;
    if (!file) throw new BadRequestException('no file provided (field name must be "file")');

    const parsed = uploadFlagsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { objectKey } = await this.files.upload(
      request.principal,
      {
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
      },
      parsed.data,
    );
    return { objectKey };
  }

  /** Pipeline progress for the per-file processing indicator. */
  @Get(':key/status')
  async status(
    @Req() request: AuthenticatedRequest,
    @Param('key') key: string,
  ): Promise<FileStatusDto> {
    // Owner-scoped: a non-owner learns nothing about another user's uploads.
    const source = await this.files.getSourceForOwner(request.principal, key);
    if (!source) throw new NotFoundException(`file ${key} not found`);
    return { state: source.state };
  }

  /** The source drawer's file facts (owner-only). */
  @Get(':key')
  async source(
    @Req() request: AuthenticatedRequest,
    @Param('key') key: string,
  ): Promise<FileSourceDto> {
    const source = await this.files.getSourceForOwner(request.principal, key);
    if (!source) throw new NotFoundException(`file ${key} not found`);
    return source;
  }

  /** A short-lived signed download URL (§A.9); sensitive files gate to the owner. */
  @Get(':key/download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('key') key: string,
  ): Promise<FileDownloadDto> {
    const link = await this.files.getDownloadUrl(request.principal, key);
    if (!link) throw new NotFoundException(`file ${key} not found`);
    return link;
  }
}
