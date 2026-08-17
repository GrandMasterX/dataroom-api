/**
 * Asserts that a database unique index rejected the write, and that it was the *intended*
 * index.
 *
 * Matching on the message text does not work: Prisma reports "Unique constraint failed on
 * the fields: (`node_id`)" and never names the index, so a test written against the
 * message would pass when a completely different constraint fired. With the pg driver
 * adapter the underlying name is available on the error, nested as
 * `meta.driverAdapterError.cause.originalMessage`, which is also how production code
 * decides whether a P2002 means "name taken" or something else entirely.
 */
export async function expectUniqueViolation(
  promise: Promise<unknown>,
  indexName: string,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }

  if (error === undefined) {
    throw new Error(`expected a unique violation on ${indexName}, but the write succeeded`);
  }

  const err = error as { code?: string; meta?: unknown };
  expect(err.code).toBe('P2002');
  expect(constraintNameOf(err.meta)).toBe(indexName);
}

/** Extracts the violated index name from Prisma's driver-adapter error payload. */
export function constraintNameOf(meta: unknown): string | undefined {
  const originalMessage = (
    meta as { driverAdapterError?: { cause?: { originalMessage?: string } } } | undefined
  )?.driverAdapterError?.cause?.originalMessage;

  return originalMessage?.match(/unique constraint "([^"]+)"/)?.[1];
}
