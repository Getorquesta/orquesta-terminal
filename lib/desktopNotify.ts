// OS-level nudge for agent alerts while the app is in the background. Two
// layers, both best-effort: the window asks the taskbar/dock for attention
// (Tauri), and a Web Notification is shown where the webview supports one.
// Neither may throw into the caller — an alert that can't reach the OS still
// has its sound and in-app toast.

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function requestAttention(): Promise<void> {
  if (!isTauri()) return
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window')
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational)
  } catch { /* capability missing or platform without the concept */ }
}

async function showNotification(title: string, body: string | undefined, onClick: () => void): Promise<void> {
  if (typeof Notification === 'undefined') return
  try {
    if (Notification.permission === 'default') await Notification.requestPermission()
    if (Notification.permission !== 'granted') return
    const n = new Notification(title, { body, tag: `orq-agent-${title}`, silent: true })
    n.onclick = () => {
      window.focus()
      onClick()
      n.close()
    }
  } catch { /* webview refused */ }
}

export function notifyDesktop(title: string, body: string | undefined, onClick: () => void): void {
  void requestAttention()
  void showNotification(title, body, onClick)
}
