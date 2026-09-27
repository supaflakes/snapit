'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapit', {
  // Éditeur
  capture: (mode) => ipcRenderer.invoke('capture', mode),
  getInitialImage: () => ipcRenderer.invoke('editor:initial'),
  onLoadImage: (callback) => ipcRenderer.on('editor:load', (_e, payload) => callback(payload)),
  setHasImage: (hasImage) => ipcRenderer.send('editor:state', { hasImage }),
  openInNewEditor: (payload) => ipcRenderer.invoke('editor:open-new', payload),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('file:save-image', dataUrl, name),
  openImage: () => ipcRenderer.invoke('file:open-image'),

  // État de l'application (paramètres, langue, raccourcis)
  getState: () => ipcRenderer.invoke('app:state'),
  onState: (callback) => ipcRenderer.on('app:state', (_e, state) => callback(state)),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('settings:set-login', enabled),
  chooseFolder: () => ipcRenderer.invoke('settings:choose-folder'),
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
