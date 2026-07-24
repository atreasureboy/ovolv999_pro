import { describe, it, expect } from 'vitest'
import { SecretSanitizer } from '../src/core/sanitizer.js'

describe('SecretSanitizer', () => {
  it('redacts OpenAI and Anthropic API keys', () => {
    const text = 'API key is sk-1234567890abcdef1234567890 and anthropic is sk-ant-api03-abcdef12345678901234'
    const redacted = SecretSanitizer.redact(text)
    expect(redacted).not.toContain('sk-1234567890')
    expect(redacted).not.toContain('sk-ant-api03')
    expect(redacted).toContain('[REDACTED_SECRET]')
  })

  it('redacts AWS Access Keys and Secret Access Keys', () => {
    const text = 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE\naws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const redacted = SecretSanitizer.redact(text)
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
  })

  it('redacts Slack tokens and JWT tokens', () => {
    const text = 'slack: xoxb-1234567890-abcdefghij\njwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
    const redacted = SecretSanitizer.redact(text)
    expect(redacted).not.toContain('xoxb-1234567890')
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('redacts database credentials in URLs', () => {
    const text = 'Connect to postgres://user:super_secret_pass@localhost:5432/mydb'
    const redacted = SecretSanitizer.redact(text)
    expect(redacted).not.toContain('super_secret_pass')
  })

  it('redacts sensitive fields in deep objects', () => {
    const obj = {
      username: 'admin',
      token: 'secret_token_val_123',
      nested: {
        apiKey: 'sk-1234567890abcdef1234567890',
        data: 'public_info',
      },
    }
    const sanitized = SecretSanitizer.redactObject(obj)
    expect(sanitized.token).toBe('[REDACTED_SECRET]')
    expect(sanitized.nested.apiKey).toBe('[REDACTED_SECRET]')
    expect(sanitized.nested.data).toBe('public_info')
    expect(sanitized.username).toBe('admin')
  })
})
