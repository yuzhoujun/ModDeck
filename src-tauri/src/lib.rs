mod detect;
mod games;
mod input;
mod library;
mod metadata;
mod models;
mod roster;
mod settings;

use games::{get_all_games, get_game, is_builtin_game, sanitize_custom_game};
use library::{
    build_snapshot, create_character_dir, decode_asset_query, get_mod_details,
    is_allowed_asset_path, list_mods, resolve_character_dir, set_mod_preview_file,
    sync_missing_roster_folders_to_disk, toggle_mod as fs_toggle_mod,
};
use metadata::{
    clear_character_cover_files, get_character_meta, load_metadata, mark_roster_initialized,
    remove_character_meta, save_character_cover_data as fs_save_character_cover_data, save_cover,
    save_metadata, set_character_meta,
};
use models::{
    AppInfo, AutoDetectPathsResult, Bootstrap, CharacterMeta, ClearShaderCacheResult,
    CreateCharacterInput, CustomGameMutationResult, EnvironmentCheck, GameSettings, GameSnapshot,
    HotkeyResult, MetadataStore, ModDetails, ModInfo, OnlyConfiguredResult, RosterSyncResult,
    RosterSyncStatus, Settings, SimpleResult, StateChangedEvent, ToggleResult,
    ToggleVisibilityResult,
};
use serde_json::Value;
use settings::{
    is_non_zh_effective_locale, load_custom_locales, load_settings, merge_settings_patch,
    normalize_settings, record_recent_mod, resolve_base_dir, save_settings, save_settings_atomic,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct InnerState {
    base_dir: PathBuf,
    settings: Settings,
    metadata: MetadataStore,
    registered_hotkey: Option<String>,
    last_overlay_toggle: Option<Instant>,
    webview_data_dir: Option<PathBuf>,
}

pub struct AppState(Mutex<InnerState>);

fn create_window_from_config(
    app: &AppHandle,
    label: &str,
    data_dir: Option<&Path>,
) -> Result<tauri::WebviewWindow, String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == label)
        .cloned()
        .ok_or_else(|| format!("Window config '{label}' not found"))?;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|e| format!("from_config('{label}'): {e}"))?;
    if let Some(dir) = data_dir {
        builder = builder.data_directory(dir.to_path_buf());
    }
    builder
        .build()
        .map_err(|e| format!("build('{label}'): {e}"))
}

fn fallback_webview_data_dir(base_dir: &Path) -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| base_dir.to_path_buf())
        .join("dev.moddeck.desktop")
        .join("EBWebView-recovery")
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

fn emit_state_changed(app: &AppHandle, game_id: Option<&str>, character_folder: Option<&str>) {
    let payload = StateChangedEvent {
        game_id: game_id.map(str::to_string),
        character_folder: character_folder.map(str::to_string),
        pending_preset_count: Some(0),
    };
    let _ = app.emit("app:state-changed", payload);
}

fn do_toggle_overlay(app: &AppHandle) {
    let (pinned, base_dir, data_dir) = {
        let state = app.state::<AppState>();
        let mut guard = state.0.lock().expect("state lock");
        let now = Instant::now();
        if let Some(prev) = guard.last_overlay_toggle {
            if now.duration_since(prev) < Duration::from_millis(120) {
                return;
            }
        }
        guard.last_overlay_toggle = Some(now);
        (
            guard.settings.ui.overlay_pinned,
            guard.base_dir.clone(),
            guard.webview_data_dir.clone(),
        )
    };
    let win = match app.get_webview_window("overlay") {
        Some(win) => Some(win),
        None => match create_window_from_config(app, "overlay", data_dir.as_deref()) {
            Ok(win) => Some(win),
            Err(err) => {
                append_crash_log(&base_dir, &format!("overlay lazy init failed: {err}"));
                None
            }
        },
    };
    if let Some(win) = win {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        // Hide immediately when pinned on top so toggle works after F10 returns focus to the game.
        if visible && (focused || pinned) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_always_on_top(pinned);
            let _ = win.set_focus();
        }
    }
}

