/** Read a record entry only when the key belongs to the record itself. */
export function ownRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? (Reflect.get(record, key) as T)
    : undefined;
}

/** Return a copy with one own entry added or replaced. */
export function withRecordValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T,
): Record<string, T> {
  return Object.fromEntries([
    ...Object.entries(record).filter(([entryKey]) => entryKey !== key),
    [key, value],
  ]);
}

/** Return a copy without one own entry, preserving the original on a miss. */
export function withoutRecordKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}
