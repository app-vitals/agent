/**
 * AGR-6.1: typeName -> specialty rename, ADD step. `Agent.specialty` is a
 * nullable column written alongside `typeName`; reads prefer it and fall back
 * to `typeName` for rows that predate the column. Nothing is retired yet.
 */

export interface SpecialtyBearingRow {
  typeName: string;
  specialty?: string | null;
}

/** The agent's specialty: the new column when set, else the legacy `typeName`. */
export function resolveSpecialty(row: SpecialtyBearingRow): string {
  return row.specialty ?? row.typeName;
}

/** Returns the row with `specialty` resolved to a non-null string. */
export function withResolvedSpecialty<T extends SpecialtyBearingRow>(
  row: T,
): Omit<T, "specialty"> & { specialty: string } {
  return { ...row, specialty: resolveSpecialty(row) };
}
