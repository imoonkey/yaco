import { useState, useEffect } from 'react'
import { Monitor } from './components/Monitor'
import { Workspace } from './components/Workspace'
import { RoadmapView } from './components/RoadmapView'
import { useProjects, useProgress, addProject } from './hooks/useApi'

type View = 'monitor' | 'workspace' | 'roadmap'

const navItems: { id: View; label: string; icon: string }[] = [
  { id: 'monitor', label: 'Monitor', icon: '!' },
  { id: 'workspace', label: 'Workspace', icon: 'W' },
  { id: 'roadmap', label: 'Roadmap', icon: 'M' },
]

const STORAGE_KEY = 'workflow-ui-state'

function loadState(): { view: View; project: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { view: 'monitor', project: 'all' }
}

function saveState(view: View, project: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ view, project }))
}

function App() {
  const saved = loadState()
  const [view, setView] = useState<View>(saved.view)
  const [projectName, setProjectName] = useState<string>(saved.project)
  const [lastConcreteProject, setLastConcreteProject] = useState<string>(
    saved.project !== 'all' ? saved.project : ''
  )

  const { data: projects, refresh: refreshProjects } = useProjects()
  const { data: progress } = useProgress()

  const uncleared = progress?.filter(e => e.status === 'active').length ?? 0
  const concreteProject = lastConcreteProject || (projects?.[0]?.name ?? '')

  // Persist state changes
  useEffect(() => {
    saveState(view, projectName)
  }, [view, projectName])

  const handleProjectChange = (name: string) => {
    if (name === '__add__') {
      handleAddProject()
      return
    }
    setProjectName(name)
    if (name !== 'all') setLastConcreteProject(name)
  }

  const handleAddProject = async () => {
    const path = prompt('Project path (absolute):')
    if (!path) return
    const name = path.replace(/\/+$/, '').split('/').pop() || ''
    if (!name) return
    try {
      await addProject(name, path)
      refreshProjects()
      setProjectName(name)
      setLastConcreteProject(name)
    } catch (err) {
      alert(`Failed to add project: ${err}`)
    }
  }

  const handleViewChange = (v: View) => {
    setView(v)
    if (v === 'workspace' && projectName === 'all') {
      setProjectName(concreteProject)
    }
  }

  const workspaceProject = projectName === 'all' ? concreteProject : projectName
  const currentProjectPath = projects?.find(p => p.name === workspaceProject)?.path ?? ''

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
          <option value="__add__">+ Add Project...</option>
        </select>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'monitor' && <Monitor filterProject={projectName === 'all' ? null : projectName} />}
        {view === 'workspace' && <Workspace projectName={workspaceProject} projectPath={currentProjectPath} />}
        {view === 'roadmap' && <RoadmapView filterProject={projectName === 'all' ? null : projectName} />}
      </main>
    </div>
  )
}

export default App