fn normalize_shortcut_for_tauri(raw: &str) -> String {
    raw.split('+')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" => "Ctrl".to_string(),
            "arrowup" => "Up".to_string(),
            "arrowdown" => "Down".to_string(),
            "arrowleft" => "Left".to_string(),
            "arrowright" => "Right".to_string(),
            "escape" | "esc" => "Escape".to_string(),
            "\\" => "Backslash".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn active_exe_hints(settings: &Settings) -> Vec<String> {
    let mut hints = Vec::new();
    if let Some(game) = get_game(settings, &settings.active_game_id) {
        if let Some(hint) = game.exe_hint {
            for part in hint.split('|') {
                let p = part.trim().to_string();
                if !p.is_empty() {
                    hints.push(p);
                }
            }
        }
        if let Some(gs) = settings.games.get(&game.id) {
            if let Some(gp) = gs.game_path.as_ref() {
                if let Some(fname) = Path::new(gp).file_name().and_then(|s| s.to_str()) {
                    hints.push(fname.to_string());
                }
            }
        }
    }
    hints
}

fn snapshot_for_game(state: &InnerState, game_id: &str) -> Result<Option<GameSnapshot>, String> {
    let game = get_game(&state.settings, game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    let gs = state
        .settings
        .games
        .get(&game.id)
        .cloned()
        .unwrap_or_default();
    Ok(Some(build_snapshot(
        &state.base_dir,
        &game,
        &gs,
        &state.metadata,
        &state.settings,
    )))
}

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Bootstrap {
    let mut guard = state.0.lock().expect("state lock");
    let games = get_all_games(&guard.settings);
    let active_id = guard.settings.active_game_id.clone();
    if mark_roster_initialized(&mut guard.metadata, &active_id) {
        let _ = save_metadata(&guard.base_dir, &guard.metadata);
    }
    let snapshot = get_game(&guard.settings, &active_id).map(|g| {
        let gs = guard
            .settings
            .games
            .get(&g.id)
            .cloned()
            .unwrap_or_default();
        build_snapshot(&guard.base_dir, &g, &gs, &guard.metadata, &guard.settings)
    });
    let prefer_en = is_non_zh_effective_locale(&guard.settings.ui.language);
    let roster_cache = roster::load_roster_cache(&guard.base_dir);
    let roster_map = roster::get_roster_map(&games, roster_cache.as_ref(), prefer_en);
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let custom_locales = load_custom_locales(exe_dir.as_deref(), &guard.base_dir);
    Bootstrap {
        pending_preset_count: 0,
        settings: guard.settings.clone(),
        games,
        snapshot,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        roster_map,
        custom_locales,
    }
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    let guard = state.0.lock().expect("state lock");
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        electron: "tauri-2".to_string(),
        node: "rust".to_string(),
        chrome: "webview2".to_string(),
        platform: std::env::consts::OS.to_string(),
        user_data: guard.base_dir.to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn save_settings_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: Value,
) -> Result<Settings, String> {
    let mut guard = state.0.lock().expect("state lock");
    let next = normalize_settings(merge_settings_patch(&guard.settings, &patch));
    save_settings_atomic(&guard.base_dir, &next)?;
    guard.settings = next.clone();
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    Ok(next)
}

#[tauri::command]
fn switch_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
) -> Result<Option<GameSnapshot>, String> {
    let mut guard = state.0.lock().expect("state lock");
    let game = get_game(&guard.settings, &game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    guard.settings.active_game_id = game.id.clone();
    save_settings_atomic(&guard.base_dir, &guard.settings)?;
    if mark_roster_initialized(&mut guard.metadata, &game.id) {
        let _ = save_metadata(&guard.base_dir, &guard.metadata);
    }
    let snapshot = snapshot_for_game(&guard, &game.id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), None);
    Ok(snapshot)
}

#[tauri::command]
fn scan_game(state: State<'_, AppState>, game_id: String) -> Result<Option<GameSnapshot>, String> {
    let mut guard = state.0.lock().expect("state lock");
    let game = get_game(&guard.settings, &game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    if mark_roster_initialized(&mut guard.metadata, &game.id) {
        let _ = save_metadata(&guard.base_dir, &guard.metadata);
    }
    snapshot_for_game(&guard, &game.id)
}

#[tauri::command]
fn get_mods(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> Result<Vec<ModInfo>, String> {
    let guard = state.0.lock().expect("state lock");
    let gs = guard
        .settings
        .games
        .get(&game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    if gs.mods_path.is_empty() {
        return Ok(Vec::new());
    }
    let key = format!("{game_id}:{character_folder}");
    let custom_order = guard
        .settings
        .mod_orders
        .get(&key)
        .cloned()
        .unwrap_or_default();
    list_mods(
        Path::new(&gs.mods_path),
        &character_folder,
        &guard.settings.ui.sort_mods,
        &custom_order,
    )
}

#[tauri::command]
fn toggle_mod_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    enable: bool,
    exclusive: bool,
) -> ToggleResult {
    let mut guard = state.0.lock().expect("state lock");
    let Some(mods_path_str) = guard.settings.games.get(&game_id).map(|g| g.mods_path.clone()) else {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(format!("Unknown game: {game_id}")),
        };
    };
    if mods_path_str.is_empty() {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some("Mods path not configured".into()),
        };
    }
    match fs_toggle_mod(
        Path::new(&mods_path_str),
        &character_folder,
        &mod_folder,
        enable,
        exclusive,
    ) {
        Ok(()) => {
            let base_name = if mod_folder.len() >= 9
                && mod_folder.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
            {
                mod_folder[9..].to_string()
            } else {
                mod_folder.clone()
            };
            let recent_folder = if enable {
                base_name.clone()
            } else {
                format!("DISABLED_{base_name}")
            };
            record_recent_mod(
                &mut guard.settings,
                &game_id,
                &character_folder,
                &recent_folder,
                &base_name,
            );
            let _ = save_settings_atomic(&guard.base_dir, &guard.settings);
            let auto_reload = guard.settings.ui.auto_reload_mod_toggle;
            let hints = active_exe_hints(&guard.settings);
            let reload_key = if guard.settings.ui.reload_hotkey.trim().is_empty() {
                "F10".to_string()
            } else {
                guard.settings.ui.reload_hotkey.trim().to_string()
            };
            drop(guard);
            let reloaded = if auto_reload {
                Some(input::send_hotkey(&reload_key, &hints).is_ok())
            } else {
                Some(false)
            };
            emit_state_changed(&app, Some(&game_id), Some(&character_folder));
            ToggleResult {
                ok: true,
                reloaded,
                error: None,
            }
        }
        Err(err) => ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(err),
        },
    }
}

