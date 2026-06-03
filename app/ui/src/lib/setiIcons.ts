// Seti icon theme — VS Code file icons (MIT)
// Data from https://github.com/elviswolcott/seti-icons

import definitions from './seti-definitions.json'
import icons from './seti-icons.json'

type IconDef = [string, string]

const files = definitions.files as unknown as Record<string, IconDef>
const extensions = definitions.extensions as unknown as Record<string, IconDef>
const partials = definitions.partials as [string, IconDef][]
const defaultIcon = definitions.default as IconDef

function getDetails(fileName: string): IconDef {
  if (fileName in files) return files[fileName]
  let ext = fileName.slice(fileName.indexOf('.'))
  while (ext !== '') {
    if (ext in extensions) return extensions[ext]
    ext = ext.slice(1)
    ext = ext.slice(ext.indexOf('.'))
  }
  for (const [partial, def] of partials) {
    if (fileName.includes(partial)) return def
  }
  return defaultIcon
}

export function getIcon(fileName: string): { svg: string; color: string } {
  const [icon, color] = getDetails(fileName)
  return { svg: (icons as Record<string, string>)[icon] || (icons as Record<string, string>).default, color }
}
