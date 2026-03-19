import { useState } from 'react'
import { Monitor } from './components/Monitor'
import { Workspace } from './components/Workspace'
import { RoadmapView } from './components/RoadmapView'
import { useProjects, useProgress } from './hooks/useApi'

type View = 'monitor' | 'workspace' | 'roadmap'

const navItems: { id: View; label: string; icon: string }[] = [
  { id: 'monitor', label: 'Monitor', icon: '!' },
  { id: 'workspace', label: 'Workspace', icon: 'W' },
  { id: 'roadmap', label: 'Roadmap', icon: 'M' },
]

function App() {
  const [view, setView] = useState<View>('monitor')
  const [projectName, setProjectName] = useState<string>('all')
  const [lastConcreteProject, setLastConcreteProject] = useState<string>('')

  const { data: projects } = useProjects()
  const { data: progress } = useProgress()

  const uncleared = progress?.filter(e => e.status === 'active').length ?? 0

  // Initialize lastConcreteProject when projects load
  const concreteProject = lastConcreteProject || (projects?.[0]?.name ?? '')

  const handleProjectChange = (name: string) => {
    setProjectName(name)
    if (name !== 'all') setLastConcreteProject(name)
  }

  const handleViewChange = (v: View) => {
    setView(v)
    if (v === 'workspace' && projectName === 'all') {
      setProjectName(concreteProject)
    }
  }

  const workspaceProject = projectName === 'all' ? concreteProject : projectName

  return (
    <div className="flex flex-col h-screen bg-[#fdf6e3]">
      <header className="h-10 shrink-0 border-b border-[#eee8d5] flex items-center px-3 bg-[#eee8d5]/50 gap-1">
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

        <div className="flex-1" />

        <select
          value={view === 'workspace' ? workspaceProject : projectName}
          onChange={e => handleProjectChange(e.target.value)}
          className="text-[12px] bg-[#fdf6e3] border border-[#eee8d5] rounded-md px-2 py-1 text-[#586e75] cursor-pointer focus:outline-none focus:border-[#268bd2]/40"
        >
          {view !== 'workspace' && <option value="all">All Projects</option>}
          {projects?.map(p => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'monitor' && <Monitor filterProject={projectName === 'all' ? null : projectName} />}
        {view === 'workspace' && <Workspace projectName={workspaceProject} />}
        {view === 'roadmap' && <RoadmapView filterProject={projectName === 'all' ? null : projectName} />}
      </main>
    </div>
  )
}

export default App
