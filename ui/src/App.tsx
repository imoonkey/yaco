import { useState } from 'react'
import { Monitor } from './components/Monitor'
import { Workspace } from './components/Workspace'
import { RoadmapView } from './components/RoadmapView'
import { progressEntries, projects } from './data'

type View = 'monitor' | 'workspace' | 'roadmap'

const navItems: { id: View; label: string; icon: string }[] = [
  { id: 'monitor', label: 'Monitor', icon: '!' },
  { id: 'workspace', label: 'Workspace', icon: 'W' },
  { id: 'roadmap', label: 'Roadmap', icon: 'M' },
]

function App() {
  const [view, setView] = useState<View>('workspace')
  const [projectId, setProjectId] = useState<string>('all')
  const [lastConcreteProject, setLastConcreteProject] = useState(projects[0].id)
  const uncleared = progressEntries.filter(e => e.status === 'active').length

  const handleProjectChange = (id: string) => {
    setProjectId(id)
    if (id !== 'all') setLastConcreteProject(id)
  }

  const handleViewChange = (v: View) => {
    setView(v)
    // Workspace requires a concrete project
    if (v === 'workspace' && projectId === 'all') {
      setProjectId(lastConcreteProject)
    }
  }

  // Workspace always uses a concrete project
  const workspaceProjectId = projectId === 'all' ? lastConcreteProject : projectId

  return (
    <div className="flex flex-col h-screen bg-[#fdf6e3]">
      {/* Top nav bar */}
      <header className="h-10 shrink-0 border-b border-[#eee8d5] flex items-center px-3 bg-[#eee8d5]/50 gap-1">
        {/* Tab buttons */}
        <div className="flex items-center gap-0.5">
          {navItems.map(item => {
            const isActive = view === item.id
            return (
              <button
                key={item.id}
                onClick={() => handleViewChange(item.id)}
                className={`relative flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-[#268bd2]/15 text-[#268bd2]'
                    : 'text-[#93a1a1] hover:text-[#586e75] hover:bg-[#eee8d5]'
                }`}
              >
                <span className="font-bold text-[11px]">{item.icon}</span>
                {item.label}
                {item.id === 'monitor' && uncleared > 0 && (
                  <span className="w-4 h-4 rounded-full bg-[#dc322f] text-[8px] text-white flex items-center justify-center font-bold">
                    {uncleared}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Global project selector */}
        <select
          value={view === 'workspace' ? workspaceProjectId : projectId}
          onChange={e => handleProjectChange(e.target.value)}
          className="text-[12px] bg-[#fdf6e3] border border-[#eee8d5] rounded-md px-2 py-1 text-[#586e75] cursor-pointer focus:outline-none focus:border-[#268bd2]/40"
        >
          {view !== 'workspace' && <option value="all">All Projects</option>}
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {view === 'monitor' && <Monitor filterProject={projectId === 'all' ? null : projectId} />}
        {view === 'workspace' && <Workspace projectId={workspaceProjectId} />}
        {view === 'roadmap' && <RoadmapView filterProject={projectId === 'all' ? null : projectId} />}
      </main>
    </div>
  )
}

export default App
