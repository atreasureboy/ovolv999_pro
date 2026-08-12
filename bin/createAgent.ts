/**
 * createAgent — CLI scaffold generator for ovolv999 Agent Base.
 *
 * Generates custom domain agent presets (coding, customer-service, ops, audit)
 * with preconfigured .ovogo/agent.json, identity, tools, and rules.
 *
 * Usage:
 *   npx ovolv999 create-agent <agent-name> --preset <coding|customer_service|ops|audit>
 */

import fs from 'fs'
import path from 'path'

export interface CreateAgentOptions {
  name: string
  preset: 'coding' | 'customer_service' | 'ops' | 'audit' | 'custom'
  targetDir?: string
}

const PRESET_TEMPLATES: Record<
  string,
  {
    identity: string
    tools: string[]
    permissionMode: string
    description: string
  }
> = {
  customer_service: {
    identity:
      '你是一个专业的智能客服助手。解答用户的咨询、处理售后诉求、保持礼貌友善、不伪造任何未证实政策。',
    tools: ['WebFetch', 'TodoWrite'],
    permissionMode: 'auto',
    description: '智能客服 Agent 架构模板',
  },
  ops: {
    identity:
      '你是一个自动化运维 Agent。负责服务器巡检、命令诊断、日志排查与资源部署。谨防高危命令操作。',
    tools: ['Bash', 'FileRead', 'FileWrite', 'Grep', 'Glob'],
    permissionMode: 'ask',
    description: '自动化运维与巡检 Agent 架构模板',
  },
  audit: {
    identity:
      '你是一个安全审计与代码审查 Agent。客观识别潜在的安全漏洞、配置缺陷与风险模式，并提供修复建议。',
    tools: ['FileRead', 'Grep', 'Glob'],
    permissionMode: 'auto',
    description: '安全审计与代码审查 Agent 架构模板',
  },
  coding: {
    identity:
      '你是一个自主软件工程 Agent。遵循项目既有风格与测试约定，准确修改代码、运行验证并解决 Bug。',
    tools: ['Bash', 'FileRead', 'FileWrite', 'FileEdit', 'FileMultiEdit', 'Glob', 'Grep', 'TodoWrite'],
    permissionMode: 'ask',
    description: '自主软件工程 Coding Agent 模板',
  },
  custom: {
    identity: '你是一个通用自定义领域智能体助手。高效、准备、基于事实响应用户任务。',
    tools: ['FileRead', 'FileWrite', 'Bash', 'Grep', 'Glob'],
    permissionMode: 'auto',
    description: '通用领域智能体模板',
  },
}

export function createAgentScaffold(options: CreateAgentOptions): { success: boolean; dir: string; message: string } {
  const { name, preset, targetDir } = options
  const template = PRESET_TEMPLATES[preset] ?? PRESET_TEMPLATES.custom
  const outDir = targetDir ?? path.join(process.cwd(), name)

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true })
  }

  const ovogoDir = path.join(outDir, '.ovogo')
  if (!fs.existsSync(ovogoDir)) {
    fs.mkdirSync(ovogoDir, { recursive: true })
  }

  // 1. Create .ovogo/agent.json
  const agentJson = {
    name,
    version: '0.1.0',
    description: template.description,
    identity: template.identity,
    permission: {
      mode: template.permissionMode,
    },
    tools: template.tools,
    modules: ['memory', 'workspace'],
  }

  fs.writeFileSync(path.join(ovogoDir, 'agent.json'), JSON.stringify(agentJson, null, 2), 'utf-8')

  // 2. Create OVOGO.md
  const ovogoMd = `# ${name} — ${template.description}

## Agent Identity
${template.identity}

## Included Tools
${template.tools.map((t) => `- ${t}`).join('\n')}

## Quick Start
\`\`\`bash
npx ovolv999 --agent .ovogo/agent.json "你的指令"
\`\`\`
`

  fs.writeFileSync(path.join(outDir, 'OVOGO.md'), ovogoMd, 'utf-8')

  return {
    success: true,
    dir: outDir,
    message: `Successfully scaffolded Agent "${name}" [preset: ${preset}] at ${outDir}`,
  }
}
