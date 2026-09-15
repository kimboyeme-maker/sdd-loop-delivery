import { canonicalJson } from './wire/canonical-json'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/** Derive a domain-separated Ed25519 seed; only the role's token holder can sign. */
function signingKey(token: string) {
  if (!token) throw new Error('ROLE_SIGNING_TOKEN_REQUIRED')
  const seed = createHash('sha256')
    .update('sdd-loop/role-event/ed25519/v1\0')
    .update(token)
    .digest()
  // RFC 8410 PKCS#8 Ed25519 private-key envelope followed by the 32-byte seed.
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8'
  })
}

/** Public verification material may be retained with a lease after role credentials are removed. */
export function rolePublicKey(token: string): string {
  return createPublicKey(signingKey(token))
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
}

/** Sign exactly this event body; its version and actor bindings are covered by the signature. */
export function signRoleEvent(
  body: Record<string, unknown>,
  token: string
): Record<string, unknown> {
  // Validate before spreading so getters and lossy JSON values cannot be signed.
  canonicalJson(body)
  const signed = { ...body, signature_algorithm: 'ed25519-role-v1' }
  return {
    ...signed,
    signature: sign(null, Buffer.from(JSON.stringify(signed)), signingKey(token)).toString('base64')
  }
}

/** Verify native role evidence without giving the consumer the role's signing secret. */
export function verifyRoleEvent(event: Record<string, unknown>, publicKey: string): boolean {
  try {
    canonicalJson(event)
    if (event.signature_algorithm !== 'ed25519-role-v1' || typeof event.signature !== 'string')
      return false
    const { signature, ...body } = event
    const keyBytes = Buffer.from(publicKey, 'base64')
    const signatureBytes = Buffer.from(signature, 'base64')
    // Buffer's permissive decoder ignores whitespace and invalid characters.
    // Native event encoding has one representation; malformed aliases are rejected.
    if (
      keyBytes.toString('base64') !== publicKey ||
      signatureBytes.toString('base64') !== signature ||
      signatureBytes.length !== 64
    )
      return false
    const key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verify(null, Buffer.from(JSON.stringify(body)), key, signatureBytes)
  } catch {
    return false
  }
}
