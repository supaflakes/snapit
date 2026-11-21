// Pont `window.snapit` de la version Tauri : la même API que src/preload.js (Electron), pour que l'éditeur,
// les paramètres et l'overlay fonctionnent sans changement. Injecté dans chaque page avant ses scripts.
(() => {
  'use strict';
  if (window.snapit) return;

  // Les objets de Tauri ne sont lus qu'à l'appel : ils sont définis après ce script.
  const tauri = () => window.__TAURI__;

  // Les erreurs Rust arrivent sous forme de texte : on en fait des Error, comme avec Electron.
  const invoke = (command, args) =>
    tauri()
      .core.invoke(command, args)
      .catch((err) => {
        throw err instanceof Error ? err : new Error(String(err));
      });
  const send = (command, args) => {
    invoke(command, args).catch(() => {});
  };
  // Événements adressés à cette fenêtre (ou à toutes)
  const on = (event, callback) => {
    tauri()
      .webviewWindow.getCurrentWebviewWindow()
      .listen(event, (e) => callback(e.payload));
  };

  // Octets (Uint8Array) -> base64, par tranches pour les grandes images
  function toBase64(bytes) {
    if (!(bytes instanceof Uint8Array)) return bytes ?? null;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  window.snapit = Object.freeze({
    // Éditeur
    capture: (mode) => invoke('capture', { mode }),
    getInitialImage: () => invoke('editor_initial'),
    onLoadImage: (callback) => on('editor:load', callback),
    setDocument: (doc) => send('editor_state', { hasImage: Boolean(doc?.hasImage), libraryId: doc?.libraryId ?? null }),
    showImage: (payload) => invoke('editor_show', { payload }),
    copyImage: (dataUrl) => invoke('clipboard_write_image', { dataUrl }),
    readClipboardImage: () => invoke('clipboard_read_image'),
    saveImage: (dataUrl, name) => invoke('file_save_image', { dataUrl, name: name ?? null }),
    openImage: () => invoke('file_open_image'),
    onCloseRequest: (callback) => on('editor:close-request', () => callback()),
    closeReady: (result) => send('editor_close_ready', { unsaved: Boolean(result?.unsaved) }),

    // Bibliothèque des captures (enregistrement automatique, galerie)
    libraryList: () => invoke('library_list'),
    onLibraryChange: (callback) => on('library:changed', callback),
    libraryOpen: (id, newWindow) => invoke('library_open', { id, newWindow: Boolean(newWindow) }),
    librarySave: (data) =>
      invoke('library_save', {
        data: { ...data, image: toBase64(data.image), thumb: toBase64(data.thumb), base: toBase64(data.base) },
      }),
    libraryRemove: (id) => invoke('library_remove', { id }),
    libraryCopy: (id) => invoke('library_copy', { id }),
    libraryReveal: (id) => invoke('library_reveal', { id }),
    libraryMenu: (id) => send('library_menu', { id }),
    onLibraryMenu: (callback) => on('library:menu-action', ({ action, id }) => callback(action, id)),
    openLibraryFolder: () => invoke('library_open_folder'),

    // État de l'application (paramètres, langue, raccourcis)
    getState: () => invoke('app_state'),
    onState: (callback) => on('app:state', callback),
    openSettings: () => invoke('settings_open'),
    setSettings: (patch) => invoke('settings_set', { patch }),
    setOpenAtLogin: (enabled) => invoke('settings_set_login', { enabled: Boolean(enabled) }),
    chooseFolder: () => invoke('settings_choose_folder'),
    chooseLibraryFolder: () => invoke('settings_choose_library_folder'),
    resetShortcuts: () => invoke('settings_reset_shortcuts'),
    openWindowsKeyboardSettings: () => invoke('settings_open_windows_keyboard'),
    startRecording: () => send('shortcuts_record_start'),
    stopRecording: () => send('shortcuts_record_stop'),
    onRecorded: (callback) => on('shortcuts:recorded', callback),

    // Sélection de zone
    onOverlayShow: (callback) => on('overlay:show', callback),
    onOverlayReset: (callback) => on('overlay:reset', () => callback()),
    overlayReady: () => send('overlay_ready'),
    overlaySelect: (rect) => send('overlay_select', { rect }),
    overlayCancel: () => send('overlay_cancel'),
    overlayProbe: (hwnd, x, y) => invoke('overlay_probe', { hwnd, x, y }),
    overlayFocus: () => send('overlay_focus'),
    overlayScroll: (zone) => send('overlay_scroll', { zone }),
    onOverlayScrollProgress: (callback) => on('overlay:scroll-progress', callback),
  });
})();
