import { DEFAULT_SETTINGS, type ModelSettings } from '@dsh-hy-memory/contracts'

/**
 * Return whether a URL is an explicit HTTP(S) loopback address.
 * Hostnames that could resolve through DNS are never treated as local.
 */
export function isStrictLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1]
    if (url.username || url.password || !authority || authority.includes('@')) return false
    const rawHostname = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : authority.replace(/:\d*$/, '')
    const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
  } catch {
    return false
  }
}

/** Model egress is opt-in; configured credentials or endpoints do not grant it. */
export function modelPolicyAllowsSdkEgress(policy: ModelSettings): boolean {
  return policy.externalEgress === 'allow-configured'
}

/** The persisted model policy used when no store callback is supplied. */
export function defaultModelPolicy(): ModelSettings {
  return DEFAULT_SETTINGS.models
}

/** Stable policy representation used to detect settings changed after worker startup. */
export function modelPolicyFingerprint(policy: ModelSettings): string {
  return JSON.stringify({
    mode: policy.mode,
    extractionEndpointEnv: policy.extractionEndpointEnv,
    embeddingEndpointEnv: policy.embeddingEndpointEnv,
    externalEgress: policy.externalEgress,
    localOnly: policy.localOnly,
  })
}
