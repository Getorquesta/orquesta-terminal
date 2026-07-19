/**
 * Injected via page.addInitScript before every test.
 * Mocks window.__TAURI_INTERNALS__ so @tauri-apps/api/core's invoke() works
 * in a plain browser without a Tauri shell.
 */
export const TAURI_MOCK_SCRIPT = `
(function() {
  const responses = {
    'session_start':              { ok: true },
    'session_end':                null,
    'session_force_end':          null,
    'session_input':              null,
    'session_resize':             null,
    'fs_list_dir':                { entries: [], current: '/home', home: '/home' },
    'fs_native_pick':             { ok: false, path: null, available: true },
    'hook_status':                { configured: false, cwd: '/home' },
    'hook_init_project':          { ok: true, claudeHooked: false },
    'daemon_preflight':           { agentAvailable: false },
    'daemon_start':               { ok: true },
    'daemon_stop':                { ok: true },
    'daemon_status_request':      { daemons: [] },
    'sessions_external_list':     { sessions: [] },
    'sessions_external_attach':   null,
    'sessions_external_detach':   null,
    'terminal_share':             { ok: true, sessionId: '', channel: '', projectId: '' },
    'terminal_unshare':           null,
    'terminal_share_control':     null,
    'terminal_cursor':            null,
    'remote_list_agents':         { agents: [] },
    'remote_start':               { ok: true, sessionId: 'mock-remote' },
    'remote_input':               null,
    'remote_resize':              null,
    'remote_detach':              null,
    'remote_end':                 null,
    'hosted_proxy':               {},
    'hosted_upload':              { ok: true },
    // plugins
    'plugin:clipboard-manager|write_text': null,
    'plugin:clipboard-manager|read_text':  '',
  };

  async function mockInvoke(cmd, args) {
    await new Promise(r => setTimeout(r, 0));
    if (Object.prototype.hasOwnProperty.call(responses, cmd)) {
      return responses[cmd];
    }
    console.warn('[tauri-mock] unmocked command:', cmd, args);
    return null;
  }

  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke: mockInvoke },
    writable: false,
    configurable: true,
  });
})();
`
