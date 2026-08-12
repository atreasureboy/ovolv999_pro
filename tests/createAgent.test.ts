import { describe, it, expect, afterEach } from 'vitest'
import { createAgentScaffold } from '../bin/createAgent.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('createAgent CLI scaffold generator', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('scaffolds a customer_service agent directory structure', () => {
    tmpDir = path.join(os.tmpdir(), `test-agent-${Date.now()}`)
    const res = createAgentScaffold({
      name: 'my-service-bot',
      preset: 'customer_service',
      targetDir: tmpDir,
    })

    expect(res.success).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, '.ovogo', 'agent.json'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'OVOGO.md'))).toBe(true)

    const agentJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.ovogo', 'agent.json'), 'utf-8'))
    expect(agentJson.name).toBe('my-service-bot')
    expect(agentJson.identity).toContain('智能客服助手')
    expect(agentJson.tools).toEqual(['WebFetch', 'TodoWrite'])
  })
})
