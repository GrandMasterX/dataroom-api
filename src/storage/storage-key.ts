/**
 * Object key layout: `rooms/{dataRoomId}/{uploadIntentId}`.
 *
 * Keys are built exclusively from server-generated ids and never from user-supplied names.
 * Three properties follow for free:
 *
 *  1. Path traversal and unicode or case collisions are structurally impossible.
 *  2. Renaming a file touches metadata only — no object copy, no half-renamed state.
 *  3. A new version is a new key, so previous bytes are never overwritten.
 *
 * The key is keyed on the upload rather than on the node because, at the moment the URL is
 * signed, the destination node is not settled yet: the same bytes may end up as a new file
 * or as a new version of an existing one, depending on what the user answers about a name
 * collision. The upload's own id is stable across both outcomes, and the resulting
 * FileVersion adopts it, so an object and the row describing it share one identifier.
 *
 * The room prefix keeps per-room lifecycle rules and bulk cleanup straightforward.
 *
 * The user-facing filename is applied at read time through the signed
 * `response-content-disposition` parameter, so a download always reflects the current name
 * rather than the name at upload time.
 */
export function buildStorageKey(params: {
  dataRoomId: string;
  uploadIntentId: string;
}): string {
  return `rooms/${params.dataRoomId}/${params.uploadIntentId}`;
}
