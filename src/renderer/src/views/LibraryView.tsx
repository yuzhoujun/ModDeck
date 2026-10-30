import { useMemo, useState } from 'react'
import type { CharacterInfo, GameDef, GameSnapshot, UiSettings } from '../../../shared/types'
import { isUtilityCategory } from '../../../shared/types'
import { CharacterCard } from '../components/CharacterCard'
import { Icon } from '../components/Icon'
import { ImportDropdown } from '../components/ImportDropdown'
import { useI18n, getLocaleCharacterName, getLocaleGameShortName } from '../i18n'

function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? value : `.../${parts.slice(-2).join('/')}`
}

export function LibraryView({
  game,
  snapshot,
  query,
  onQuery,
  sort,
  onSort,
  filter,
  onFilter,
  onOpenCharacter,
  onImport,
  onImportFolder,
  onRefresh,
  onOpenSettings,
  onLaunchGame,
  onLaunchLoader,
  onReorderCharacters,
  onAdd,
  onOpenRosterPresets
}: {
  game: GameDef
  snapshot: GameSnapshot
  query: string
  onQuery: (value: string) => void
  sort: UiSettings['sortCharacters']
  onSort: (value: UiSettings['sortCharacters']) => void
  filter: UiSettings['characterFilter']
  onFilter: (value: UiSettings['characterFilter']) => void
  onOpenCharacter: (character: CharacterInfo) => void
  onImport: () => void
  onImportFolder: () => void
  onRefresh: () => void
  onOpenSettings: (tab?: 'general' | 'advanced' | 'games' | 'environment' | 'import' | 'about') => void
  onLaunchGame: () => void
  onLaunchLoader: () => void
  onReorderCharacters: (folders: string[]) => void
  onAdd: () => void
  onOpenRosterPresets?: () => void
}) {
  const { t, effectiveLocale } = useI18n()
  const [dragFolder, setDragFolder] = useState<string | null>(null)

  const { charCount, utilCount } = useMemo(() => {
    let chars = 0
    let utils = 0
    for (const c of snapshot.characters) {
      if (isUtilityCategory(c)) utils++
      else chars++
    }
    return { charCount: chars, utilCount: utils }
  }, [snapshot.characters])

  const characters = useMemo(() => {
    const value = query.trim().toLowerCase()
    return snapshot.characters.filter((character) => {
      if (filter === 'withMods' && character.modCount === 0) return false
      if (filter === 'empty' && character.modCount > 0) return false
      if (filter === 'characters' && isUtilityCategory(character)) return false
      if (filter === 'utility' && !isUtilityCategory(character)) return false
      if (!value) return true
      const localizedName = getLocaleCharacterName(character, effectiveLocale)
      const haystack = [
        localizedName,
        character.displayName,
        character.folder,
        character.canonicalEnName || '',
        ...character.aliases
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(value)
    })
  }, [filter, query, snapshot.characters, effectiveLocale])

  function handleDrop(targetFolder: string) {
    if (!dragFolder || dragFolder === targetFolder) return
    const folders = snapshot.characters.map((character) => character.folder)
    const from = folders.indexOf(dragFolder)
    const to = folders.indexOf(targetFolder)
    if (from < 0 || to < 0) return
    const [moved] = folders.splice(from, 1)
    folders.splice(to, 0, moved)
    onReorderCharacters(folders)
    setDragFolder(null)
  }

  const canLaunchGame = Boolean(snapshot.settings.gamePath)
  const canLaunchLoader = Boolean(snapshot.settings.loaderPath)

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <div className="eyebrow" style={{ color: game.accent }}>
            {getLocaleGameShortName(game, effectiveLocale)} · {game.loader}
          </div>
          <h1>{t('library.title')}</h1>
          <p className="muted">
            {t('library.stats', {
              categories: snapshot.characters.length,
              chars: charCount,
              utils: utilCount,
              total: snapshot.totalMods,
              enabled: snapshot.enabledMods
            })}
          </p>
        </div>
        <div className="actions">
          <button
            className="btn ghost"
            onClick={onLaunchGame}
            disabled={!canLaunchGame}
            title={canLaunchGame ? t('library.launchGame') : t('library.launchGameHint') || '请先在设置里配置游戏程序'}
          >
            <Icon name="external" size={16} />
            {t('library.launchGame')}
          </button>
          <button
            className="btn ghost"
            onClick={onLaunchLoader}
            disabled={!canLaunchLoader}
            title={canLaunchLoader ? t('library.launchLoader', { loader: game.loader }) : t('library.launchLoaderHint') || '请先在设置里配置启动器'}
          >
            <Icon name="external" size={16} />
            {t('library.launchLoader', { loader: game.loader })}
          </button>
          <button className="btn ghost" onClick={onRefresh} title={t('library.refreshTooltip')}>
            <Icon name="refresh" size={16} />
            {t('common.refresh')}
          </button>
          <button className="btn ghost" onClick={onOpenRosterPresets} title={t('library.rosterPresetsTooltip')}>
            <Icon name="box" size={16} />
            {t('library.rosterPresets')}
          </button>
          <button className="btn ghost" onClick={onAdd} title={t('library.newFolderTooltip')}>
            <Icon name="userPlus" size={16} />
            {t('library.newFolder')}
          </button>
          <ImportDropdown onImport={onImport} onImportFolder={onImportFolder} />
        </div>
      </header>

      {!snapshot.modsPathExists ? (
        <div className="empty-panel">
          <div className="empty-icon">
            <Icon name="box" size={30} />
          </div>
          <h2>{snapshot.settings.modsPath ? t('library.modsDirNotExist') || 'Mods 目录不存在' : t('library.modsDirNotConfigured') || '还没有配置 Mods 目录'}</h2>
          <p className="muted">
            {snapshot.settings.modsPath
              ? shortPath(snapshot.settings.modsPath)
              : t('library.modsDirDesc', { game: game.name }) || `选择 ${game.name} 的 Mods 文件夹后，ModDeck 会自动扫描角色和 Mod。`}
          </p>
          <div className="actions center">
            <button className="btn primary" onClick={() => onOpenSettings('games')}>
              <Icon name="folder" size={16} />
              {t('sidebar.settings')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <div className="search">
              <Icon name="search" size={16} />
              <input
                className="input"
                placeholder={t('library.searchPlaceholder')}
                value={query}
                onChange={(event) => onQuery(event.target.value)}
              />
            </div>
            <select
              className="select"
              value={filter}
              onChange={(event) => onFilter(event.target.value as UiSettings['characterFilter'])}
            >
              <option value="all">{t('library.filterAll', { count: snapshot.characters.length })}</option>
              <option value="characters">{t('library.filterCharacters', { count: charCount })}</option>
              <option value="utility">{t('library.filterUtility', { count: utilCount })}</option>
              <option value="withMods">{t('library.filterWithMods')}</option>
              <option value="empty">{t('library.filterEmpty')}</option>
            </select>
            <select
              className="select"
              value={sort}
              onChange={(event) => onSort(event.target.value as UiSettings['sortCharacters'])}
            >
              <option value="custom">{t('library.sortByCustom')}</option>
              <option value="name">{t('library.sortByName')}</option>
              <option value="count">{t('library.sortByCount')}</option>
            </select>
            {sort === 'custom' ? <span className="hint">{t('library.dragFolderHint')}</span> : null}
            <button
              className="path-chip"
              title={snapshot.settings.modsPath}
              onClick={() => onOpenSettings('games')}
            >
              <Icon name="folder" size={14} />
              {shortPath(snapshot.settings.modsPath)}
            </button>
          </div>

          {characters.length === 0 ? (
            <div className="empty-panel">
              <h2>
                {query
                  ? t('library.emptySearchTitle')
                  : filter === 'characters'
                    ? t('library.emptyCharactersTitle')
                    : filter === 'utility'
                      ? t('library.emptyUtilityTitle')
                      : filter === 'withMods'
                        ? t('library.emptyWithModsTitle')
                        : filter === 'empty'
                          ? t('library.emptyNoModsTitle')
                          : t('library.emptyFolderTitle')}
              </h2>
              <p className="muted">
                {query ? t('library.emptySearchDesc') : t('library.emptyFilterDesc')}
              </p>
            </div>
          ) : (
            <div className="char-grid">
              {characters.map((character) => (
                <CharacterCard
                  key={character.folder}
                  character={character}
                  accent={game.accent}
                  onOpen={() => onOpenCharacter(character)}
                  draggable={sort === 'custom'}
                  dragging={dragFolder === character.folder}
                  onDragStart={(event) => {
                    setDragFolder(character.folder)
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', character.folder)
                  }}
                  onDragOver={(event) => {
                    if (!dragFolder) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(event) => {
                    if (!dragFolder) return
                    event.preventDefault()
                    handleDrop(character.folder)
                  }}
                  onDragEnd={() => setDragFolder(null)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
