import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { ModDeckApi, StateChangedEvent } from '../shared/ipc'

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
  pickImportFolders: () => ipcRenderer.invoke(IPC.pickImportFolders),
  pickCover: () => ipcRenderer.invoke(IPC.pickCover),
  importRun: (request) => ipcRenderer.invoke(IPC.importRun, request),
  importParse: (request) => ipcRenderer.invoke(IPC.importParse, request),
  importCommit: (request) => ipcRenderer.invoke(IPC.importCommit, request),
  importDiscard: (sessionId) => ipcRenderer.invoke(IPC.importDiscard, sessionId),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return (file as File & { path?: string }).path || ''
    }
  },
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
  getModPresets: (gameId, characterFolder, modFolder) =>
    ipcRenderer.invoke(IPC.getModPresets, gameId, characterFolder, modFolder),
  saveModPreset: (gameId, characterFolder, modFolder, presetName) =>
    ipcRenderer.invoke(IPC.saveModPreset, gameId, characterFolder, modFolder, presetName),
  applyModPreset: (gameId, characterFolder, modFolder, presetId) =>
    ipcRenderer.invoke(IPC.applyModPreset, gameId, characterFolder, modFolder, presetId),
  deleteModPreset: (gameId, characterFolder, modFolder, presetId) =>
    ipcRenderer.invoke(IPC.deleteModPreset, gameId, characterFolder, modFolder, presetId),
  getModDetails: (gameId, characterFolder, modFolder) =>
    ipcRenderer.invoke(IPC.getModDetails, gameId, characterFolder, modFolder),
  setModPreview: (gameId, characterFolder, modFolder, sourcePath) =>
    ipcRenderer.invoke(IPC.setModPreview, gameId, characterFolder, modFolder, sourcePath),
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
  reloadF10: () => ipcRenderer.invoke(IPC.reloadF10),
  getRosterStatus: () => ipcRenderer.invoke(IPC.rosterStatus),
  syncRemoteRoster: (customUrl) => ipcRenderer.invoke(IPC.rosterSync, customUrl),
  onStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: StateChangedEvent) => {
      listener(payload ?? {})
    }
    ipcRenderer.on(IPC.stateChanged, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC.stateChanged, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('moddeck', api)