#[tauri::command]
fn get_mod_details_cmd(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> Result<ModDetails, String> {
    let guard = state.0.lock().expect("state lock");
    let gs = guard
        .settings
        .games
        .get(&game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    get_mod_details(Path::new(&gs.mods_path), &character_folder, &mod_folder)
}

#[tauri::command]
fn open_character_folder(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> SimpleResult {
    let guard = state.0.lock().expect("state lock");
    let Some(gs) = guard.settings.games.get(&game_id) else {
        return SimpleResult {
            ok: false,
            error: Some("Unknown game".into()),
        };
    };
    match resolve_character_dir(Path::new(&gs.mods_path), &character_folder) {
        Ok(dir) => open_in_explorer(&dir),
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn open_mod_folder(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> SimpleResult {
    let guard = state.0.lock().expect("state lock");
    let Some(gs) = guard.settings.games.get(&game_id) else {
        return SimpleResult {
            ok: false,
            error: Some("Unknown game".into()),
        };
    };
    match resolve_character_dir(Path::new(&gs.mods_path), &character_folder) {
        Ok(dir) => open_in_explorer(&dir.join(mod_folder)),
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn open_path(state: State<'_, AppState>, kind: String, game_id: Option<String>) -> SimpleResult {
    let guard = state.0.lock().expect("state lock");
    let target = match kind.as_str() {
        "userData" | "logs" | "languages" => guard.base_dir.clone(),
        "mods" => {
            let gid = game_id.unwrap_or_else(|| guard.settings.active_game_id.clone());
            guard
                .settings
                .games
                .get(&gid)
                .map(|g| PathBuf::from(&g.mods_path))
                .unwrap_or_default()
        }
        _ => guard.base_dir.clone(),
    };
    open_in_explorer(&target)
}

fn open_in_explorer(target: &Path) -> SimpleResult {
    if target.as_os_str().is_empty() || !target.exists() {
        return SimpleResult {
            ok: false,
            error: Some("Target path does not exist".into()),
        };
    }
    match Command::new("explorer.exe").arg(target).spawn() {
        Ok(_) => SimpleResult {
            ok: true,
            error: None,
        },
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
fn reload_f10(state: State<'_, AppState>) -> SimpleResult {
    let guard = state.0.lock().expect("state lock");
    let hints = active_exe_hints(&guard.settings);
    let reload_key = if guard.settings.ui.reload_hotkey.trim().is_empty() {
        "F10".to_string()
    } else {
        guard.settings.ui.reload_hotkey.trim().to_string()
    };
    drop(guard);
    match input::send_hotkey(&reload_key, &hints) {
        Ok(()) => SimpleResult {
            ok: true,
            error: None,
        },
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn set_reload_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> HotkeyResult {
    let trimmed = hotkey.trim();
    let value = if trimmed.is_empty() {
        "F10".to_string()
    } else {
        trimmed.to_string()
    };
    let mut guard = state.0.lock().expect("state lock");
    guard.settings.ui.reload_hotkey = value.clone();
    if let Err(err) = save_settings(&guard.base_dir, &guard.settings) {
        return HotkeyResult {
            ok: false,
            hotkey: None,
            error: Some(err),
        };
    }
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    HotkeyResult {
        ok: true,
        hotkey: Some(value),
        error: None,
    }
}

#[tauri::command]
fn send_mod_hotkey(state: State<'_, AppState>, key: String) -> SimpleResult {
    let guard = state.0.lock().expect("state lock");
    let hints = active_exe_hints(&guard.settings);
    drop(guard);
    match input::send_hotkey(&key, &hints) {
        Ok(()) => SimpleResult {
            ok: true,
            error: None,
        },
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e),
        },
    }
}

#[tauri::command]
fn toggle_overlay(app: AppHandle) -> SimpleResult {
    do_toggle_overlay(&app);
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn overlay_hide(app: AppHandle) -> SimpleResult {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn overlay_open_manager(app: AppHandle) -> SimpleResult {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn set_overlay_pinned(app: AppHandle, state: State<'_, AppState>, pinned: bool) -> SimpleResult {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_always_on_top(pinned);
    }
    let mut guard = state.0.lock().expect("state lock");
    guard.settings.ui.overlay_pinned = pinned;
    let _ = save_settings(&guard.base_dir, &guard.settings);
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn get_overlay_hotkey(state: State<'_, AppState>) -> String {
    state
        .0
        .lock()
        .expect("state lock")
        .settings
        .ui
        .overlay_hotkey
        .clone()
}

#[tauri::command]
fn set_overlay_hotkey(
    app: AppHandle,
    state: State<'_, AppState>,
    hotkey: String,
) -> HotkeyResult {
    let display_value = hotkey.trim().to_string();
    let mut guard = state.0.lock().expect("state lock");
    let prev_registered = guard.registered_hotkey.clone();

    if let Some(prev) = prev_registered.as_deref() {
        let _ = app.global_shortcut().unregister(prev);
    }

    let next_registered = if display_value.is_empty() {
        None
    } else {
        let normalized = normalize_shortcut_for_tauri(&display_value);
        if let Err(err) = app.global_shortcut().register(normalized.as_str()) {
            if let Some(prev) = prev_registered.as_deref() {
                let _ = app.global_shortcut().register(prev);
            }
            return HotkeyResult {
                ok: false,
                hotkey: None,
                error: Some(format!("Failed to register {display_value}: {err}")),
            };
        }
        Some(normalized)
    };

    guard.registered_hotkey = next_registered;
    guard.settings.ui.overlay_hotkey = display_value.clone();
    if let Err(err) = save_settings(&guard.base_dir, &guard.settings) {
        return HotkeyResult {
            ok: false,
            hotkey: None,
            error: Some(err),
        };
    }
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    HotkeyResult {
        ok: true,
        hotkey: Some(display_value),
        error: None,
    }
}

#[tauri::command]
fn get_pending_preset_count() -> usize {
    0
}

fn file_path_to_string(fp: FilePath) -> Option<String> {
    fp.into_path()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

async fn pick_folder_async(
    app: AppHandle,
    title: &'static str,
    default_path: Option<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title(title);
        if let Some(win) = app.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        if let Some(raw) = default_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let p = Path::new(raw);
            let dir = if p.is_dir() {
                Some(p)
            } else {
                p.parent().filter(|parent| parent.is_dir())
            };
            if let Some(d) = dir {
                builder = builder.set_directory(d);
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        builder.pick_folder(move |picked| {
            let _ = tx.send(picked.and_then(file_path_to_string));
        });
        rx.recv().ok().flatten()
    })
    .await
    .ok()
    .flatten()
}

async fn pick_file_async(
    app: AppHandle,
    title: &'static str,
    default_path: Option<String>,
    filter_name: &'static str,
    extensions: &'static [&'static str],
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_title(title)
            .add_filter(filter_name, extensions);
        if let Some(win) = app.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        if let Some(raw) = default_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let p = Path::new(raw);
            let dir = if p.is_dir() {
                Some(p)
            } else {
                p.parent().filter(|parent| parent.is_dir())
            };
            if let Some(d) = dir {
                builder = builder.set_directory(d);
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        builder.pick_file(move |picked| {
            let _ = tx.send(picked.and_then(file_path_to_string));
        });
        rx.recv().ok().flatten()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
fn save_custom_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_def: Value,
    game_settings: Option<GameSettings>,
) -> CustomGameMutationResult {
    let mut guard = state.0.lock().expect("state lock");
    let existing_ids: Vec<String> = get_all_games(&guard.settings)
        .into_iter()
        .map(|g| g.id)
        .collect();
    let custom = match sanitize_custom_game(&game_def, &existing_ids) {
        Ok(g) => g,
        Err(err) => {
            return CustomGameMutationResult {
                ok: false,
                error: Some(err),
                snapshot: None,
            };
        }
    };
    let custom_id = custom.id.clone();

    if let Some(slot) = guard
        .settings
        .custom_games
        .iter_mut()
        .find(|g| g.id == custom_id)
    {
        *slot = custom;
    } else {
        guard.settings.custom_games.push(custom);
    }

    if let Some(gs) = game_settings {
        guard.settings.games.insert(custom_id.clone(), gs);
    } else {
        guard
            .settings
            .games
            .entry(custom_id.clone())
            .or_insert_with(GameSettings::default);
    }

    guard.settings.active_game_id = custom_id.clone();
    guard.settings = normalize_settings(guard.settings.clone());
    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return CustomGameMutationResult {
            ok: false,
            error: Some(err),
            snapshot: None,
        };
    }

    let snapshot = snapshot_for_game(&guard, &custom_id).ok().flatten();
    drop(guard);
    emit_state_changed(&app, Some(&custom_id), None);
    CustomGameMutationResult {
        ok: true,
        error: None,
        snapshot,
    }
}

#[tauri::command]
fn delete_custom_game(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
) -> CustomGameMutationResult {
    if is_builtin_game(&game_id) {
        return CustomGameMutationResult {
            ok: false,
            error: Some("Cannot delete a built-in game".to_string()),
            snapshot: None,
        };
    }

    let mut guard = state.0.lock().expect("state lock");
    let before = guard.settings.custom_games.len();
    guard.settings.custom_games.retain(|g| g.id != game_id);
    if guard.settings.custom_games.len() == before {
        return CustomGameMutationResult {
            ok: false,
            error: Some(format!("Custom game not found: {game_id}")),
            snapshot: None,
        };
    }

    guard.settings.games.remove(&game_id);
    guard.settings.hidden_game_ids.retain(|id| id != &game_id);
    guard.settings.character_orders.remove(&game_id);
    guard.settings.recent_mods.retain(|m| m.game_id != game_id);
    if guard.settings.active_game_id == game_id {
        guard.settings.active_game_id = "wuthering-waves".to_string();
    }
    guard.settings = normalize_settings(guard.settings.clone());
    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return CustomGameMutationResult {
            ok: false,
            error: Some(err),
            snapshot: None,
        };
    }

    let active_id = guard.settings.active_game_id.clone();
    let snapshot = snapshot_for_game(&guard, &active_id).ok().flatten();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    CustomGameMutationResult {
        ok: true,
        error: None,
        snapshot,
    }
}

#[tauri::command]
fn toggle_game_visibility(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    visible: Option<bool>,
) -> ToggleVisibilityResult {
    let mut guard = state.0.lock().expect("state lock");
    if get_game(&guard.settings, &game_id).is_none() {
        return ToggleVisibilityResult {
            ok: false,
            hidden_game_ids: guard.settings.hidden_game_ids.clone(),
            error: Some(format!("Unknown game: {game_id}")),
        };
    }

    let currently_hidden = guard.settings.hidden_game_ids.iter().any(|id| id == &game_id);
    let should_hide = match visible {
        Some(v) => !v,
        None => !currently_hidden,
    };

    if should_hide && !currently_hidden {
        guard.settings.hidden_game_ids.push(game_id.clone());
    } else if !should_hide {
        guard.settings.hidden_game_ids.retain(|id| id != &game_id);
    }

    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return ToggleVisibilityResult {
            ok: false,
            hidden_game_ids: guard.settings.hidden_game_ids.clone(),
            error: Some(err),
        };
    }

    let hidden_game_ids = guard.settings.hidden_game_ids.clone();
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    ToggleVisibilityResult {
        ok: true,
        hidden_game_ids,
        error: None,
    }
}

#[tauri::command]
fn set_only_show_configured_games(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> OnlyConfiguredResult {
    let mut guard = state.0.lock().expect("state lock");
    guard.settings.only_show_configured_games = enabled;
    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return OnlyConfiguredResult {
            ok: false,
            only_show_configured_games: guard.settings.only_show_configured_games,
            error: Some(err),
        };
    }
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    OnlyConfiguredResult {
        ok: true,
        only_show_configured_games: enabled,
        error: None,
    }
}

#[tauri::command]
async fn pick_mods_folder(app: AppHandle, default_path: Option<String>) -> Option<String> {
    pick_folder_async(app, "Select Mods Folder", default_path).await
}

#[tauri::command]
async fn pick_game_exe(app: AppHandle, default_path: Option<String>) -> Option<String> {
    pick_file_async(app, "Select Game Executable", default_path, "Executable", &["exe"]).await
}

#[tauri::command]
async fn pick_loader(app: AppHandle, default_path: Option<String>) -> Option<String> {
    pick_file_async(
        app,
        "Select XXMI / Mod Loader",
        default_path,
        "Launcher",
        &["exe", "bat", "cmd", "lnk"],
    )
    .await
}

#[tauri::command]
async fn pick_cover(app: AppHandle, default_path: Option<String>) -> Option<String> {
    pick_file_async(
        app,
        "Select Cover Image",
        default_path,
        "Images",
        &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
    )
    .await
}

#[tauri::command]
async fn pick_xxmi_root(
    app: AppHandle,
    state: State<'_, AppState>,
    default_path: Option<String>,
) -> Result<AutoDetectPathsResult, String> {
    let fallback_default = {
        let guard = state.0.lock().expect("state lock");
        default_path.or_else(|| guard.settings.xxmi_root.clone())
    };
    let Some(picked) = pick_folder_async(app.clone(), "Select XXMI Root Folder", fallback_default).await
    else {
        return Ok(AutoDetectPathsResult {
            ok: false,
            xxmi_root: None,
            detected_games: Vec::new(),
            settings: None,
            error: None,
        });
    };

    let current = {
        let guard = state.0.lock().expect("state lock");
        guard.settings.clone()
    };
    let mut result = detect::detect_xxmi_and_game_paths(&current, Some(&picked));
    if let Some(updated) = result.settings.take() {
        let normalized = normalize_settings(updated);
        let mut guard = state.0.lock().expect("state lock");
        if let Err(err) = save_settings_atomic(&guard.base_dir, &normalized) {
            return Ok(AutoDetectPathsResult {
                ok: false,
                xxmi_root: result.xxmi_root,
                detected_games: result.detected_games,
                settings: None,
                error: Some(err),
            });
        }
        guard.settings = normalized.clone();
        let active_id = guard.settings.active_game_id.clone();
        drop(guard);
        emit_state_changed(&app, Some(&active_id), None);
        result.settings = Some(normalized);
    }
    Ok(result)
}

#[tauri::command]
fn auto_detect_paths(app: AppHandle, state: State<'_, AppState>) -> AutoDetectPathsResult {
    let current = {
        let guard = state.0.lock().expect("state lock");
        guard.settings.clone()
    };
    let mut result = detect::detect_xxmi_and_game_paths(&current, None);
    if let Some(updated) = result.settings.take() {
        let normalized = normalize_settings(updated);
        let mut guard = state.0.lock().expect("state lock");
        if let Err(err) = save_settings_atomic(&guard.base_dir, &normalized) {
            return AutoDetectPathsResult {
                ok: false,
                xxmi_root: result.xxmi_root,
                detected_games: result.detected_games,
                settings: None,
                error: Some(err),
            };
        }
        guard.settings = normalized.clone();
        let active_id = guard.settings.active_game_id.clone();
        drop(guard);
        emit_state_changed(&app, Some(&active_id), None);
        result.settings = Some(normalized);
    }
    result
}

#[tauri::command]
fn check_environment(state: State<'_, AppState>, game_id: Option<String>) -> Vec<EnvironmentCheck> {
    let settings = {
        let guard = state.0.lock().expect("state lock");
        guard.settings.clone()
    };
    let is_en = is_non_zh_effective_locale(&settings.ui.language);
    detect::check_environment_for_settings(&settings, game_id.as_deref(), is_en)
}

#[tauri::command]
fn open_environment_folder(state: State<'_, AppState>, game_id: String) -> SimpleResult {
    let mods_path = {
        let guard = state.0.lock().expect("state lock");
        guard
            .settings
            .games
            .get(&game_id)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default()
    };
    let Some(root) = detect::resolve_env_root(&mods_path) else {
        return SimpleResult {
            ok: false,
            error: Some("Mods directory is not configured".to_string()),
        };
    };
    if !root.is_dir() {
        return SimpleResult {
            ok: false,
            error: Some(format!("Path does not exist: {}", root.display())),
        };
    }
    open_in_explorer(&root)
}

#[tauri::command]
fn clear_shader_cache(state: State<'_, AppState>, game_id: String) -> ClearShaderCacheResult {
    let settings = {
        let guard = state.0.lock().expect("state lock");
        guard.settings.clone()
    };
    let is_en = is_non_zh_effective_locale(&settings.ui.language);
    detect::clear_shader_cache_for_game(&settings, &game_id, is_en)
}

fn apply_character_meta_patch(existing: CharacterMeta, patch: &Value) -> CharacterMeta {
    let Some(obj) = patch.as_object() else {
        return existing;
    };
    let mut next = existing;

    if let Some(v) = obj.get("displayName") {
        next.display_name = v.as_str().map(str::to_string);
    }
    if let Some(v) = obj.get("canonicalEnName") {
        next.canonical_en_name = v.as_str().map(str::to_string);
    }
    if let Some(v) = obj.get("coverFile") {
        next.cover_file = v.as_str().map(str::to_string);
    }
    if let Some(v) = obj.get("note") {
        next.note = v.as_str().map(str::to_string);
    }
    if let Some(v) = obj.get("kind") {
        next.kind = v.as_str().map(str::to_string);
    }
    if let Some(v) = obj.get("hidden") {
        next.hidden = v.as_bool();
    }
    if let Some(v) = obj.get("order") {
        next.order = v.as_i64();
    }
    if let Some(v) = obj.get("aliases") {
        next.aliases = v.as_array().map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        });
    }
    next
}

#[tauri::command]
fn update_character_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    patch: Value,
) -> Result<Option<GameSnapshot>, String> {
    if !library::is_safe_segment(&character_folder) {
        return Err("Invalid character folder".to_string());
    }
    let mut guard = state.0.lock().expect("state lock");
    if get_game(&guard.settings, &game_id).is_none() {
        return Err(format!("Unknown game: {game_id}"));
    }
    let existing = get_character_meta(&guard.metadata, &game_id, &character_folder)
        .cloned()
        .unwrap_or_default();
    let updated = apply_character_meta_patch(existing, &patch);
    set_character_meta(&mut guard.metadata, &game_id, &character_folder, updated);
    save_metadata(&guard.base_dir, &guard.metadata)?;
    let snapshot = snapshot_for_game(&guard, &game_id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(snapshot)
}

#[tauri::command]
async fn set_character_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> Result<ToggleResult, String> {
    if !library::is_safe_segment(&character_folder) {
        return Ok(ToggleResult {
            ok: false,
            reloaded: None,
            error: Some("Invalid character folder".to_string()),
        });
    }
    let default_dir = {
        let guard = state.0.lock().expect("state lock");
        guard
            .settings
            .games
            .get(&game_id)
            .map(|gs| gs.mods_path.clone())
    };
    let Some(picked) = pick_file_async(
        app.clone(),
        "Select Character Cover",
        default_dir,
        "Images",
        &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
    )
    .await
    else {
        return Ok(ToggleResult {
            ok: false,
            reloaded: None,
            error: None,
        });
    };

    let mut guard = state.0.lock().expect("state lock");
    let cover_rel = match save_cover(
        &guard.base_dir,
        &game_id,
        &character_folder,
        Path::new(&picked),
    ) {
        Ok(rel) => rel,
        Err(err) => {
            return Ok(ToggleResult {
                ok: false,
                reloaded: None,
                error: Some(err),
            });
        }
    };

    let mut meta = get_character_meta(&guard.metadata, &game_id, &character_folder)
        .cloned()
        .unwrap_or_default();
    meta.cover_file = Some(cover_rel);
    set_character_meta(&mut guard.metadata, &game_id, &character_folder, meta);
    if let Err(err) = save_metadata(&guard.base_dir, &guard.metadata) {
        return Ok(ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(err),
        });
    }
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(ToggleResult {
        ok: true,
        reloaded: None,
        error: None,
    })
}

#[tauri::command]
fn reset_character_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> Result<Option<GameSnapshot>, String> {
    if !library::is_safe_segment(&character_folder) {
        return Err("Invalid character folder".to_string());
    }
    let mut guard = state.0.lock().expect("state lock");
    let char_dir = guard
        .settings
        .games
        .get(&game_id)
        .filter(|gs| !gs.mods_path.trim().is_empty())
        .and_then(|gs| resolve_character_dir(Path::new(&gs.mods_path), &character_folder).ok());

    let base_dir = guard.base_dir.clone();
    clear_character_cover_files(
        &base_dir,
        &mut guard.metadata,
        &game_id,
        &character_folder,
        char_dir.as_deref(),
    );
    remove_character_meta(&mut guard.metadata, &game_id, &character_folder);
    save_metadata(&guard.base_dir, &guard.metadata)?;
    let snapshot = snapshot_for_game(&guard, &game_id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(snapshot)
}

#[tauri::command]
fn create_character(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    input: CreateCharacterInput,
) -> Result<Option<GameSnapshot>, String> {
    let mut guard = state.0.lock().expect("state lock");
    let mods_path_str = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.clone())
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    if mods_path_str.trim().is_empty() {
        return Err("Mods path not configured".to_string());
    }

    let created_folder = create_character_dir(
        Path::new(&mods_path_str),
        &mut guard.metadata,
        &game_id,
        &input,
    )?;
    save_metadata(&guard.base_dir, &guard.metadata)?;
    let snapshot = snapshot_for_game(&guard, &game_id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&created_folder));
    Ok(snapshot)
}

#[tauri::command]
fn save_character_cover_data(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    data_url: String,
) -> Result<Option<GameSnapshot>, String> {
    let mut guard = state.0.lock().expect("state lock");
    let mods_path_str = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.clone())
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    let char_dir = resolve_character_dir(Path::new(&mods_path_str), &character_folder)?;
    fs_save_character_cover_data(&char_dir, &data_url)?;

    if let Some(mut meta) = get_character_meta(&guard.metadata, &game_id, &character_folder).cloned()
    {
        if meta.cover_file.is_some() {
            meta.cover_file = None;
            set_character_meta(&mut guard.metadata, &game_id, &character_folder, meta);
            save_metadata(&guard.base_dir, &guard.metadata)?;
        }
    }

    let snapshot = snapshot_for_game(&guard, &game_id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(snapshot)
}

#[tauri::command]
fn clear_character_cover(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> Result<Option<GameSnapshot>, String> {
    if !library::is_safe_segment(&character_folder) {
        return Err("Invalid character folder".to_string());
    }
    let mut guard = state.0.lock().expect("state lock");
    let char_dir = guard
        .settings
        .games
        .get(&game_id)
        .filter(|gs| !gs.mods_path.trim().is_empty())
        .and_then(|gs| resolve_character_dir(Path::new(&gs.mods_path), &character_folder).ok());

    let base_dir = guard.base_dir.clone();
    clear_character_cover_files(
        &base_dir,
        &mut guard.metadata,
        &game_id,
        &character_folder,
        char_dir.as_deref(),
    );
    save_metadata(&guard.base_dir, &guard.metadata)?;
    let snapshot = snapshot_for_game(&guard, &game_id)?;
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(snapshot)
}

#[tauri::command]
async fn set_mod_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    source_path: Option<String>,
) -> Result<ToggleResult, String> {
    let resolved_source = match source_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => {
            let default_dir = {
                let guard = state.0.lock().expect("state lock");
                guard
                    .settings
                    .games
                    .get(&game_id)
                    .and_then(|gs| {
                        resolve_character_dir(Path::new(&gs.mods_path), &character_folder).ok()
                    })
                    .map(|p| p.join(&mod_folder).to_string_lossy().to_string())
            };
            match pick_file_async(
                app.clone(),
                "Select Mod Preview Image",
                default_dir,
                "Images",
                &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
            )
            .await
            {
                Some(p) => p,
                None => {
                    return Ok(ToggleResult {
                        ok: false,
                        reloaded: None,
                        error: None,
                    });
                }
            }
        }
    };

    let guard = state.0.lock().expect("state lock");
    let Some(mods_path_str) = guard.settings.games.get(&game_id).map(|g| g.mods_path.clone()) else {
        return Ok(ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(format!("Unknown game: {game_id}")),
        });
    };
    if let Err(err) = set_mod_preview_file(
        Path::new(&mods_path_str),
        &character_folder,
        &mod_folder,
        &resolved_source,
    ) {
        return Ok(ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(err),
        });
    }
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    Ok(ToggleResult {
        ok: true,
        reloaded: None,
        error: None,
    })
}

#[tauri::command]
fn reorder_characters(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    folders: Vec<String>,
) -> ToggleResult {
    let mut guard = state.0.lock().expect("state lock");
    let clean: Vec<String> = folders
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    guard.settings.character_orders.insert(game_id.clone(), clean);
    guard.settings.ui.sort_characters = "custom".to_string();
    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(err),
        };
    }
    drop(guard);
    emit_state_changed(&app, Some(&game_id), None);
    ToggleResult {
        ok: true,
        reloaded: None,
        error: None,
    }
}

#[tauri::command]
fn reorder_mods(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    folders: Vec<String>,
) -> ToggleResult {
    let mut guard = state.0.lock().expect("state lock");
    let clean: Vec<String> = folders
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let key = format!("{game_id}:{character_folder}");
    guard.settings.mod_orders.insert(key, clean);
    guard.settings.ui.sort_mods = "custom".to_string();
    if let Err(err) = save_settings_atomic(&guard.base_dir, &guard.settings) {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(err),
        };
    }
    drop(guard);
    emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    ToggleResult {
        ok: true,
        reloaded: None,
        error: None,
    }
}

