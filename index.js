import { autostartStatus, enableAutostart, disableAutostart, autostartVerify } from './lib/autostart.js'

export const name = 'dsh-autostart'
export const inject = ['tools']

const textOutput = {
  schema: { type: 'string' },
  render: (_arguments, value) => [{ type: 'text', text: String(value) }],
}

const noParameters = { type: 'object', properties: {}, additionalProperties: false }

export const tools = [
  {
    name: 'autostart_status',
    description:
      'Report whether DeepSeek Harness will start automatically when this Windows user signs in: the Startup-folder shortcut, the wscript/PowerShell launcher scripts, the Windows startup-approval entry, Smart App Control state, and the last launcher log lines. Read-only.',
    parameters: noParameters,
    output: textOutput,
    async execute() {
      return autostartStatus()
    },
  },
  {
    name: 'autostart_enable',
    description:
      'Enable sign-in autostart for DeepSeek Harness on Windows. Deploys the signed wscript -> hidden PowerShell launcher into %LOCALAPPDATA%\\DSH, creates the Startup-folder shortcut, marks it approved, then runs the launcher chain once in guard mode (DSH is already running) to verify the chain works. Use when the user asks to make DeepSeek Harness start automatically at Windows sign-in.',
    parameters: {
      type: 'object',
      properties: {
        verifyChain: {
          type: 'boolean',
          description: 'Run the launcher chain once after enabling to verify it works (default true).',
        },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(arguments_) {
      return enableAutostart({ verifyChain: arguments_?.verifyChain })
    },
  },
  {
    name: 'autostart_disable',
    description:
      'Disable sign-in autostart for DeepSeek Harness on Windows by removing the Startup-folder shortcut and its startup-approval entry. The launcher scripts stay in %LOCALAPPDATA%\\DSH so autostart can be re-enabled later.',
    parameters: noParameters,
    output: textOutput,
    async execute() {
      return disableAutostart()
    },
  },
  {
    name: 'autostart_verify',
    description:
      'Run end-to-end checks of DeepSeek Harness sign-in autostart on Windows: launcher files, shortcut target and arguments, startup-approval state, and a live guard-mode run of the wscript -> PowerShell launcher chain in a temporary LOCALAPPDATA. Use after enabling or when autostart appears broken.',
    parameters: {
      type: 'object',
      properties: {
        runChain: {
          type: 'boolean',
          description: 'Run the live launcher chain check (default true).',
        },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(arguments_) {
      return autostartVerify({ runChain: arguments_?.runChain })
    },
  },
]

export function apply(ctx) {
  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
