/**
 * Encode native JSON values with sorted object keys and ECMAScript number/string
 * spelling. Array order is significant. Unsupported values are rejected rather
 * than silently dropped or converted to null by JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new Error('CANONICAL_NUMBER_INVALID')
      return JSON.stringify(item)
    }
    if (typeof item !== 'object') throw new Error('CANONICAL_VALUE_INVALID')
    if (ancestors.has(item)) throw new Error('CANONICAL_CYCLE')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new Error('CANONICAL_OBJECT_INVALID')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('CANONICAL_VALUE_INVALID')
    // Plain parsed JSON has enumerable data properties only. Do not execute a
    // getter or silently omit extra array/object properties while fingerprinting.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue
      if (!('value' in descriptor) || !descriptor.enumerable)
        throw new Error('CANONICAL_VALUE_INVALID')
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        throw new Error('CANONICAL_VALUE_INVALID')
    }
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        const values: string[] = []
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new Error('CANONICAL_VALUE_INVALID')
          values.push(encode(item[index]))
        }
        return `[${values.join(',')}]`
      }
      const record = item as Record<string, unknown>
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        .join(',')}}`
    } finally {
      ancestors.delete(item)
    }
  }
  return encode(value)
}
