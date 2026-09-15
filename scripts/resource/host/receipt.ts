import { parseHostSpawnReceipt, type HostSpawnReceipt } from '../../schemas/host'

/** Adapt a caller-supplied host receipt without inventing runtime identity. */
export function hostSpawnReceipt(input: unknown): HostSpawnReceipt {
  return parseHostSpawnReceipt(input)
}
