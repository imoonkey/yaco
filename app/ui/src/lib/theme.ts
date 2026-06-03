export type ThemeId = 'light' | 'dark'

export function getTheme(): ThemeId {
  return (localStorage.getItem('workflow-theme') as ThemeId) || 'light'
}

export function setTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('workflow-theme', theme)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#00212b' : '#eee8d5')
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'light' ? 'dark' : 'light')
}
