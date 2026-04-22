// --- Types matching design doc ---

export type WorkstreamStatus = 'active' | 'human_review' | 'blocked' | 'parked' | 'done'
export type ProgressType = 'info' | 'human_review' | 'blocked'
export type ProgressStatus = 'active' | 'dismissed'
export type SessionStatus = 'processing' | 'idle'  // from multmux status

export interface Project {
  id: string
  name: string
  path: string
}

export interface Workstream {
  id: string        // folder name under projects/active/
  name: string
  status: WorkstreamStatus
  project: string
  doc?: string      // optional primary doc filename
  checkpoints: { label: string; done: boolean }[]
}

export interface AgentSession {
  id: string
  agent: 'claude' | 'codex'
  handle: string            // tmux session handle
  status: SessionStatus     // from multmux status
  project: string
  label: string
  startedAt: string
}

// From progress.json — append-only notification log
export interface ProgressEntry {
  id: string
  agent: 'claude' | 'codex'
  type: ProgressType
  message: string
  project: string
  workstream: string
  timestamp: string
  status: ProgressStatus
}

export interface DocFile {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: DocFile[]
}

// --- Mock Data ---

export const projects: Project[] = [
  { id: 'openweb', name: 'OpenWeb', path: '~/workspace/openweb' },
  { id: 'android-agent', name: 'Android Agent', path: '~/workspace/android-agent' },
  { id: 'workflow', name: 'Workflow', path: '~/workspace/workflow' },
]

export const workstreams: Workstream[] = [
  {
    id: 'smart-capsule-v2',
    name: 'Smart Capsule v2',
    status: 'active',
    project: 'openweb',
    doc: 'design.md',
    checkpoints: [
      { label: 'Design approved', done: true },
      { label: 'Core impl complete', done: false },
      { label: 'Cross review passed', done: false },
    ],
  },
  {
    id: 'auth-rewrite',
    name: 'Auth Middleware Rewrite',
    status: 'human_review',
    project: 'openweb',
    doc: 'design.md',
    checkpoints: [
      { label: 'Design approved', done: true },
      { label: 'Impl complete', done: true },
      { label: 'Cross review passed', done: false },
    ],
  },
  {
    id: 'autotune-v3',
    name: 'Autotune Scorer v3',
    status: 'blocked',
    project: 'android-agent',
    doc: 'note.md',
    checkpoints: [
      { label: 'Baseline captured', done: true },
      { label: 'Target accuracy reached', done: false },
    ],
  },
  {
    id: 'v0',
    name: 'Workflow System Design',
    status: 'active',
    project: 'workflow',
    doc: 'final/design_aligned.md',
    checkpoints: [
      { label: 'Design aligned', done: true },
      { label: 'UI prototype reviewed', done: false },
    ],
  },
  {
    id: 'prompt-opt',
    name: 'Prompt Template Optimization',
    status: 'parked',
    project: 'android-agent',
    doc: 'note.md',
    checkpoints: [
      { label: 'Eval framework defined', done: true },
      { label: 'Token budget constraints added', done: false },
    ],
  },
  {
    id: 'feed-ranking',
    name: 'Feed Ranking Algorithm',
    status: 'done',
    project: 'openweb',
    doc: 'design.md',
    checkpoints: [
      { label: 'Design approved', done: true },
      { label: 'Impl complete', done: true },
      { label: 'Review passed', done: true },
    ],
  },
]

export const agentSessions: AgentSession[] = [
  { id: 'ses-1', agent: 'claude', handle: 'claude-impl', status: 'processing', project: 'openweb', label: '/implement phase 2', startedAt: '2026-03-18T17:30:00' },
  { id: 'ses-2', agent: 'codex', handle: 'codex-auth-review', status: 'idle', project: 'openweb', label: 'Cross review R2', startedAt: '2026-03-18T15:00:00' },
  { id: 'ses-3', agent: 'claude', handle: 'claude-autotune', status: 'processing', project: 'android-agent', label: 'Autotune loop round 7', startedAt: '2026-03-18T14:00:00' },
  { id: 'ses-4', agent: 'codex', handle: 'codex-review', status: 'idle', project: 'openweb', label: 'Design review R1', startedAt: '2026-03-18T16:00:00' },
  { id: 'ses-5', agent: 'claude', handle: 'claude-workflow', status: 'idle', project: 'workflow', label: '/double-design v0', startedAt: '2026-03-18T18:30:00' },
]

