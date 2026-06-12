// Shared App ↔ Workspace bridge types.
//
// These describe the cross-cutting signals the app shell exchanges with the
// workspace: which session a workspace is attached to + showing (the
// active-viewing target), and an externally-requested attach (from a
// notification click). They used to live in `useSessionUnreadState` (deleted in
// the notification redesign); they outlive that hook, so they have a stable home
// here.

/** What the active workspace is currently attached to + showing. Drives the
 *  `useAttention` active-viewing guard (a visible+focused attached session has
 *  its interrupts suppressed and auto-acked). */
export type WorkspaceVisibilityReport = {
  projectName: string
  attachedSession: string | null
  terminalVisible: boolean
}

/** A request to attach a session, raised outside the workspace (e.g. a
 *  notification/attention item click). `token` makes repeated requests for the
 *  same session distinct so the effect re-fires. */
export type AttachSessionIntent = {
  token: number
  projectName: string
  sessionName: string
}
