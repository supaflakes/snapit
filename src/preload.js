'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapit', {
  // Éditeur
  capture: (mode) => ipcRenderer.invoke('capture', mode),
  getInitialImage: () => ipcRenderer.invoke('editor:initial'),
  onLoadImage: (callback) => ipcRenderer.on('editor:load', (_e, payload) => callback(payload)),
  setDocument: (doc) => ipcRenderer.send('editor:state', doc),
  showImage: (payload) => ipcRenderer.invoke('editor:show', payload),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('file:save-image', dataUrl, name),
  openImage: () => ipcRenderer.invoke('file:open-image'),

  // Bibliothèque des captures (enregistrement automatique, galerie)
  libraryList: () => ipcRenderer.invoke('library:list'),
  onLibraryChange: (callback) => ipcRenderer.on('library:changed', (_e, event) => callback(event)),
  libraryOpen: (id, newWindow) => ipcRenderer.invoke('library:open', id, newWindow),
  librarySave: (data) => ipcRenderer.invoke('library:save', data),
  librarySaveSync: (data) => ipcRenderer.sendSync('library:save-sync', data),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryCopy: (id) => ipcRenderer.invoke('library:copy', id),
  libraryReveal: (id) => ipcRenderer.invoke('library:reveal', id),
  libraryMenu: (id) => ipcRenderer.send('library:menu', id),
  onLibraryMenu: (callback) => ipcRenderer.on('library:menu-action', (_e, action, id) => callback(action, id)),
  openLibraryFolder: () => ipcRenderer.invoke('library:open-folder'),

  // État de l'application (paramètres, langue, raccourcis)
  getState: () => ipcRenderer.invoke('app:state'),
  onState: (callback) => ipcRenderer.on('app:state', (_e, state) => callback(state)),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('settings:set-login', enabled),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),
  chooseLibraryFolder: () => ipcRenderer.invoke('settings:choose-library-folder'),
  resetShortcuts: () => ipcRenderer.invoke('settings:reset-shortcuts'),
  openWindowsKeyboardSettings: () => ipcRenderer.invoke('settings:open-windows-keyboard'),
  startRecording: () => ipcRenderer.send('shortcuts:record-start'),
  stopRecording: () => ipcRenderer.send('shortcuts:record-stop'),
  onRecorded: (callback) => ipcRenderer.on('shortcuts:recorded', (_e, accelerator) => callback(accelerator)),

  // Sélection de zone
  onOverlayShow: (callback) => ipcRenderer.on('overlay:show', (_e, payload) => callback(payload)),
  onOverlayReset: (callback) => ipcRenderer.on('overlay:reset', () => callback()),
  overlayReady: () => ipcRenderer.send('overlay:ready'),
  overlaySelect: (rect) => ipcRenderer.send('overlay:select', rect),
  overlayCancel: () => ipcRenderer.send('overlay:cancel'),
});
