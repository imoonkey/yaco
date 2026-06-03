export function isCloseShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'w' && event.metaKey && !event.ctrlKey && !event.altKey
}

export function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== 'c') return false
  return event.metaKey || (event.ctrlKey && event.shiftKey)
}
