import { createTwoFilesPatch } from 'diff'
import { parseDiff, type ParsedFileDiff } from './parseDiff'

export function buildEditorBufferDiff(
  filePath: string,
  baselineContent: string,
  currentContent: string,
  baselineExists = true,
): ParsedFileDiff {
  if (baselineContent === currentContent) return parseDiff('', filePath)

  const oldName = baselineExists ? `a/${filePath}` : '/dev/null'
  const newName = `b/${filePath}`
  const patch = createTwoFilesPatch(oldName, newName, baselineContent, currentContent, '', '', {
    context: 3,
  })
  return parseDiff(patch, filePath)
}
