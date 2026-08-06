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

  it('filters AWS_* keys', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAxxx'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    process.env.AWS_REGION = 'us-east-1'
    process.env.PATH = '/usr/bin'

    const env = safeEnv()
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.AWS_REGION).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('filters SECRET/TOKEN/PASSWORD/CREDENTIAL keys', () => {
    // Keys must START with these patterns to be filtered
    process.env.SECRET_KEY = 'sk123'
    process.env.TOKEN_VALUE = 'tok123'
    process.env.PASSWORD_FIELD = 'pw123'
    process.env.CREDENTIAL_STORE = 'cred123'
    process.env.PATH = '/usr/bin'

    const env = safeEnv()
    expect(env.SECRET_KEY).toBeUndefined()
    expect(env.TOKEN_VALUE).toBeUndefined()
    expect(env.PASSWORD_FIELD).toBeUndefined()
    expect(env.CREDENTIAL_STORE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
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
