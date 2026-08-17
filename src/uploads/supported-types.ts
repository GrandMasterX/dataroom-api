/**
 * What may be uploaded, and what may be rendered in the browser.
 *
 * `text/html` and `image/svg+xml` are absent on purpose: both can carry script, and an
 * object served inline executes on the storage origin. Anything not listed as inline is
 * served as an attachment, so the allowlist is a second line rather than the only one.
 */
export const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);

/**
 * Only PDFs are shown inline. The product renders PDFs, so that is the one type worth the
 * exposure; everything else downloads, which no viewer can turn into script execution.
 */
export function dispositionFor(mimeType: string): 'inline' | 'attachment' {
  return mimeType === 'application/pdf' ? 'inline' : 'attachment';
}
