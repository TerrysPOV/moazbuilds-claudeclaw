// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MigrationFn = (record: any) => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MIGRATIONS: Record<number, MigrationFn> = {
  // future migrations: 2: (r) => ({ ...r, newField: 'default' }),
};

export const CURRENT_SCHEMA_VERSION = 1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateRecord(record: any, fromVersion = 1): any {
  let current = fromVersion;
  while (current < CURRENT_SCHEMA_VERSION) {
    const fn = MIGRATIONS[current + 1];
    if (fn) record = fn(record);
    current++;
  }
  return record;
}

export function detectSchemaVersion(firstLine: string): number {
  try {
    const data = JSON.parse(firstLine) as Record<string, unknown>;
    return typeof data.schema_version === "number" ? data.schema_version : 1;
  } catch {
    return 1;
  }
}
