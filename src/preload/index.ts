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
  toggleMod: (gameId, characterFolder, modFolder, enable) =>
    ipcRenderer.invoke(IPC.toggleMod, gameId, characterFolder, modFolder, enable),
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
    ipcRenderer.invoke(IPC.resetCharacterMeta, gameId, characterFolder)
}

contextBridge.exposeInMainWorld('moddeck', api)
