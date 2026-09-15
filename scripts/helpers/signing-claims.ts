/**
 * Select claim fields without reading keys or signing on a caller's behalf.
 * Missing fields are omitted; boundary validation must require any mandatory claims
 * before using this projection. Selection alone is not identity verification.
 */
export function signingClaims<T extends Record<string, unknown>>(
  value: T,
  fields: readonly (keyof T)[]
): Partial<T> {
  return Object.fromEntries(
    fields.filter((field) => field in value).map((field) => [field, value[field]])
  ) as Partial<T>
}
