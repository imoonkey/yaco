import { useState } from 'react'
import { docTree, getSampleMarkdown, type DocFile } from '../data'

function FileTreeNode({ node, depth, selected, onSelect }: {
  node: DocFile
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(depth < 2)

  if (node.type === 'dir') {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-0.5 px-1 hover:bg-white/5 rounded cursor-pointer text-neutral-400"
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
          onClick={() => setOpen(!open)}
        >
          <span className="text-[11px]">{open ? '▾' : '▸'}</span>
          <span className="text-[12px]">{node.name}/</span>
        </div>
        {open && node.children?.map(c => (
          <FileTreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    )
  }

  const isSelected = selected === node.path
  return (
    <div
      className={`py-0.5 px-1 rounded cursor-pointer text-[12px] ${isSelected ? 'bg-blue-500/20 text-blue-300' : 'text-neutral-400 hover:bg-white/5'}`}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
      onClick={() => onSelect(node.path)}
    >
      {node.name}
    </div>
  )
}

export function DocWorkspace() {
  const [selectedFile, setSelectedFile] = useState<string | null>('doc/todo/v0/final/design_aligned.md')
  const content = getSampleMarkdown()

  return (
    <div className="flex h-full">
      {/* File tree sidebar */}
      <div className="w-56 shrink-0 border-r border-neutral-800 p-3 overflow-y-auto">
        <div className="text-[11px] text-neutral-600 uppercase tracking-wide mb-2">Files</div>
        {docTree.map(node => (
          <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={setSelectedFile} />
        ))}
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="h-9 border-b border-neutral-800 flex items-center px-4 text-[12px] text-neutral-500 shrink-0">
              {selectedFile}
            </div>
            <div className="flex-1 overflow-y-auto">
              <div className="p-6 max-w-3xl">
                <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-300 font-[inherit]">
                  {content}
                </pre>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-neutral-600">
            Select a file to view
          </div>
        )}
      </div>
    </div>
  )
}
