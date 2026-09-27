'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapit', {
  // Éditeur
  capture: (mode) => ipcRenderer.invoke('capture', mode),
  getInitialImage: () => ipcRenderer.invoke('editor:initial'),
  onLoadImage: (callback) => ipcRenderer.on('editor:load', (_e, payload) => callback(payload)),
  setHasImage: (hasImage) => ipcRenderer.send('editor:state', { hasImage }),
  openInNewEditor: (payload) => ipcRenderer.invoke('editor:open-new', payload),
  getInfo: () => ipcRenderer.invoke('app:info'),
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('file:save-image', dataUrl, name),
  openImage: () => ipcRenderer.invoke('file:open-image'),

  // Sélection de zone
  onOverlayShow: (callback) => ipcRenderer.on('overlay:show', (_e, payload) => callback(payload)),
  onOverlayReset: (callback) => ipcRenderer.on('overlay:reset', () => callback()),
  overlayReady: () => ipcRenderer.send('overlay:ready'),
  overlaySelect: (rect) => ipcRenderer.send('overlay:select', rect),
  overlayCancel: () => ipcRenderer.send('overlay:cancel'),
});
