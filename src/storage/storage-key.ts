/**
 * Object key layout: `rooms/{dataRoomId}/{nodeId}/{fileVersionId}`.
 *
 * Keys are built exclusively from server-generated ids and never from user-supplied
 * names. Three properties follow for free:
 *
 *  1. Path traversal and unicode/case collisions are structurally impossible.
 *  2. Renaming a file touches metadata only — no object copy, no half-renamed state.
 *  3. A new version is a new key, so previous bytes are never overwritten.
 *
 * The user-facing filename is applied at read time through the signed
 * `response-content-disposition` parameter, so a download always reflects the current
 * name rather than the name at upload time.
 */
export function buildStorageKey(params: {
  dataRoomId: string;
  nodeId: string;
  fileVersionId: string;
}): string {
  return `rooms/${params.dataRoomId}/${params.nodeId}/${params.fileVersionId}`;
}
