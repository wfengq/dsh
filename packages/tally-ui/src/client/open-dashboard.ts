/** Opening the usage tab from the conversation (dock, session total, budget toast). */
import { TAB_KIND } from './dashboard/definition.ts'

export interface SidebarRightFace {
  openTab(kind: string, options?: { params?: { sessionId?: string } }): void
}

/**
 * `openDashboard(sessionId?)`. It does nothing when the host has no right sidebar or the usage tab is
 * switched off (an unregistered kind would make the sidebar throw); a sidebar that still refuses is ignored.
 */
export function makeOpenDashboard(sidebar: () => SidebarRightFace | undefined, tabEnabled: () => boolean): (sessionId?: string) => void {
  return (sessionId) => {
    const target = sidebar()
    if (target === undefined || !tabEnabled()) return
    try {
      target.openTab(TAB_KIND, sessionId === undefined ? undefined : { params: { sessionId } })
    } catch {
      // Opening is a convenience; the hover details stay available either way.
    }
  }
}
