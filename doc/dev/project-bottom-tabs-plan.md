## Goal

Replace the top project selector with a bottom project tab bar, and move editor tab state affordances to the right side of each file tab.

## Phase 1

- Update `ui/src/App.tsx`
- Remove the header `<select>` project switcher
- Add a bottom tab bar for project switching, preserving `All Projects` outside workspace and `+ Add Project...`
- Keep existing workspace fallback behavior when switching from `all` into `workspace`

## Phase 2

- Update `ui/src/components/Workspace.tsx`
- Keep file names left-aligned in the editor tab strip
- Move dirty dot / close button to the right side of each tab without changing existing dirty/close behavior

## Verification

- Run the UI build
- Update progress/docs to reflect the shell navigation change
