import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  DEFAULT_UPLOAD_MAX_BYTES,
} from '@cogeto/shared';
import { i18next } from './i18n';

/**
 * Client-side pre-check for every upload affordance (the Sources upload card
 * and the chat paperclip — V2.2 item 5.1: one validation, two doors). The
 * server re-validates type (magic bytes) and size. Returns a TRANSLATED
 * message: these are field-validation strings a user reads, so they live in
 * the `validation` namespace.
 */
export function validateUploadFile(file: File): string | null {
  const name = file.name.toLowerCase();
  const okExt = ALLOWED_UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext));
  const okType = !file.type || ALLOWED_UPLOAD_CONTENT_TYPES.includes(file.type);
  if (!okExt && !okType) return i18next.t('validation:upload.unsupportedType');
  if (file.size > DEFAULT_UPLOAD_MAX_BYTES) {
    return i18next.t('validation:upload.tooLarge', {
      megabytes: Math.round(DEFAULT_UPLOAD_MAX_BYTES / (1024 * 1024)),
    });
  }
  if (file.size === 0) return i18next.t('validation:upload.empty');
  return null;
}
