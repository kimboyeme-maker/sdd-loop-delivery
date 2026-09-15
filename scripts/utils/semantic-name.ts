/**
 * Compare semantic subjects and owner names without case, width or surrounding whitespace
 * differences; never apply to runtime IDs or paths.
 */
export function semanticName(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().toLowerCase()
}
