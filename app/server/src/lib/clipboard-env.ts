import { readdirSync, statSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'

export interface ClipboardEnv {
  DISPLAY?: string
  XAUTHORITY?: string
  WAYLAND_DISPLAY?: string
}

// On GNOME/Wayland the YACO server (started by systemd-user) lacks DISPLAY
// and XAUTHORITY because they live in the graphical-session env, not the
// service env. xclip and arboard-based tools (codex) refuse to talk to the
// X server without them. mutter writes a per-session Xauthority cookie to
// /run/user/$UID/.mutter-Xwaylandauth.<random> — discover it dynamically.
export function discoverClipboardEnv(): ClipboardEnv {
  if (platform() !== 'linux') return {}

  const env: ClipboardEnv = {}
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!runtimeDir) return env

  if (!process.env.XAUTHORITY) {
    try {
      const candidates = readdirSync(runtimeDir)
        .filter(name => name.startsWith('.mutter-Xwaylandauth.'))
        .map(name => {
          const path = join(runtimeDir, name)
          return { path, mtime: statSync(path).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates[0]) env.XAUTHORITY = candidates[0].path
    } catch {
      // No graphical session — leave empty; clipboard ops will fail gracefully.
    }
  }

  if (!process.env.DISPLAY && env.XAUTHORITY) {
    env.DISPLAY = ':0'
  }

  if (!process.env.WAYLAND_DISPLAY && env.XAUTHORITY) {
    env.WAYLAND_DISPLAY = 'wayland-0'
  }

  return env
}