#[tauri::command]
fn get_roster_status(state: State<'_, AppState>) -> RosterSyncStatus {
    let guard = state.0.lock().expect("state lock");
    let games = get_all_games(&guard.settings);
    let cache = roster::load_roster_cache(&guard.base_dir);
    let remote_url = guard
        .settings
        .import
        .roster_remote_url
        .clone()
        .unwrap_or_default();
    roster::get_roster_status(&remote_url, &games, cache.as_ref())
}

#[tauri::command]
async fn sync_remote_roster(
    app: AppHandle,
    state: State<'_, AppState>,
    custom_url: Option<String>,
) -> Result<RosterSyncResult, String> {
    let (base_dir, target_url, games, prefer_en) = {
        let mut guard = state.0.lock().expect("state lock");
        if let Some(url) = custom_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if guard.settings.import.roster_remote_url.as_deref() != Some(url) {
                guard.settings.import.roster_remote_url = Some(url.to_string());
                let _ = save_settings_atomic(&guard.base_dir, &guard.settings);
            }
        }
        let target = custom_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| guard.settings.import.roster_remote_url.clone())
            .unwrap_or_default();
        let games = get_all_games(&guard.settings);
        let prefer_en = is_non_zh_effective_locale(&guard.settings.ui.language);
        (guard.base_dir.clone(), target, games, prefer_en)
    };

    let mut result = tauri::async_runtime::spawn_blocking(move || {
        roster::sync_remote_roster(&base_dir, &target_url, &games)
    })
    .await
    .unwrap_or_else(|err| RosterSyncResult {
        ok: false,
        updated_at: None,
        added_or_updated: None,
        created_folders_count: None,
        error: Some(format!("Roster sync task failed: {err}")),
        status: None,
    });

    if result.ok {
        let active_id = {
            let mut guard = state.0.lock().expect("state lock");
            let cache = roster::load_roster_cache(&guard.base_dir);
            let settings_snapshot = guard.settings.clone();
            let (created_count, meta_changed) = sync_missing_roster_folders_to_disk(
                &settings_snapshot,
                &mut guard.metadata,
                cache.as_ref(),
                prefer_en,
            );
            if meta_changed {
                let _ = save_metadata(&guard.base_dir, &guard.metadata);
            }
            result.created_folders_count = Some(created_count);
            guard.settings.active_game_id.clone()
        };
        emit_state_changed(&app, Some(&active_id), None);
    }

    Ok(result)
}

