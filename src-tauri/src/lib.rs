mod games;
mod input;
mod library;
mod models;
mod settings;

use games::{get_all_games, get_game};
use library::{
    build_snapshot, decode_asset_query, get_mod_details, is_allowed_asset_path, list_mods,
    load_builtin_roster_map, resolve_character_dir, toggle_mod as fs_toggle_mod,
};
use models::{
    AppInfo, Bootstrap, GameSnapshot, HotkeyResult, MetadataStore, ModDetails, ModInfo, Settings,
    SimpleResult, StateChangedEvent, ToggleResult,
};
use serde_json::Value;
use settings::{load_metadata, load_settings, merge_settings_patch, resolve_base_dir, save_settings};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct InnerState {
    base_dir: PathBuf,
    settings: Settings,
    metadata: MetadataStore,
    registered_hotkey: Option<String>,
    last_overlay_toggle: Option<Instant>,
}

pub struct AppState(Mutex<InnerState>);

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
    let pinned = {
        let state = app.state::<AppState>();
        let mut guard = state.0.lock().expect("state lock");
        let now = Instant::now();
        if let Some(prev) = guard.last_overlay_toggle {
            if now.duration_since(prev) < Duration::from_millis(120) {
                return;
            }
        }
        guard.last_overlay_toggle = Some(now);
        guard.settings.ui.overlay_pinned
    };
    if let Some(win) = app.get_webview_window("overlay") {
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

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Bootstrap {
    let guard = state.0.lock().expect("state lock");
    let games = get_all_games(&guard.settings);
    let snapshot = get_game(&guard.settings, &guard.settings.active_game_id).map(|g| {
        let gs = guard
            .settings
            .games
            .get(&g.id)
            .cloned()
            .unwrap_or_default();
        build_snapshot(&guard.base_dir, &g, &gs, &guard.metadata, &guard.settings)
    });
    Bootstrap {
        pending_preset_count: 0,
        settings: guard.settings.clone(),
        games,
        snapshot,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        roster_map: load_builtin_roster_map(),
        custom_locales: HashMap::new(),
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
    let next = merge_settings_patch(&guard.settings, &patch);
    save_settings(&guard.base_dir, &next)?;
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
    save_settings(&guard.base_dir, &guard.settings)?;
    let gs = guard
        .settings
        .games
        .get(&game.id)
        .cloned()
        .unwrap_or_default();
    let snapshot = build_snapshot(&guard.base_dir, &game, &gs, &guard.metadata, &guard.settings);
    drop(guard);
    emit_state_changed(&app, Some(&game_id), None);
    Ok(Some(snapshot))
}

#[tauri::command]
fn scan_game(state: State<'_, AppState>, game_id: String) -> Result<Option<GameSnapshot>, String> {
    let guard = state.0.lock().expect("state lock");
    let game = get_game(&guard.settings, &game_id)
        .ok_or_else(|| format!("Unknown game: {game_id}"))?;
    let gs = guard
        .settings
        .games
        .get(&game.id)
        .cloned()
        .unwrap_or_default();
    Ok(Some(build_snapshot(
        &guard.base_dir,
        &game,
        &gs,
        &guard.metadata,
        &guard.settings,
    )))
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
    let guard = state.0.lock().expect("state lock");
    let Some(gs) = guard.settings.games.get(&game_id) else {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some(format!("Unknown game: {game_id}")),
        };
    };
    if gs.mods_path.is_empty() {
        return ToggleResult {
            ok: false,
            reloaded: None,
            error: Some("Mods path not configured".into()),
        };
    }
    match fs_toggle_mod(
        Path::new(&gs.mods_path),
        &character_folder,
        &mod_folder,
        enable,
        exclusive,
    ) {
        Ok(()) => {
            let auto_reload = guard.settings.ui.auto_reload_mod_toggle;
            let hints = active_exe_hints(&guard.settings);
            drop(guard);
            let reloaded = if auto_reload {
                Some(input::send_f10(&hints).is_ok())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !input::acquire_single_instance_or_focus() {
        return;
    }
    let base_dir = resolve_base_dir();
    let settings = load_settings(&base_dir);
    let metadata = load_metadata(&base_dir);
    let initial_hotkey = if settings.ui.overlay_hotkey.trim().is_empty() {
        String::new()
    } else {
        normalize_shortcut_for_tauri(&settings.ui.overlay_hotkey)
    };

    tauri::Builder::default()
        .manage(AppState(Mutex::new(InnerState {
            base_dir,
            settings,
            metadata,
            registered_hotkey: None,
            last_overlay_toggle: None,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running ModDeck Tauri POC");
}
