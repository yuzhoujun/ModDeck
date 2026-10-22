import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ModDeckApi } from '../shared/ipc'

const api: ModDeckApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  switchGame: (gameId) => ipcRenderer.invoke(IPC.switchGame, gameId),
  scanGame: (gameId) => ipcRenderer.invoke(IPC.scanGame, gameId),
  getMods: (gameId, characterFolder) =>
    ipcRenderer.invoke(IPC.getMods, gameId, characterFolder),
  toggleMod: (gameId, characterFolder, modFolder, enable, exclusive) =>
    ipcRenderer.invoke(IPC.toggleMod, gameId, characterFolder, modFolder, enable, exclusive),
  deleteMod: (gameId, characterFolder, modFolder) =>
    ipcRenderer.invoke(IPC.deleteMod, gameId, characterFolder, modFolder),
  openModFolder: (gameId, characterFolder, modFolder) =>
    ipcRenderer.invoke(IPC.openModFolder, gameId, characterFolder, modFolder),
  openCharacterFolder: (gameId, characterFolder) =>
    ipcRenderer.invoke(IPC.openCharacterFolder, gameId, characterFolder),
  openPath: (kind, gameId) => ipcRenderer.invoke(IPC.openPath, kind, gameId),
  pickModsFolder: () => ipcRenderer.invoke(IPC.pickModsFolder),
  pickGameExe: () => ipcRenderer.invoke(IPC.pickGameExe),
  pickLoader: () => ipcRenderer.invoke(IPC.pickLoader),
  pickImportFiles: () => ipcRenderer.invoke(IPC.pickImportFiles),
  pickImportFolder: () => ipcRenderer.invoke(IPC.pickImportFolder),
  pickCover: () => ipcRenderer.invoke(IPC.pickCover),
  importRun: (request) => ipcRenderer.invoke(IPC.importRun, request),
  updateCharacterMeta: (gameId, characterFolder, patch) =>
    ipcRenderer.invoke(IPC.updateCharacterMeta, gameId, characterFolder, patch),
  setCharacterCover: (gameId, characterFolder) =>
    ipcRenderer.invoke(IPC.setCharacterCover, gameId, characterFolder),
  resetCharacterMeta: (gameId, characterFolder) =>
    ipcRenderer.invoke(IPC.resetCharacterMeta, gameId, characterFolder),
  createCharacter: (gameId, input) => ipcRenderer.invoke(IPC.createCharacter, gameId, input),
  saveCharacterCoverData: (gameId, characterFolder, dataUrl) =>
    ipcRenderer.invoke(IPC.saveCharacterCoverData, gameId, characterFolder, dataUrl),
  clearCharacterCover: (gameId, characterFolder) =>
    ipcRenderer.invoke(IPC.clearCharacterCover, gameId, characterFolder),
  getModDetails: (gameId, characterFolder, modFolder) =>
    ipcRenderer.invoke(IPC.getModDetails, gameId, characterFolder, modFolder),
  setModsEnabled: (gameId, characterFolder, folders, enable) =>
    ipcRenderer.invoke(IPC.setModsEnabled, gameId, characterFolder, folders, enable),
  reorderCharacters: (gameId, folders) =>
    ipcRenderer.invoke(IPC.reorderCharacters, gameId, folders),
  reorderMods: (gameId, characterFolder, folders) =>
    ipcRenderer.invoke(IPC.reorderMods, gameId, characterFolder, folders),
  launchGame: (gameId) => ipcRenderer.invoke(IPC.launchGame, gameId),
  launchLoader: (gameId) => ipcRenderer.invoke(IPC.launchLoader, gameId),
  getOverlayHotkey: () => ipcRenderer.invoke(IPC.getOverlayHotkey),
  setOverlayHotkey: (hotkey) => ipcRenderer.invoke(IPC.setOverlayHotkey, hotkey),
  setOverlayPinned: (pinned) => ipcRenderer.invoke(IPC.setOverlayPinned, pinned),
  showOverlayDetail: (request) => ipcRenderer.invoke(IPC.showOverlayDetail, request),
  hideOverlayDetail: () => ipcRenderer.invoke(IPC.hideOverlayDetail),
  sendModHotkey: (key) => ipcRenderer.invoke(IPC.sendModHotkey, key),
  overlayHide: () => ipcRenderer.invoke(IPC.overlayHide),
  overlayOpenManager: () => ipcRenderer.invoke(IPC.overlayOpenManager),
  toggleOverlay: () => ipcRenderer.invoke(IPC.overlayToggle),
  checkEnvironment: (gameId) => ipcRenderer.invoke(IPC.checkEnvironment, gameId),
  openEnvironmentFolder: (gameId) => ipcRenderer.invoke(IPC.openEnvironmentFolder, gameId),
  reloadF10: () => ipcRenderer.invoke(IPC.reloadF10)
}

contextBridge.exposeInMainWorld('moddeck', api)