fn append_crash_log(base_dir: &Path, message: &str) {
    let logs_dir = base_dir.join("logs");
    let _ = fs::create_dir_all(&logs_dir);
    let log_path = logs_dir.join("tauri-crash.log");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
        use std::io::Write;
        let _ = writeln!(f, "[{ts}] {message}");
    }
}

#[cfg(windows)]
fn show_fatal_error_dialog(message: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title = HSTRING::from("ModDeck Error");
    let body = HSTRING::from(message);
    unsafe {
        let _ = MessageBoxW(None, &body, &title, MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn show_fatal_error_dialog(_message: &str) {}

fn install_panic_hook(base_dir: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let msg = format!("Panic at {loc}: {payload}");
        append_crash_log(&base_dir, &msg);
        show_fatal_error_dialog(&format!(
            "ModDeck encountered a startup/runtime error:\n\n{msg}\n\nCrash log saved to:\n{}",
            base_dir.join("logs").join("tauri-crash.log").display()
        ));
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let base_dir = resolve_base_dir();
    install_panic_hook(base_dir.clone());
    if !input::acquire_single_instance_or_focus() {
        return;
    }
    let settings = normalize_settings(load_settings(&base_dir));
    let metadata = load_metadata(&base_dir);
    let initial_hotkey = if settings.ui.overlay_hotkey.trim().is_empty() {
        String::new()
    } else {
        normalize_shortcut_for_tauri(&settings.ui.overlay_hotkey)
    };

    let setup_base_dir = base_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState(Mutex::new(InnerState {
            base_dir,
            settings,
            metadata,
            registered_hotkey: None,
            last_overlay_toggle: None,
            webview_data_dir: None,
        })))
        .register_uri_scheme_protocol("moddeck", |ctx, request| {
            let uri = request.uri();
            let raw_path = uri
                .query()
                .and_then(decode_asset_query)
                .unwrap_or_default();
            let state = ctx.app_handle().state::<AppState>();
            let guard = state.0.lock().expect("state lock");
            let file_path = PathBuf::from(&raw_path);
            let allowed = !raw_path.is_empty()
                && is_allowed_asset_path(&guard.base_dir, &guard.settings, &file_path);
            drop(guard);

            if !allowed {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Vec::new())
                    .unwrap();
            }

            match fs::read(&file_path) {
                Ok(bytes) => Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, mime_for_path(&file_path))
                    .header("Cache-Control", "no-store")
                    .body(bytes)
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        do_toggle_overlay(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                match window.label() {
                    "main" => {
                        window.app_handle().exit(0);
                    }
                    "overlay" => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {}
                }
            }
        })
        .setup(move |app| {
            let mut active_data_dir: Option<PathBuf> = None;
            if let Err(primary_err) = create_window_from_config(app.handle(), "main", None) {
                append_crash_log(
                    &setup_base_dir,
                    &format!("main window primary WebView2 init failed: {primary_err}"),
                );
                let fallback_dir = fallback_webview_data_dir(&setup_base_dir);
                if let Err(retry_err) =
                    create_window_from_config(app.handle(), "main", Some(&fallback_dir))
                {
                    return Err(format!(
                        "Failed to create main window.\nPrimary: {primary_err}\nFallback ({}): {retry_err}",
                        fallback_dir.display()
                    )
                    .into());
                }
                append_crash_log(
                    &setup_base_dir,
                    &format!(
                        "main window recovered with fallback data_directory: {}",
                        fallback_dir.display()
                    ),
                );
                active_data_dir = Some(fallback_dir);
            }

            {
                let state = app.state::<AppState>();
                let mut guard = state.0.lock().expect("state lock");
                guard.webview_data_dir = active_data_dir.clone();
            }

            if let Err(overlay_err) =
                create_window_from_config(app.handle(), "overlay", active_data_dir.as_deref())
            {
                append_crash_log(
                    &setup_base_dir,
                    &format!("overlay window startup init failed (non-fatal): {overlay_err}"),
                );
            }

            if !initial_hotkey.is_empty() {
                match app.global_shortcut().register(initial_hotkey.as_str()) {
                    Ok(()) => {
                        let state = app.state::<AppState>();
                        let mut guard = state.0.lock().expect("state lock");
                        guard.registered_hotkey = Some(initial_hotkey.clone());
                    }
                    Err(err) => {
                        eprintln!("[moddeck-poc] Failed to register hotkey {initial_hotkey}: {err}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            app_info,
            save_settings_cmd,
            switch_game,
            scan_game,
            get_mods,
            toggle_mod_cmd,
            get_mod_details_cmd,
            open_character_folder,
            open_mod_folder,
            open_path,
            reload_f10,
            set_reload_hotkey,
            send_mod_hotkey,
            toggle_overlay,
            overlay_hide,
            overlay_open_manager,
            set_overlay_pinned,
            get_overlay_hotkey,
            set_overlay_hotkey,
            get_pending_preset_count,
            save_custom_game,
            delete_custom_game,
            toggle_game_visibility,
            set_only_show_configured_games,
            pick_mods_folder,
            pick_xxmi_root,
            auto_detect_paths,
            check_environment,
            open_environment_folder,
            clear_shader_cache,
            pick_game_exe,
            pick_loader,
            pick_cover,
            update_character_meta,
            set_character_cover,
            reset_character_meta,
            create_character,
            save_character_cover_data,
            clear_character_cover,
            set_mod_preview,
            reorder_characters,
            reorder_mods,
            get_roster_status,
            sync_remote_roster,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            let log_base = resolve_base_dir();
            let msg = format!("Tauri runtime error: {err}");
            append_crash_log(&log_base, &msg);
            show_fatal_error_dialog(&msg);
        });
}
