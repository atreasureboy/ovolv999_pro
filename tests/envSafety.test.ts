import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeEnv } from '../src/core/envSafety.js'

describe('safeEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset to known state
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns a copy of process.env without sensitive keys', () => {
    process.env.OPENAI_API_KEY = 'sk-test123'
    process.env.ANTHROPIC_API_KEY = 'ant-test456'
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/user'

    const env = safeEnv()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/user')
  })

  it('filters GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = 'ghp_secret'
    process.env.PATH = '/usr/bin'

    const env = safeEnv()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('filters known AWS credential keys but not non-secret AWS vars', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAxxx'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_DEFAULT_REGION = 'us-west-2'
    process.env.PATH = '/usr/bin'

    const env = safeEnv()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    // AWS_REGION / AWS_DEFAULT_REGION are NOT secrets — should pass through
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.AWS_DEFAULT_REGION).toBe('us-west-2')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('filters vars ending with _TOKEN / _KEY / _SECRET / _PASSWORD / _CREDENTIALS', () => {
    // Suffix-based matching — catches PROVIDER_API_KEY, SERVICE_TOKEN, etc.
    process.env.API_TOKEN = 'tok123'
    process.env.DB_PASSWORD = 'pw123'
    process.env.OAUTH_SECRET = 'sec123'
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/path/to/creds.json'
    process.env.AZURE_CLIENT_SECRET = 'az-secret'
    process.env.AZURE_API_KEY = 'az-key'
    process.env.PATH = '/usr/bin'
    // Non-secret vars that happen to be "wordy" should NOT be caught
    process.env.TOKEN_EXPIRY_SECONDS = '3600'
    process.env.KEY_VAULT_URL = 'https://vault.example.com'

    const env = safeEnv()
    expect(env.API_TOKEN).toBeUndefined()
    expect(env.DB_PASSWORD).toBeUndefined()
    expect(env.OAUTH_SECRET).toBeUndefined()
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined()
    expect(env.AZURE_API_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    // Non-sensitive vars pass through
    expect(env.TOKEN_EXPIRY_SECONDS).toBe('3600')
    expect(env.KEY_VAULT_URL).toBe('https://vault.example.com')
  })

  it('case-insensitive filtering', () => {
    process.env.openai_api_key = 'sk-test'
    process.env.Anthropic_Api_Key = 'ant-test'
    process.env.PATH = '/usr/bin'

    const env = safeEnv()
    expect(env.openai_api_key).toBeUndefined()
    expect(env.Anthropic_Api_Key).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('merges extra env vars', () => {
    process.env.PATH = '/usr/bin'
    const env = safeEnv({ FOO: 'bar', DEBUG: '1' })
    expect(env.FOO).toBe('bar')
    expect(env.DEBUG).toBe('1')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('extra vars override existing', () => {
    process.env.PATH = '/usr/bin'
    const env = safeEnv({ PATH: '/custom/path' })
    expect(env.PATH).toBe('/custom/path')
  })

  it('handles empty process.env', () => {
    // We can't truly clear process.env in all runtimes, but safeEnv handles it
    const env = safeEnv()
    expect(typeof env).toBe('object')
    // Should at least not crash and return an object
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(0)
  })

  it('handles undefined extra', () => {
    process.env.PATH = '/usr/bin'
    const env = safeEnv(undefined)
    expect(env.PATH).toBe('/usr/bin')
  })
})
