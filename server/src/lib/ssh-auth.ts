import { execFileSync, spawnSync } from 'child_process'
import { platform } from 'os'

type AgentStatus = 'ready' | 'empty' | 'invalid'

function inspectAgent(env: NodeJS.ProcessEnv): AgentStatus {
  const result = spawnSync('ssh-add', ['-l'], {
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  if (result.status === 0) return 'ready'
  if (result.status === 1) return 'empty'
  return 'invalid'
}

function listAgentPids(): number[] {
  try {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : process.env.UID
    if (!uid) return []
    const output = execFileSync('pgrep', ['-u', uid, 'ssh-agent'], { encoding: 'utf-8' })
    return output
      .split('\n')
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

function listAgentSockets(pid: number): string[] {
  try {
    const output = execFileSync('lsof', ['-a', '-U', '-p', String(pid)], { encoding: 'utf-8' })
    return output
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/).at(-1) ?? '')
      .filter(path => path.startsWith('/'))
  } catch {
    return []
  }
}

function discoverWorkingAgentSock(baseEnv: NodeJS.ProcessEnv): string | null {
  const seen = new Set<string>()

  for (const pid of listAgentPids()) {
    for (const socket of listAgentSockets(pid)) {
      if (seen.has(socket)) continue
      seen.add(socket)
      const env = { ...baseEnv, SSH_AUTH_SOCK: socket }
      const status = inspectAgent(env)
      if (status === 'ready' || status === 'empty') return socket
    }
  }

  return null
}

function tryLoadAppleKeychain(env: NodeJS.ProcessEnv): void {
  if (platform() !== 'darwin') return

  spawnSync('ssh-add', ['--apple-load-keychain'], {
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
}

export function buildChildProcessEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  // npm leaks `npm_config_*` into child env when launched via `npm run`.
  // nvm refuses to initialize when `npm_config_prefix` is set, so strip them
  // so user shells see a clean environment.
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_config_') || key === 'npm_package_name' || key.startsWith('npm_lifecycle_')) {
      delete env[key]
    }
  }
  let agentStatus = inspectAgent(env)

  if (agentStatus === 'invalid' && platform() === 'darwin') {
    const socket = discoverWorkingAgentSock(env)
    if (socket) {
      env.SSH_AUTH_SOCK = socket
      process.env.SSH_AUTH_SOCK = socket
      agentStatus = inspectAgent(env)
    }
  }

  if (agentStatus === 'empty' && platform() === 'darwin') {
    tryLoadAppleKeychain(env)
    agentStatus = inspectAgent(env)
  }

  if ((agentStatus === 'ready' || agentStatus === 'empty') && env.SSH_AUTH_SOCK) {
    process.env.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK
  }

  return env
}