export const progressEntries: ProgressEntry[] = [
  {
    id: 'p-1',
    agent: 'codex',
    type: 'human_review',
    message: 'Cross review R2 complete — 3 findings (1 high, 2 medium). Needs your review.',
    project: 'openweb',
    workstream: 'Auth Middleware Rewrite',
    timestamp: '2026-03-18T17:30:00',
    status: 'active',
  },
  {
    id: 'p-2',
    agent: 'claude',
    type: 'blocked',
    message: 'Implementation blocked: capsule schema migration requires manual approval of DROP column.',
    project: 'openweb',
    workstream: 'Smart Capsule v2',
    timestamp: '2026-03-18T18:45:00',
    status: 'active',
  },
  {
    id: 'p-3',
    agent: 'claude',
    type: 'blocked',
    message: 'Autotune loop round 7: accuracy stuck at 0.847 for 3 consecutive rounds. May need constraint redefinition.',
    project: 'android-agent',
    workstream: 'Autotune Scorer v3',
    timestamp: '2026-03-18T18:50:00',
    status: 'active',
  },
  {
    id: 'p-4',
    agent: 'claude',
    type: 'info',
    message: 'Implementation phase 1 complete. Starting phase 2.',
    project: 'openweb',
    workstream: 'Smart Capsule v2',
    timestamp: '2026-03-18T17:00:00',
    status: 'dismissed',
  },
  {
    id: 'p-5',
    agent: 'codex',
    type: 'info',
    message: 'Design review R1 finished. No blocking issues found.',
    project: 'openweb',
    workstream: 'Smart Capsule v2',
    timestamp: '2026-03-18T16:45:00',
    status: 'dismissed',
  },
]

// Full project file tree (not just doc/)
export const projectTree: DocFile[] = [
  {
    name: 'doc', path: 'doc', type: 'dir', children: [
      { name: 'main.md', path: 'doc/main.md', type: 'file' },
      { name: 'dev.md', path: 'doc/dev.md', type: 'file' },
      { name: 'progress.md', path: 'doc/progress.md', type: 'file' },
      { name: 'roadmap.md', path: 'doc/roadmap.md', type: 'file' },
    ],
  },
  {
    name: 'projects', path: 'projects', type: 'dir', children: [
      {
        name: 'active', path: 'projects/active', type: 'dir', children: [
          {
            name: 'smart-capsule-v2', path: 'projects/active/smart-capsule-v2', type: 'dir', children: [
              { name: 'workstream.json', path: 'projects/active/smart-capsule-v2/workstream.json', type: 'file' },
              { name: 'progress.json', path: 'projects/active/smart-capsule-v2/progress.json', type: 'file' },
              { name: 'design.md', path: 'projects/active/smart-capsule-v2/design.md', type: 'file' },
              { name: 'note.md', path: 'projects/active/smart-capsule-v2/note.md', type: 'file' },
            ],
          },
          {
            name: 'auth-rewrite', path: 'projects/active/auth-rewrite', type: 'dir', children: [
              { name: 'workstream.json', path: 'projects/active/auth-rewrite/workstream.json', type: 'file' },
              { name: 'progress.json', path: 'projects/active/auth-rewrite/progress.json', type: 'file' },
              { name: 'design.md', path: 'projects/active/auth-rewrite/design.md', type: 'file' },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'src', path: 'src', type: 'dir', children: [
      {
        name: 'capsule', path: 'src/capsule', type: 'dir', children: [
          { name: 'schema.ts', path: 'src/capsule/schema.ts', type: 'file' },
          { name: 'migration.ts', path: 'src/capsule/migration.ts', type: 'file' },
          { name: 'renderer.tsx', path: 'src/capsule/renderer.tsx', type: 'file' },
        ],
      },
      {
        name: 'auth', path: 'src/auth', type: 'dir', children: [
          { name: 'middleware.ts', path: 'src/auth/middleware.ts', type: 'file' },
          { name: 'session.ts', path: 'src/auth/session.ts', type: 'file' },
        ],
      },
      { name: 'index.ts', path: 'src/index.ts', type: 'file' },
      { name: 'server.ts', path: 'src/server.ts', type: 'file' },
    ],
  },
  {
    name: 'test', path: 'test', type: 'dir', children: [
      { name: 'capsule.test.ts', path: 'test/capsule.test.ts', type: 'file' },
      { name: 'auth.test.ts', path: 'test/auth.test.ts', type: 'file' },
    ],
  },
  { name: 'note.md', path: 'note.md', type: 'file' },
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'tsconfig.json', path: 'tsconfig.json', type: 'file' },
  { name: 'CLAUDE.md', path: 'CLAUDE.md', type: 'file' },
]

const SAMPLE_MD = `# Smart Capsule v2 — Design

## Goal

Redesign the capsule rendering pipeline to support nested capsules, lazy loading, and server-side pre-rendering.

## Checkpoints

- [x] Design approved
- [ ] Core impl complete
- [ ] Cross review passed

## Architecture

### Schema Changes

\`\`\`typescript
interface Capsule {
  id: string
  type: 'text' | 'media' | 'nested'
  children?: Capsule[]
  lazyLoad: boolean
}
\`\`\`

### Migration Plan

1. Add \`children\` column to capsules table
2. Backfill existing capsules with \`children: null\`
3. Deploy new renderer behind feature flag
4. Migrate traffic gradually

## Open Items

- Need to decide on lazy loading threshold (viewport-based vs count-based)
- SSR hydration strategy for nested capsules
`

export function getSampleMarkdown(): string {
  return SAMPLE_MD
}
