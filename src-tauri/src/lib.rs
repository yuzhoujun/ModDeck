mod detect;
mod games;
mod imports;
mod ini_analysis;
mod input;
mod launcher;
mod library;
mod metadata;
mod models;
mod presets;
mod roster;
mod settings;
mod storage;

use games::{get_all_games, get_game, is_builtin_game, sanitize_custom_game};
use library::{
    build_snapshot, create_character_dir, decode_asset_query, get_mod_details,
    is_allowed_asset_path, list_mods, resolve_character_dir, resolve_mod_target_dir,
    set_mod_preview_file, sync_missing_roster_folders_to_disk, toggle_mod as fs_toggle_mod,
};
use metadata::{
    clear_character_cover_files, get_character_meta, load_metadata, mark_roster_initialized,
    remove_character_meta, save_character_cover_data as fs_save_character_cover_data, save_cover,
    save_metadata, set_character_meta,
};
use models::{
    AppInfo, AutoDetectPathsResult, Bootstrap, CharacterHashConflict, CharacterMeta,
    ClearShaderCacheResult, ConfigBundleInspection, CreateCharacterInput, CustomGameMutationResult,
    D3dxSyncStatus, EnvironmentCheck, ExportPresetResult, GameConflictAuditReport, GameSettings,
    GameSnapshot, HotkeyResult, ImportCommitRequest, ImportConfigBundleOptions,
    ImportConfigBundleResult, ImportParseRequest, ImportParseResult, ImportPresetsResult,
    ImportRequest, ImportResult, ImportRosterResult, MetadataStore, ModDetails, ModInfo,
    ModStaticAnalysis, ModVariantPreset, OnlyConfiguredResult, PruneBackupsResult, RosterPreset,
    RosterSchemeImportInspection, RosterSyncResult, RosterSyncStatus, SaveModPresetOptions,
    SaveModPresetResult, SaveRosterPresetInput, Settings, SimpleResult, StateChangedEvent,
    StorageOverview, ToggleResult, ToggleVisibilityResult,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use serde_json::Value;
use settings::{
    is_non_zh_effective_locale, load_custom_locales, load_settings, merge_settings_patch,
    normalize_settings, record_recent_mod, resolve_base_dir, save_settings, save_settings_atomic,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::http::{header::CONTENT_TYPE, Response, StatusCode};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, Url,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

static SUPPRESS_WATCHER_UNTIL_MS: AtomicU64 = AtomicU64::new(0);
static IS_QUITTING: AtomicBool = AtomicBool::new(false);
static RELOAD_GEN: AtomicU64 = AtomicU64::new(0);
static POST_SYNC_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayDetailRequest {
    game_id: String,
    character_folder: String,
    mod_folder: String,
}

fn file_mtime_and_size(path: &Path) -> (u64, u64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (mtime, meta.len())
        }
        Err(_) => (0, 0),
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mark_internal_fs_mutation() {
    SUPPRESS_WATCHER_UNTIL_MS.store(now_epoch_ms().saturating_add(850), Ordering::Relaxed);
}

#[cfg(windows)]
fn spawn_mods_watcher(app: AppHandle) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Storage::FileSystem::{
        FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
        FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    };
    use windows::Win32::System::Threading::WaitForSingleObject;

    let d3dx_app = app.clone();
    std::thread::Builder::new()
        .name("moddeck-mods-watcher".to_string())
        .spawn(move || {
            let mut watched_path = String::new();
            let mut watched_game = String::new();
            let mut handle: Option<HANDLE> = None;

            loop {
                let target = app
                    .state::<AppState>()
                    .0
                    .try_lock()
                    .ok()
                    .map(|g| {
                        let gid = g.settings.active_game_id.clone();
                        let mp = g
                            .settings
                            .games
                            .get(&gid)
                            .map(|cfg| cfg.mods_path.trim().to_string())
                            .unwrap_or_default();
                        (gid, mp)
                    });

                if let Some((gid, mp)) = target {
                    if mp != watched_path || gid != watched_game {
                        if let Some(h) = handle.take() {
                            unsafe {
                                let _ = FindCloseChangeNotification(h);
                            }
                        }
                        watched_path = mp.clone();
                        watched_game = gid.clone();
                        if !watched_path.is_empty() && Path::new(&watched_path).is_dir() {
                            let wide: Vec<u16> = Path::new(&watched_path)
                                .as_os_str()
                                .encode_wide()
                                .chain(Some(0))
                                .collect();
                            if let Ok(h) = unsafe {
                                FindFirstChangeNotificationW(
                                    PCWSTR(wide.as_ptr()),
                                    true,
                                    FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_FILE_NAME,
                                )
                            } {
                                handle = Some(h);
                            }
                        }
                    }
                }

                let Some(h) = handle else {
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                };

                let wait = unsafe { WaitForSingleObject(h, 450) };
                if wait == WAIT_OBJECT_0 {
                    // Drain bursts over a short debounce window before notifying UI
                    let _ = unsafe { FindNextChangeNotification(h) };
                    std::thread::sleep(Duration::from_millis(260));
                    while unsafe { WaitForSingleObject(h, 20) } == WAIT_OBJECT_0 {
                        let _ = unsafe { FindNextChangeNotification(h) };
                    }
                    if now_epoch_ms() >= SUPPRESS_WATCHER_UNTIL_MS.load(Ordering::Relaxed)
                        && !watched_game.is_empty()
                    {
                        emit_state_changed(&app, Some(&watched_game), None);
                    }
                } else {
                    // Check for missed handle invalidation if watched folder was removed
                    if !watched_path.is_empty() && !Path::new(&watched_path).is_dir() {
                        if let Some(h) = handle.take() {
                            unsafe {
                                let _ = FindCloseChangeNotification(h);
                            }
                        }
                        watched_path.clear();
                    }
                }
            }
        })
        .ok();
    spawn_d3dx_watcher(d3dx_app);
}

#[cfg(windows)]
fn spawn_d3dx_watcher(app: AppHandle) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::Storage::FileSystem::{
        FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
    };
    use windows::Win32::System::Threading::WaitForSingleObject;

    std::thread::Builder::new()
        .name("moddeck-d3dx-watcher".to_string())
        .spawn(move || {
            let mut watched_dir = PathBuf::new();
            let mut watched_mods = String::new();
            let mut watched_game = String::new();
            let mut last_sig = (0u64, 0u64);
            let mut handle: Option<HANDLE> = None;

            loop {
                let target = app
                    .state::<AppState>()
                    .0
                    .try_lock()
                    .ok()
                    .map(|g| {
                        let gid = g.settings.active_game_id.clone();
                        let mp = g
                            .settings
                            .games
                            .get(&gid)
                            .map(|cfg| cfg.mods_path.trim().to_string())
                            .unwrap_or_default();
                        (gid, mp)
                    });

                if let Some((gid, mp)) = target {
                    let watch_dir = if mp.is_empty() {
                        PathBuf::new()
                    } else {
                        presets::find_d3dx_user_ini_path(Path::new(&mp))
                            .and_then(|p| p.parent().map(Path::to_path_buf))
                            .or_else(|| Path::new(&mp).parent().map(Path::to_path_buf))
                            .unwrap_or_default()
                    };

                    if watch_dir != watched_dir || mp != watched_mods || gid != watched_game {
                        if let Some(h) = handle.take() {
                            unsafe {
                                let _ = FindCloseChangeNotification(h);
                            }
                        }
                        watched_dir = watch_dir.clone();
                        watched_mods = mp.clone();
                        watched_game = gid.clone();
                        last_sig = if watched_mods.is_empty() {
                            (0, 0)
                        } else {
                            presets::find_d3dx_user_ini_path(Path::new(&watched_mods))
                                .map(|p| file_mtime_and_size(&p))
                                .unwrap_or((0, 0))
                        };

                        if !watched_dir.as_os_str().is_empty() && watched_dir.is_dir() {
                            let wide: Vec<u16> = watched_dir
                                .as_os_str()
                                .encode_wide()
                                .chain(Some(0))
                                .collect();
                            if let Ok(h) = unsafe {
                                FindFirstChangeNotificationW(
                                    PCWSTR(wide.as_ptr()),
                                    false,
                                    FILE_NOTIFY_CHANGE_LAST_WRITE
                                        | FILE_NOTIFY_CHANGE_SIZE
                                        | FILE_NOTIFY_CHANGE_FILE_NAME,
                                )
                            } {
                                handle = Some(h);
                            }
                        }
                    }
                }

                let Some(h) = handle else {
                    std::thread::sleep(Duration::from_millis(600));
                    continue;
                };

                let wait = unsafe { WaitForSingleObject(h, 450) };
                if wait == WAIT_OBJECT_0 {
                    let _ = unsafe { FindNextChangeNotification(h) };
                    std::thread::sleep(Duration::from_millis(120));
                    while unsafe { WaitForSingleObject(h, 20) } == WAIT_OBJECT_0 {
                        let _ = unsafe { FindNextChangeNotification(h) };
                    }
                    let next_sig = if watched_mods.is_empty() {
                        (0, 0)
                    } else {
                        presets::find_d3dx_user_ini_path(Path::new(&watched_mods))
                            .map(|p| file_mtime_and_size(&p))
                            .unwrap_or((0, 0))
                    };
                    if next_sig != last_sig && (next_sig.0 > 0 || next_sig.1 > 0) {
                        last_sig = next_sig;
                        if now_epoch_ms() >= SUPPRESS_WATCHER_UNTIL_MS.load(Ordering::Relaxed)
                            && !watched_game.is_empty()
                        {
                            emit_state_changed(&app, Some(&watched_game), None);
                        }
                    }
                } else if !watched_dir.as_os_str().is_empty() && !watched_dir.is_dir() {
                    if let Some(h) = handle.take() {
                        unsafe {
                            let _ = FindCloseChangeNotification(h);
                        }
                    }
                    watched_dir.clear();
                }
            }
        })
        .ok();
}

#[cfg(not(windows))]
fn spawn_mods_watcher(_app: AppHandle) {}

struct InnerState {
    base_dir: PathBuf,
    settings: Settings,
    metadata: MetadataStore,
    registered_hotkey: Option<String>,
    last_overlay_toggle: Option<Instant>,
    webview_data_dir: Option<PathBuf>,
    import_sessions: imports::ImportSessionManager,
    pending_queue: presets::PendingQueueState,
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
    let pending_count = app
        .state::<AppState>()
        .0
        .try_lock()
        .ok()
        .map(|g| g.pending_queue.pending_count(game_id))
        .unwrap_or(0);
    let payload = StateChangedEvent {
        game_id: game_id.map(str::to_string),
        character_folder: character_folder.map(str::to_string),
        pending_preset_count: Some(pending_count),
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
    let app_handle = app.clone();
    // Run off the event-handler / sync-command thread so lazy WebView2 init cannot deadlock on Windows.
    tauri::async_runtime::spawn(async move {
        let win = match app_handle.get_webview_window("overlay") {
            Some(win) => Some(win),
            None => {
                let app_bg = app_handle.clone();
                let data_dir_bg = data_dir.clone();
                let base_dir_bg = base_dir.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    match create_window_from_config(&app_bg, "overlay", data_dir_bg.as_deref()) {
                        Ok(win) => Some(win),
                        Err(err) => {
                            append_crash_log(&base_dir_bg, &format!("overlay lazy init failed: {err}"));
                            None
                        }
                    }
                })
                .await
                .unwrap_or(None)
            }
        };
        if let Some(win) = win {
            let visible = win.is_visible().unwrap_or(false);
            let focused = win.is_focused().unwrap_or(false);
            // Hide immediately when pinned on top so toggle works after F10 returns focus to the game.
            if visible && (focused || pinned) {
                let _ = win.hide();
                if let Some(detail) = app_handle.get_webview_window("overlay-detail") {
                    let _ = detail.hide();
                }
            } else {
                let _ = win.show();
                let _ = win.set_always_on_top(pinned);
                let _ = win.set_focus();
            }
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let prefer_en = app
        .state::<AppState>()
        .0
        .try_lock()
        .ok()
        .map(|g| is_non_zh_effective_locale(&g.settings.ui.language))
        .unwrap_or(false);
    let (open_lbl, overlay_lbl, quit_lbl) = if prefer_en {
        ("Open ModDeck", "Toggle Quick Overlay", "Quit ModDeck")
    } else {
        ("打开主界面", "显示/隐藏快捷浮窗", "退出 ModDeck")
    };
    let open_item = MenuItem::with_id(app, "tray-open", open_lbl, true, None::<&str>)?;
    let overlay_item = MenuItem::with_id(app, "tray-overlay", overlay_lbl, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", quit_lbl, true, None::<&str>)?;
    Menu::with_items(app, &[&open_item, &overlay_item, &sep, &quit_item])
}

fn update_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn ensure_tray(app: &AppHandle) {
    if app.tray_by_id("main-tray").is_some() {
        update_tray_menu(app);
        return;
    }
    let Ok(menu) = build_tray_menu(app) else {
        return;
    };
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("ModDeck")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main_window(app),
            "tray-overlay" => do_toggle_overlay(app),
            "tray-quit" => {
                IS_QUITTING.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    if let Err(err) = builder.build(app) {
        let base_dir = app
            .state::<AppState>()
            .0
            .lock()
            .expect("state lock")
            .base_dir
            .clone();
        append_crash_log(&base_dir, &format!("tray init failed: {err}"));
    }
}

fn place_overlay_detail(overlay: &tauri::WebviewWindow, detail: &tauri::WebviewWindow) {
    let Ok(bounds_pos) = overlay.outer_position() else {
        return;
    };
    let Ok(bounds_size) = overlay.outer_size() else {
        return;
    };
    let Ok(Some(monitor)) = overlay.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor().max(1.0);
    let area = monitor.work_area();
    let area_x = area.position.x;
    let area_y = area.position.y;
    let area_w = area.size.width as i32;
    let area_h = area.size.height as i32;

    let default_w = (320.0 * scale).round() as i32;
    let default_h = (460.0 * scale).round() as i32;
    let min_w = (280.0 * scale).round() as i32;
    let min_h = (300.0 * scale).round() as i32;
    let cur_size = detail.outer_size().ok();
    let width = cur_size
        .map(|s| s.width as i32)
        .filter(|&w| w >= min_w)
        .unwrap_or(default_w);
    let margin = (8.0 * scale).round() as i32;
    let gap = (10.0 * scale).round() as i32;
    let pad = (12.0 * scale).round() as i32;
    let max_h = (area_h - (24.0 * scale).round() as i32).max(min_h);
    let height = cur_size
        .map(|s| s.height as i32)
        .filter(|&h| h >= min_h)
        .unwrap_or(default_h)
        .min(max_h);

    let right_space = (area_x + area_w) - (bounds_pos.x + bounds_size.width as i32);
    let left_space = bounds_pos.x - area_x;
    let raw_x = if right_space >= width + pad {
        bounds_pos.x + bounds_size.width as i32 + gap
    } else if left_space >= width + pad {
        bounds_pos.x - width - gap
    } else if right_space >= left_space {
        bounds_pos.x + bounds_size.width as i32 + gap
    } else {
        bounds_pos.x - width - gap
    };
    let min_x = area_x + margin;
    let max_x = (area_x + area_w - width - margin).max(min_x);
    let x = raw_x.clamp(min_x, max_x);

    let min_y = area_y + margin;
    let max_y = (area_y + area_h - height - margin).max(min_y);
    let y = bounds_pos.y.clamp(min_y, max_y);

    let _ = detail.set_size(Size::Physical(PhysicalSize::new(width as u32, height as u32)));
    let _ = detail.set_position(Position::Physical(PhysicalPosition::new(x, y)));
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

fn hotkey_conflict_eq(a: &str, b: &str) -> bool {
    let na = normalize_shortcut_for_tauri(a).to_ascii_lowercase();
    let nb = normalize_shortcut_for_tauri(b).to_ascii_lowercase();
    !na.is_empty() && na == nb
}

fn exe_hints_for_game(settings: &Settings, game_id: &str) -> Vec<String> {
    let mut hints = Vec::new();
    if let Some(game) = get_game(settings, game_id) {
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

fn active_exe_hints(settings: &Settings) -> Vec<String> {
    exe_hints_for_game(settings, &settings.active_game_id)
}

#[derive(Clone, Copy)]
enum AutoReloadKind {
    ModToggle,
    ModPreset,
    RosterPreset,
}

fn schedule_post_reload_preset_sync(app: &AppHandle, game_id: &str) {
    let configured_sec = {
        let state = app.state::<AppState>();
        let guard = state.0.lock().expect("state lock");
        let sec = guard.settings.ui.post_reload_sync_delay;
        if sec.is_finite() && sec > 0.0 {
            sec
        } else {
            6.0
        }
    };
    let delay_ms = configured_sec.clamp(1.0, 30.0) * 1000.0;
    let gen = POST_SYNC_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app_handle = app.clone();
    let gid = game_id.to_string();

    std::thread::Builder::new()
        .name("moddeck-post-sync".to_string())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(delay_ms.round() as u64));
            if POST_SYNC_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            let (pending, active_mods) = {
                let state = app_handle.state::<AppState>();
                let mut guard = state.0.lock().expect("state lock");
                let entries = guard.pending_queue.take_entries_for_game(&gid);
                guard.pending_queue.clear_all(Some(&gid));
                let active_mods = guard
                    .settings
                    .games
                    .get(&gid)
                    .map(|g| g.mods_path.trim().to_string())
                    .unwrap_or_default();
                (entries, active_mods)
            };

            let mut touched_paths: Vec<String> = Vec::new();
            mark_internal_fs_mutation();
            for entry in &pending {
                if !entry.mods_path.trim().is_empty()
                    && !touched_paths.iter().any(|p| p == &entry.mods_path)
                {
                    touched_paths.push(entry.mods_path.clone());
                }
                presets::apply_variables_to_d3dx_user_ini(
                    Path::new(&entry.mods_path),
                    &entry.variables,
                    &entry.character_folder,
                    &entry.clean_mod_name,
                );
            }
            if !active_mods.is_empty() && !touched_paths.iter().any(|p| p == &active_mods) {
                touched_paths.push(active_mods);
            }
            for mp in touched_paths {
                presets::clear_preset_bridge_ini(Path::new(&mp));
            }
            emit_state_changed(&app_handle, Some(&gid), None);
        })
        .ok();
}

fn reload_f10_for_game(app: &AppHandle, target_game_id: Option<&str>) -> SimpleResult {
    let (hints, reload_key, gid, has_pending) = {
        let state = app.state::<AppState>();
        let guard = state.0.lock().expect("state lock");
        let gid = target_game_id
            .map(str::to_string)
            .unwrap_or_else(|| guard.settings.active_game_id.clone());
        let hints = exe_hints_for_game(&guard.settings, &gid);
        let reload_key = if guard.settings.ui.reload_hotkey.trim().is_empty() {
            "F10".to_string()
        } else {
            guard.settings.ui.reload_hotkey.trim().to_string()
        };
        let active_mods = guard
            .settings
            .games
            .get(&gid)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default();
        let has_pending = guard.pending_queue.pending_count(Some(&gid)) > 0
            || (!active_mods.is_empty()
                && presets::has_active_preset_bridge(Path::new(&active_mods)));
        (hints, reload_key, gid, has_pending)
    };

    match input::send_hotkey(&reload_key, &hints) {
        Ok(()) => {
            if has_pending {
                {
                    let state = app.state::<AppState>();
                    let mut guard = state.0.lock().expect("state lock");
                    guard.pending_queue.mark_reloading(&gid);
                    guard.pending_queue.clear_mod_toggles(Some(&gid));
                    guard.pending_queue.clear_roster_schemes(Some(&gid));
                }
                schedule_post_reload_preset_sync(app, &gid);
                emit_state_changed(app, Some(&gid), None);
            }
            SimpleResult {
                ok: true,
                error: None,
            }
        }
        Err(e) => SimpleResult {
            ok: false,
            error: Some(e),
        },
    }
}

fn schedule_auto_reload(app: &AppHandle, kind: AutoReloadKind, game_id: &str) -> bool {
    let should_reload = {
        let state = app.state::<AppState>();
        let guard = state.0.lock().expect("state lock");
        let ui = &guard.settings.ui;
        match kind {
            AutoReloadKind::ModToggle => ui.auto_reload_mod_toggle || ui.auto_reload_f10,
            AutoReloadKind::ModPreset => ui.auto_reload_mod_preset,
            AutoReloadKind::RosterPreset => ui.auto_reload_roster_preset,
        }
    };
    if !should_reload {
        return false;
    }
    let gen = RELOAD_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    let app_handle = app.clone();
    let gid = game_id.to_string();
    std::thread::Builder::new()
        .name("moddeck-auto-reload".to_string())
        .spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            if RELOAD_GEN.load(Ordering::Relaxed) != gen {
                return;
            }
            let _ = reload_f10_for_game(&app_handle, Some(&gid));
        })
        .ok();
    true
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
    update_tray_menu(&app);
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
    mark_internal_fs_mutation();
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
            let auto_reload =
                guard.settings.ui.auto_reload_mod_toggle || guard.settings.ui.auto_reload_f10;
            if !auto_reload {
                guard
                    .pending_queue
                    .record_mod_toggle(&game_id, &character_folder, &mod_folder, enable);
            }
            drop(guard);
            let scheduled = schedule_auto_reload(&app, AutoReloadKind::ModToggle, &game_id);
            let reloaded = Some(scheduled);
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
        "data" | "userData" => guard.base_dir.clone(),
        "logs" => {
            let dir = guard.base_dir.join("logs");
            let _ = fs::create_dir_all(&dir);
            dir
        }
        "languages" | "locales" => {
            let exe_langs = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("languages")));
            let data_langs = guard.base_dir.join("languages");
            if let Some(p) = exe_langs.filter(|p| p.exists()) {
                p
            } else if data_langs.exists() {
                data_langs
            } else {
                let _ = fs::create_dir_all(&data_langs);
                data_langs
            }
        }
        "mods" | "game" | "loader" => {
            let gid = game_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&guard.settings.active_game_id);
            let Some(gs) = guard.settings.games.get(gid) else {
                return SimpleResult {
                    ok: false,
                    error: Some(format!("Unknown game: {gid}")),
                };
            };
            match kind.as_str() {
                "mods" => PathBuf::from(gs.mods_path.trim()),
                "game" => PathBuf::from(gs.game_path.as_deref().unwrap_or("").trim()),
                _ => PathBuf::from(gs.loader_path.as_deref().unwrap_or("").trim()),
            }
        }
        other => {
            return SimpleResult {
                ok: false,
                error: Some(format!("Unknown path kind: {other}")),
            };
        }
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
    #[cfg(windows)]
    let spawned = if target.is_file() {
        use std::os::windows::process::CommandExt;
        let escaped = target.to_string_lossy().replace('"', "");
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{escaped}\""))
            .spawn()
    } else {
        Command::new("explorer.exe").arg(target).spawn()
    };
    #[cfg(not(windows))]
    let spawned = Command::new("explorer.exe").arg(target).spawn();

    match spawned {
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
async fn reload_f10(app: AppHandle) -> SimpleResult {
    tauri::async_runtime::spawn_blocking(move || reload_f10_for_game(&app, None))
        .await
        .unwrap_or_else(|e| SimpleResult {
            ok: false,
            error: Some(e.to_string()),
        })
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
    if hotkey_conflict_eq(&value, &guard.settings.ui.overlay_hotkey) {
        return HotkeyResult {
            ok: false,
            hotkey: None,
            error: Some(format!(
                "Reload hotkey conflicts with overlay hotkey ({})",
                guard.settings.ui.overlay_hotkey
            )),
        };
    }
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
async fn send_mod_hotkey(state: State<'_, AppState>, key: String) -> Result<SimpleResult, String> {
    let (allowed, hints) = {
        let guard = state.0.lock().expect("state lock");
        (
            guard.settings.ui.allow_hotkey_send,
            active_exe_hints(&guard.settings),
        )
    };
    if !allowed {
        return Ok(SimpleResult {
            ok: false,
            error: Some("Hotkey sending is disabled in settings".into()),
        });
    }
    Ok(tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .unwrap_or_else(|e| SimpleResult {
        ok: false,
        error: Some(e.to_string()),
    }))
}

#[tauri::command]
fn launch_game(state: State<'_, AppState>, game_id: String) -> SimpleResult {
    let settings = state.0.lock().expect("state lock").settings.clone();
    launcher::launch_configured(&settings, &game_id, "game")
}

#[tauri::command]
fn launch_loader(state: State<'_, AppState>, game_id: String) -> SimpleResult {
    let settings = state.0.lock().expect("state lock").settings.clone();
    launcher::launch_configured(&settings, &game_id, "loader")
}

#[tauri::command]
async fn toggle_overlay(app: AppHandle) -> SimpleResult {
    do_toggle_overlay(&app);
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
async fn overlay_hide(app: AppHandle) -> SimpleResult {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    if let Some(detail) = app.get_webview_window("overlay-detail") {
        let _ = detail.hide();
    }
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
async fn show_overlay_detail(
    app: AppHandle,
    state: State<'_, AppState>,
    request: OverlayDetailRequest,
) -> Result<ToggleResult, String> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Ok(ToggleResult::err("Overlay window is not available"));
    };
    let (pinned, data_dir) = {
        let guard = state.0.lock().expect("state lock");
        (guard.settings.ui.overlay_pinned, guard.webview_data_dir.clone())
    };
    let query = format!(
        "mode=overlay-detail&gameId={}&character={}&mod={}",
        utf8_percent_encode(&request.game_id, NON_ALPHANUMERIC),
        utf8_percent_encode(&request.character_folder, NON_ALPHANUMERIC),
        utf8_percent_encode(&request.mod_folder, NON_ALPHANUMERIC),
    );

    let detail = match app.get_webview_window("overlay-detail") {
        Some(win) => {
            let navigated = match win.url() {
                Ok(mut url) if url.scheme() != "about" => {
                    url.set_query(Some(&query));
                    win.navigate(url)
                }
                _ => match Url::parse(&format!("http://tauri.localhost/index.html?{query}")) {
                    Ok(fallback) => win.navigate(fallback),
                    Err(e) => return Ok(ToggleResult::err(format!("Invalid detail URL: {e}"))),
                },
            };
            if let Err(err) = navigated {
                return Ok(ToggleResult::err(format!(
                    "Failed to navigate detail window: {err}"
                )));
            }
            win
        }
        None => {
            let app_clone = app.clone();
            let query_clone = query.clone();
            let built = tauri::async_runtime::spawn_blocking(move || {
                let Some(mut cfg) = app_clone
                    .config()
                    .app
                    .windows
                    .iter()
                    .find(|w| w.label == "overlay-detail")
                    .cloned()
                else {
                    return Err("Window config 'overlay-detail' not found".to_string());
                };
                cfg.url = tauri::WebviewUrl::App(PathBuf::from(format!("index.html?{query_clone}")));
                let mut builder = tauri::WebviewWindowBuilder::from_config(&app_clone, &cfg)
                    .map_err(|err| format!("from_config('overlay-detail'): {err}"))?;
                if let Some(dir) = data_dir {
                    builder = builder.data_directory(dir);
                }
                builder
                    .build()
                    .map_err(|err| format!("build('overlay-detail'): {err}"))
            })
            .await
            .map_err(|err| format!("overlay-detail spawn failed: {err}"))?;
            match built {
                Ok(win) => win,
                Err(msg) => return Ok(ToggleResult::err(msg)),
            }
        }
    };

    place_overlay_detail(&overlay, &detail);
    let _ = detail.set_always_on_top(pinned);
    let _ = detail.show();
    let _ = detail.set_focus();
    Ok(ToggleResult::ok())
}

#[tauri::command]
async fn hide_overlay_detail(app: AppHandle) -> SimpleResult {
    if let Some(detail) = app.get_webview_window("overlay-detail") {
        let _ = detail.hide();
    }
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
async fn overlay_open_manager(app: AppHandle) -> SimpleResult {
    show_main_window(&app);
    SimpleResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
async fn set_overlay_pinned(
    app: AppHandle,
    state: State<'_, AppState>,
    pinned: bool,
) -> Result<SimpleResult, String> {
    {
        let mut guard = state.0.lock().expect("state lock");
        guard.settings.ui.overlay_pinned = pinned;
        let _ = save_settings(&guard.base_dir, &guard.settings);
    }
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_always_on_top(pinned);
    }
    if let Some(detail) = app.get_webview_window("overlay-detail") {
        let _ = detail.set_always_on_top(pinned);
    }
    Ok(SimpleResult {
        ok: true,
        error: None,
    })
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
    if !display_value.is_empty()
        && hotkey_conflict_eq(&display_value, &guard.settings.ui.reload_hotkey)
    {
        return HotkeyResult {
            ok: false,
            hotkey: None,
            error: Some(format!(
                "Overlay hotkey conflicts with reload hotkey ({})",
                guard.settings.ui.reload_hotkey
            )),
        };
    }
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
fn get_pending_preset_count(state: State<'_, AppState>, game_id: Option<String>) -> usize {
    let guard = state.0.lock().expect("state lock");
    let target = game_id.as_deref().unwrap_or(&guard.settings.active_game_id);
    guard.pending_queue.pending_count(Some(target))
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

#[tauri::command]
async fn delete_mods(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folders: Vec<String>,
) -> Result<ToggleResult, String> {
    if mod_folders.is_empty() {
        return Ok(ToggleResult::ok());
    }
    let (prev_len, mut settings_copy) = {
        let guard = state.0.lock().expect("state lock");
        (guard.settings.recent_mods.len(), guard.settings.clone())
    };

    mark_internal_fs_mutation();
    let game_clone = game_id.clone();
    let char_clone = character_folder.clone();
    let folders_clone = mod_folders.clone();
    let work = tauri::async_runtime::spawn_blocking(move || {
        let res = storage::delete_mods_to_trash(
            &mut settings_copy,
            &game_clone,
            &char_clone,
            &folders_clone,
        );
        (res, settings_copy)
    })
    .await;

    let (res, next_settings) = match work {
        Ok(pair) => pair,
        Err(err) => return Ok(ToggleResult::err(format!("Delete task panicked: {err}"))),
    };

    match res {
        Ok(()) => {
            mark_internal_fs_mutation();
            let mut guard = state.0.lock().expect("state lock");
            for folder in &mod_folders {
                guard
                    .pending_queue
                    .clear_for_mod(&game_id, &character_folder, folder);
            }
            if next_settings.recent_mods.len() != prev_len {
                guard.settings.recent_mods = next_settings.recent_mods;
                let _ = save_settings(&guard.base_dir, &guard.settings);
            }
            drop(guard);
            emit_state_changed(&app, Some(&game_id), Some(&character_folder));
            Ok(ToggleResult::ok())
        }
        Err(err) => Ok(ToggleResult::err(err)),
    }
}

#[tauri::command]
async fn delete_mod(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> Result<ToggleResult, String> {
    delete_mods(app, state, game_id, character_folder, vec![mod_folder]).await
}

#[tauri::command]
async fn pick_import_files(app: AppHandle) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_title("Select Mod Archives")
            .add_filter("Mod Archives", &["zip", "7z", "rar"]);
        if let Some(win) = app.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| match p {
                FilePath::Path(path) => Some(path.to_string_lossy().to_string()),
                _ => None,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn pick_import_folder(app: AppHandle) -> Option<String> {
    pick_folder_async(app, "Select Mod Folder", None).await
}

#[tauri::command]
async fn pick_import_folders(app: AppHandle) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app.dialog().file().set_title("Select Mod Folders");
        if let Some(win) = app.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder
            .blocking_pick_folders()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| match p {
                FilePath::Path(path) => Some(path.to_string_lossy().to_string()),
                _ => None,
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn stage_dropped_file(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };

    let (file_name, bytes): (String, Vec<u8>) = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => {
            let encoded_name = request
                .headers()
                .get("x-file-name")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("dropped.zip");
            let decoded = percent_encoding::percent_decode_str(encoded_name)
                .decode_utf8_lossy()
                .into_owned();
            (decoded, raw.clone())
        }
        tauri::ipc::InvokeBody::Json(val) => {
            let fname = val
                .get("fileName")
                .and_then(|v| v.as_str())
                .unwrap_or("dropped.zip")
                .to_string();
            let raw_bytes: Vec<u8> = val
                .get("bytes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64().map(|x| x as u8))
                        .collect()
                })
                .unwrap_or_default();
            (fname, raw_bytes)
        }
    };

    let path = tauri::async_runtime::spawn_blocking(move || {
        imports::stage_dropped_file(&base_dir, &file_name, &bytes)
    })
    .await
    .map_err(|e| format!("Drop staging failed: {e}"))??;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_parse(
    state: State<'_, AppState>,
    request: ImportParseRequest,
) -> Result<ImportParseResult, String> {
    let (base_dir, settings, metadata) = {
        let guard = state.0.lock().expect("state lock");
        (
            guard.base_dir.clone(),
            guard.settings.clone(),
            guard.metadata.clone(),
        )
    };
    let (result, session_opt) = tauri::async_runtime::spawn_blocking(move || {
        imports::parse_import_sources_detached(&base_dir, &settings, &metadata, &request)
    })
    .await
    .map_err(|e| format!("Import parse panicked: {e}"))??;

    if let Some((id, session)) = session_opt {
        let mut guard = state.0.lock().expect("state lock");
        guard.import_sessions.insert(id, session);
    }
    Ok(result)
}

#[tauri::command]
async fn import_commit(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportCommitRequest,
) -> Result<ImportResult, String> {
    let (base_dir, settings, session) = {
        let mut guard = state.0.lock().expect("state lock");
        let session = guard
            .import_sessions
            .take(&request.session_id)
            .ok_or_else(|| "Import session expired; please select files again".to_string())?;
        (guard.base_dir.clone(), guard.settings.clone(), session)
    };

    mark_internal_fs_mutation();
    let game_id = request.game_id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        imports::commit_import_session_detached(&base_dir, &settings, session, &request)
    })
    .await
    .map_err(|e| format!("Import commit panicked: {e}"))??;

    mark_internal_fs_mutation();
    emit_state_changed(&app, Some(&game_id), None);
    Ok(res)
}

#[tauri::command]
fn cleanup_staged_drops(state: State<'_, AppState>, paths: Vec<String>) {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    imports::cleanup_staged_drops(&base_dir, &paths);
}

#[tauri::command]
fn import_discard(state: State<'_, AppState>, session_id: String) {
    let mut guard = state.0.lock().expect("state lock");
    guard.import_sessions.discard(&session_id);
}

#[tauri::command]
async fn import_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ImportRequest,
) -> Result<ImportResult, String> {
    let (base_dir, settings, metadata) = {
        let guard = state.0.lock().expect("state lock");
        (
            guard.base_dir.clone(),
            guard.settings.clone(),
            guard.metadata.clone(),
        )
    };

    mark_internal_fs_mutation();
    let game_id = request.game_id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let mut temp_sessions = imports::ImportSessionManager::default();
        imports::run_import(&base_dir, &settings, &metadata, &mut temp_sessions, &request)
    })
    .await
    .map_err(|e| format!("Import failed: {e}"))??;

    mark_internal_fs_mutation();
    emit_state_changed(&app, Some(&game_id), None);
    Ok(res)
}

#[tauri::command]
fn get_storage_overview(state: State<'_, AppState>) -> StorageOverview {
    let guard = state.0.lock().expect("state lock");
    storage::get_storage_overview(&guard.base_dir, &guard.settings)
}

#[tauri::command]
fn restore_mod_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    backup_id: String,
) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    let res = storage::restore_mod_backup(&guard.base_dir, &backup_id, &guard.settings);
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    if res.ok {
        emit_state_changed(&app, Some(&active_id), None);
    }
    res
}

#[tauri::command]
fn delete_mod_backup(state: State<'_, AppState>, backup_id: String) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    storage::delete_mod_backup(&guard.base_dir, &backup_id)
}

#[tauri::command]
fn prune_mod_backups(state: State<'_, AppState>, older_than_days: i64) -> PruneBackupsResult {
    let guard = state.0.lock().expect("state lock");
    storage::prune_mod_backups(&guard.base_dir, older_than_days)
}

#[tauri::command]
async fn export_config_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportPresetResult, String> {
    let date = storage::format_timestamp_dir_utc()
        .split('T')
        .next()
        .unwrap_or("backup")
        .to_string();
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Export ModDeck Config Bundle")
            .set_file_name(format!("ModDeck_Backup_{date}.moddeck-bundle"))
            .add_filter("ModDeck Config Bundle", &["moddeck-bundle", "zip"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_save_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(output_path) = picked else {
        return Ok(ExportPresetResult {
            ok: false,
            error: None,
            file_path: None,
            count: None,
        });
    };

    let (base_dir, settings, version) = {
        let guard = state.0.lock().expect("state lock");
        (
            guard.base_dir.clone(),
            guard.settings.clone(),
            app.package_info().version.to_string(),
        )
    };
    match storage::export_config_bundle(&base_dir, &version, &output_path, &settings) {
        Ok(_) => Ok(ExportPresetResult {
            ok: true,
            error: None,
            file_path: Some(output_path.to_string_lossy().to_string()),
            count: None,
        }),
        Err(err) => Ok(ExportPresetResult {
            ok: false,
            error: Some(err),
            file_path: None,
            count: None,
        }),
    }
}

#[tauri::command]
async fn inspect_config_bundle(app: AppHandle) -> ConfigBundleInspection {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app
            .dialog()
            .file()
            .set_title("Select ModDeck Config Bundle")
            .add_filter("ModDeck Config Bundle", &["moddeck-bundle", "zip"]);
        if let Some(win) = app.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_pick_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .ok()
    .flatten();

    let Some(path) = picked else {
        return ConfigBundleInspection {
            ok: false,
            error: None,
            file_path: None,
            manifest: None,
        };
    };
    storage::inspect_config_bundle(&path)
}

#[tauri::command]
fn import_config_bundle(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    options: ImportConfigBundleOptions,
) -> ImportConfigBundleResult {
    let mut guard = state.0.lock().expect("state lock");
    let base_dir = guard.base_dir.clone();
    let current_settings = guard.settings.clone();
    let (res, next_settings, next_meta) = storage::import_config_bundle(
        &base_dir,
        Path::new(&file_path),
        &current_settings,
        &options,
    );
    if let Some(s) = next_settings {
        guard.settings = s;
    }
    if let Some(m) = next_meta {
        guard.metadata = m;
    }
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    if res.ok {
        emit_state_changed(&app, Some(&active_id), None);
    }
    res
}

#[tauri::command]
fn analyze_mod_ini(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> Result<ModStaticAnalysis, String> {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return Err("Mods directory is not configured".to_string());
    }
    let mod_dir = resolve_mod_target_dir(Path::new(mods_path), &character_folder, &mod_folder)?;
    let rules = guard.settings.ui.variable_ignore_rules.clone();
    drop(guard);
    Ok(ini_analysis::analyze_mod_ini(&mod_dir, &rules))
}

#[tauri::command]
fn scan_character_hash_conflicts(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
) -> Result<Vec<CharacterHashConflict>, String> {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim().to_string())
        .unwrap_or_default();
    drop(guard);
    if mods_path.is_empty() {
        return Ok(Vec::new());
    }
    ini_analysis::scan_character_hash_conflicts(Path::new(&mods_path), &character_folder)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct IgnoreRuleTarget {
    game_id: String,
    character_folder: String,
    mod_folder: String,
}

#[tauri::command]
fn add_variable_ignore_rule(
    app: AppHandle,
    state: State<'_, AppState>,
    rule: String,
    scope: String,
    target: Option<IgnoreRuleTarget>,
) -> ToggleResult {
    let cleaned = rule.trim().to_string();
    if cleaned.is_empty() {
        return ToggleResult::err("Ignore rule cannot be empty");
    }
    if scope == "local" {
        let Some(t) = target else {
            return ToggleResult::err("Missing mod target for local rule");
        };
        let mods_path = {
            let guard = state.0.lock().expect("state lock");
            guard
                .settings
                .games
                .get(&t.game_id)
                .map(|g| g.mods_path.trim().to_string())
                .unwrap_or_default()
        };
        if mods_path.is_empty() {
            return ToggleResult::err("Mods directory is not configured");
        }
        return match resolve_mod_target_dir(Path::new(&mods_path), &t.character_folder, &t.mod_folder)
            .and_then(|dir| ini_analysis::append_local_ignore_rule(&dir, &cleaned))
        {
            Ok(()) => ToggleResult::ok(),
            Err(err) => ToggleResult::err(err),
        };
    }

    let mut guard = state.0.lock().expect("state lock");
    if !guard
        .settings
        .ui
        .variable_ignore_rules
        .iter()
        .any(|r| r.eq_ignore_ascii_case(&cleaned))
    {
        guard.settings.ui.variable_ignore_rules.push(cleaned);
        if let Err(err) = save_settings(&guard.base_dir, &guard.settings) {
            return ToggleResult::err(err);
        }
    }
    let active_id = guard.settings.active_game_id.clone();
    drop(guard);
    emit_state_changed(&app, Some(&active_id), None);
    ToggleResult::ok()
}

#[tauri::command]
fn audit_game_conflicts(state: State<'_, AppState>, game_id: String) -> GameConflictAuditReport {
    let settings = {
        let guard = state.0.lock().expect("state lock");
        guard.settings.clone()
    };
    let is_en = is_non_zh_effective_locale(&settings.ui.language);
    let mods_path = settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.clone())
        .unwrap_or_default();
    let env = detect::check_environment_for_settings(&settings, Some(&game_id), is_en)
        .into_iter()
        .next();
    ini_analysis::audit_game_mods_conflicts(&game_id, &mods_path, env, is_en)
}

#[tauri::command]
async fn export_conflict_audit_report(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    report: GameConflictAuditReport,
) -> Result<ExportPresetResult, String> {
    let (game_name, is_en) = {
        let guard = state.0.lock().expect("state lock");
        let name = get_game(&guard.settings, &game_id)
            .map(|g| g.name)
            .unwrap_or_else(|| game_id.clone());
        let en = is_non_zh_effective_locale(&guard.settings.ui.language);
        (name, en)
    };
    let date = storage::format_timestamp_dir_utc()
        .split('T')
        .next()
        .unwrap_or("report")
        .to_string();
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Export ModDeck Conflict Audit Report")
            .set_file_name(format!("ModDeck_Conflict_Report_{game_id}_{date}.txt"))
            .add_filter("Text Report", &["txt"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_save_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(save_path) = picked else {
        return Ok(ExportPresetResult {
            ok: false,
            error: None,
            file_path: None,
            count: None,
        });
    };
    let text = ini_analysis::format_conflict_audit_report_text(&game_name, &report, is_en);
    match fs::write(&save_path, text) {
        Ok(()) => Ok(ExportPresetResult {
            ok: true,
            error: None,
            file_path: Some(save_path.to_string_lossy().to_string()),
            count: None,
        }),
        Err(err) => Ok(ExportPresetResult {
            ok: false,
            error: Some(err.to_string()),
            file_path: None,
            count: None,
        }),
    }
}

#[tauri::command]
fn get_d3dx_auto_save_interval(state: State<'_, AppState>, game_id: String) -> i64 {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return 60;
    }
    presets::get_d3dx_auto_save_interval(Path::new(mods_path))
}

#[tauri::command]
fn set_d3dx_auto_save_interval(
    state: State<'_, AppState>,
    game_id: String,
    interval: i64,
) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim().to_string())
        .unwrap_or_default();
    drop(guard);
    if mods_path.is_empty() {
        return ToggleResult::err("Mods directory is not configured");
    }
    presets::set_d3dx_auto_save_interval(Path::new(&mods_path), interval)
}

#[tauri::command]
fn get_d3dx_sync_status(state: State<'_, AppState>, game_id: String) -> D3dxSyncStatus {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim().to_string())
        .unwrap_or_default();
    let pending_count = guard.pending_queue.pending_count(Some(&game_id));
    let game_running = launcher::is_game_process_running(&guard.settings, Some(&game_id));
    drop(guard);
    presets::get_d3dx_sync_status(Path::new(&mods_path), pending_count, game_running)
}

#[tauri::command]
fn get_mod_presets(
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> Vec<ModVariantPreset> {
    let guard = state.0.lock().expect("state lock");
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return presets::get_mod_presets(
            &guard.base_dir,
            &game_id,
            &character_folder,
            &mod_folder,
            None,
            None,
            &guard.settings.ui.variable_ignore_rules,
            &guard.pending_queue,
        );
    }
    let mp = Path::new(mods_path);
    let mod_dir = resolve_mod_target_dir(mp, &character_folder, &mod_folder).ok();
    presets::get_mod_presets(
        &guard.base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        mod_dir.as_deref(),
        Some(mp),
        &guard.settings.ui.variable_ignore_rules,
        &guard.pending_queue,
    )
}

fn wait_for_d3dx_user_ini_update(
    mods_path: &Path,
    prev_mtime_ms: u64,
    prev_size: u64,
    timeout_ms: u64,
) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if let Some(ini_path) = presets::find_d3dx_user_ini_path(mods_path) {
            let (mtime_ms, size) = file_mtime_and_size(&ini_path);
            let changed = (prev_mtime_ms == 0 && size > 0)
                || mtime_ms > prev_mtime_ms.saturating_add(10)
                || size != prev_size;
            if changed {
                std::thread::sleep(Duration::from_millis(180));
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

#[tauri::command]
async fn save_mod_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    preset_name: String,
    options: Option<SaveModPresetOptions>,
) -> Result<SaveModPresetResult, String> {
    let (
        base_dir,
        mods_path,
        mod_dir,
        rules,
        settings_snap,
        should_sync_f10,
        pending_count,
        configured_sec,
    ) = {
        let guard = state.0.lock().expect("state lock");
        let base_dir = guard.base_dir.clone();
        let mods_path = guard
            .settings
            .games
            .get(&game_id)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default();
        if mods_path.is_empty() {
            return Ok(SaveModPresetResult {
                ok: false,
                reloaded: None,
                error: Some("Mods directory is not configured".to_string()),
                synced_f10: Some(false),
                possible_stale: None,
                stale_reason: None,
            });
        }
        let Ok(mod_dir) =
            resolve_mod_target_dir(Path::new(&mods_path), &character_folder, &mod_folder)
        else {
            return Ok(SaveModPresetResult {
                ok: false,
                reloaded: None,
                error: Some("Invalid mod directory".to_string()),
                synced_f10: Some(false),
                possible_stale: None,
                stale_reason: None,
            });
        };
        let rules = guard.settings.ui.variable_ignore_rules.clone();
        let settings_snap = guard.settings.clone();
        let should_sync_f10 = options
            .and_then(|o| o.sync_f10)
            .unwrap_or(guard.settings.ui.auto_sync_before_save_preset);
        let pending_count = guard.pending_queue.pending_count(Some(&game_id));
        let configured_sec = if guard.settings.ui.post_reload_sync_delay.is_finite()
            && guard.settings.ui.post_reload_sync_delay > 0.0
        {
            guard.settings.ui.post_reload_sync_delay
        } else {
            6.0
        };
        (
            base_dir,
            mods_path,
            mod_dir,
            rules,
            settings_snap,
            should_sync_f10,
            pending_count,
            configured_sec,
        )
    };

    let mut synced_f10 = false;
    let mut d3dx_updated_after_f10 = false;

    if should_sync_f10 {
        if pending_count > 0 || presets::has_active_preset_bridge(Path::new(&mods_path)) {
            return Ok(SaveModPresetResult {
                ok: false,
                reloaded: None,
                error: Some(
                    "Pending preset or reload sync is still in progress; wait a moment and try again."
                        .to_string(),
                ),
                synced_f10: Some(false),
                possible_stale: None,
                stale_reason: Some("pending-queue".to_string()),
            });
        }
        if launcher::is_game_process_running(&settings_snap, Some(&game_id)) {
            let (prev_mtime, prev_size) = presets::find_d3dx_user_ini_path(Path::new(&mods_path))
                .map(|p| file_mtime_and_size(&p))
                .unwrap_or((0, 0));
            let app_clone = app.clone();
            let gid_clone = game_id.clone();
            let mp_clone = mods_path.clone();
            let (did_sync, did_update) = tauri::async_runtime::spawn_blocking(move || {
                let reload_res = reload_f10_for_game(&app_clone, Some(&gid_clone));
                if !reload_res.ok {
                    return (false, false);
                }
                let wait_ms = (configured_sec.clamp(3.0, 8.0) * 1000.0).round() as u64;
                let updated = wait_for_d3dx_user_ini_update(
                    Path::new(&mp_clone),
                    prev_mtime,
                    prev_size,
                    wait_ms,
                );
                (true, updated)
            })
            .await
            .unwrap_or((false, false));
            synced_f10 = did_sync;
            d3dx_updated_after_f10 = did_update;
        }
    }

    let mut res = {
        let mut guard = state.0.lock().expect("state lock");
        presets::save_mod_preset(
            &base_dir,
            &game_id,
            &character_folder,
            &mod_folder,
            &mod_dir,
            Path::new(&mods_path),
            &preset_name,
            &rules,
            &mut guard.pending_queue,
        )
    };
    res.synced_f10 = Some(synced_f10);

    if !res.ok && res.stale_reason.as_deref() == Some("unsynced-game-running") {
        if synced_f10 && !d3dx_updated_after_f10 {
            res.possible_stale = Some(true);
            res.stale_reason = Some("f10-timeout".to_string());
        } else if !synced_f10 {
            let running = launcher::is_game_process_running(&settings_snap, Some(&game_id));
            let user_mtime = presets::find_d3dx_user_ini_path(Path::new(&mods_path))
                .map(|p| file_mtime_and_size(&p).0)
                .unwrap_or(0);
            if running && (user_mtime == 0 || now_epoch_ms().saturating_sub(user_mtime) > 10_000)
            {
                res.possible_stale = Some(true);
                res.stale_reason = Some("unsynced-game-running".to_string());
            } else {
                res.possible_stale = None;
                res.stale_reason = None;
            }
        } else {
            res.possible_stale = None;
            res.stale_reason = None;
        }
    }

    if res.ok {
        emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    }
    Ok(res)
}

#[tauri::command]
fn apply_mod_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    preset_id: String,
) -> ToggleResult {
    let mut guard = state.0.lock().expect("state lock");
    let base_dir = guard.base_dir.clone();
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim().to_string())
        .unwrap_or_default();
    if mods_path.is_empty() {
        return ToggleResult::err("Mods directory is not configured");
    }
    let Ok(mod_dir) = resolve_mod_target_dir(Path::new(&mods_path), &character_folder, &mod_folder)
    else {
        return ToggleResult::err("Invalid mod directory");
    };
    let rules = guard.settings.ui.variable_ignore_rules.clone();

    let res = presets::apply_mod_preset(
        &base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        &mod_dir,
        Path::new(&mods_path),
        &preset_id,
        false,
        &rules,
        &mut guard.pending_queue,
    );
    drop(guard);

    if res.ok {
        let _ = schedule_auto_reload(&app, AutoReloadKind::ModPreset, &game_id);
        emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    }
    res
}

#[tauri::command]
fn delete_mod_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    preset_id: String,
) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    let res = presets::delete_mod_preset(
        &guard.base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        &preset_id,
    );
    drop(guard);
    if res.ok {
        emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    }
    res
}

#[tauri::command]
async fn export_mod_presets(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    preset_id: Option<String>,
) -> Result<ExportPresetResult, String> {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    let (data, default_name) = match presets::build_mod_preset_export_data(
        &base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        preset_id.as_deref(),
    ) {
        Ok(pair) => pair,
        Err(err) => {
            return Ok(ExportPresetResult {
                ok: false,
                error: Some(err),
                file_path: None,
                count: None,
            });
        }
    };
    let count = data.presets.len();
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Export Mod Presets")
            .set_file_name(default_name)
            .add_filter("ModDeck Preset", &["json"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_save_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(save_path) = picked else {
        return Ok(ExportPresetResult {
            ok: false,
            error: None,
            file_path: None,
            count: None,
        });
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    match fs::write(&save_path, json) {
        Ok(()) => Ok(ExportPresetResult {
            ok: true,
            error: None,
            file_path: Some(save_path.to_string_lossy().to_string()),
            count: Some(count),
        }),
        Err(err) => Ok(ExportPresetResult {
            ok: false,
            error: Some(err.to_string()),
            file_path: None,
            count: None,
        }),
    }
}

#[tauri::command]
async fn import_mod_presets(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
) -> Result<ImportPresetsResult, String> {
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Import Mod Presets")
            .add_filter("ModDeck Preset", &["json"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_pick_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(src_path) = picked else {
        return Ok(ImportPresetsResult {
            ok: false,
            error: None,
            count: None,
            names: None,
        });
    };
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    let res = presets::import_mod_presets_from_file(
        &base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        &src_path,
    );
    if res.ok {
        emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    }
    Ok(res)
}

#[tauri::command]
fn import_mod_presets_from_path(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    character_folder: String,
    mod_folder: String,
    file_path: String,
) -> ImportPresetsResult {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    let res = presets::import_mod_presets_from_file(
        &base_dir,
        &game_id,
        &character_folder,
        &mod_folder,
        Path::new(&file_path),
    );
    if res.ok {
        emit_state_changed(&app, Some(&game_id), Some(&character_folder));
    }
    res
}

#[tauri::command]
fn get_roster_presets(state: State<'_, AppState>, game_id: String) -> Vec<RosterPreset> {
    let guard = state.0.lock().expect("state lock");
    presets::get_roster_presets(&guard.base_dir, &game_id)
}

#[tauri::command]
fn save_roster_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    input: SaveRosterPresetInput,
) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    let res = presets::save_roster_preset(&guard.base_dir, &game_id, &input);
    drop(guard);
    if res.ok {
        emit_state_changed(&app, Some(&game_id), None);
    }
    res
}

#[tauri::command]
fn apply_roster_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    preset_id: String,
) -> ToggleResult {
    let mut guard = state.0.lock().expect("state lock");
    let base_dir = guard.base_dir.clone();
    let mods_path = guard
        .settings
        .games
        .get(&game_id)
        .map(|g| g.mods_path.trim().to_string())
        .unwrap_or_default();
    if mods_path.is_empty() {
        return ToggleResult::err("Mods directory is not configured");
    }
    let rules = guard.settings.ui.variable_ignore_rules.clone();
    let auto_reload = guard.settings.ui.auto_reload_roster_preset;
    let res = presets::apply_roster_preset(
        &base_dir,
        &game_id,
        Path::new(&mods_path),
        &preset_id,
        &rules,
        &mut guard.pending_queue,
    );
    if res.ok && !auto_reload {
        guard.pending_queue.record_roster_scheme(&game_id);
    }
    drop(guard);

    if res.ok {
        let _ = schedule_auto_reload(&app, AutoReloadKind::RosterPreset, &game_id);
        emit_state_changed(&app, Some(&game_id), None);
    }
    res
}

#[tauri::command]
fn delete_roster_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    preset_id: String,
) -> ToggleResult {
    let guard = state.0.lock().expect("state lock");
    let res = presets::delete_roster_preset(&guard.base_dir, &game_id, &preset_id);
    drop(guard);
    if res.ok {
        emit_state_changed(&app, Some(&game_id), None);
    }
    res
}

#[tauri::command]
async fn export_roster_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    preset_id: String,
) -> Result<ExportPresetResult, String> {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    let (data, default_name) = match presets::build_roster_preset_export_data(
        &base_dir,
        &game_id,
        &preset_id,
    ) {
        Ok(pair) => pair,
        Err(err) => {
            return Ok(ExportPresetResult {
                ok: false,
                error: Some(err),
                file_path: None,
                count: None,
            });
        }
    };
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Export Roster Scheme")
            .set_file_name(default_name)
            .add_filter("ModDeck Roster Scheme", &["json"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_save_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(save_path) = picked else {
        return Ok(ExportPresetResult {
            ok: false,
            error: None,
            file_path: None,
            count: None,
        });
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    match fs::write(&save_path, json) {
        Ok(()) => Ok(ExportPresetResult {
            ok: true,
            error: None,
            file_path: Some(save_path.to_string_lossy().to_string()),
            count: None,
        }),
        Err(err) => Ok(ExportPresetResult {
            ok: false,
            error: Some(err.to_string()),
            file_path: None,
            count: None,
        }),
    }
}

#[tauri::command]
async fn inspect_roster_preset_file(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
) -> Result<RosterSchemeImportInspection, String> {
    let app_clone = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut builder = app_clone
            .dialog()
            .file()
            .set_title("Import Roster Scheme")
            .add_filter("ModDeck Roster Scheme", &["json"]);
        if let Some(win) = app_clone.get_webview_window("main") {
            builder = builder.set_parent(&win);
        }
        builder.blocking_pick_file().and_then(|fp| match fp {
            FilePath::Path(p) => Some(p),
            _ => None,
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(src_path) = picked else {
        return Ok(RosterSchemeImportInspection {
            ok: false,
            error: None,
            scheme_name: None,
            source_game_id: None,
            target_game_id: None,
            total_characters: 0,
            matched_characters: 0,
            total_mods: 0,
            matched_mods: 0,
            missing_characters: Vec::new(),
            missing_mods: Vec::new(),
            matched_items: Vec::new(),
            raw_export: None,
        });
    };
    let mods_path = {
        let guard = state.0.lock().expect("state lock");
        guard
            .settings
            .games
            .get(&game_id)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default()
    };
    Ok(presets::inspect_roster_preset_file_content(
        &game_id,
        Path::new(&mods_path),
        &src_path,
    ))
}

#[tauri::command]
fn inspect_roster_preset_file_from_path(
    state: State<'_, AppState>,
    game_id: String,
    file_path: String,
) -> RosterSchemeImportInspection {
    let mods_path = {
        let guard = state.0.lock().expect("state lock");
        guard
            .settings
            .games
            .get(&game_id)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default()
    };
    presets::inspect_roster_preset_file_content(
        &game_id,
        Path::new(&mods_path),
        Path::new(&file_path),
    )
}

#[tauri::command]
fn confirm_import_roster_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    raw_export: Value,
    custom_name: Option<String>,
) -> ImportRosterResult {
    let base_dir = {
        let guard = state.0.lock().expect("state lock");
        guard.base_dir.clone()
    };
    let res = presets::confirm_import_roster_preset(
        &base_dir,
        &game_id,
        &raw_export,
        custom_name.as_deref(),
    );
    if res.ok {
        emit_state_changed(&app, Some(&game_id), None);
    }
    res
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

#[cfg(windows)]
fn has_webview2_runtime() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const SUBKEYS: &[&str] = &[
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ];
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let hive = RegKey::predef(root);
        for subkey in SUBKEYS {
            if let Ok(key) = hive.open_subkey(subkey) {
                if let Ok(pv) = key.get_value::<String, _>("pv") {
                    let trimmed = pv.trim();
                    if !trimmed.is_empty() && trimmed != "0.0.0.0" {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn prompt_missing_webview2(base_dir: &Path, prefer_en: bool) {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONERROR, MB_YESNO, SW_SHOWNORMAL,
    };

    append_crash_log(base_dir, "WebView2 Runtime not detected in Windows Registry");
    let (title_s, body_s) = if prefer_en {
        (
            "ModDeck - WebView2 Runtime Missing",
            "Microsoft Edge WebView2 Runtime was not detected on this Windows system, so ModDeck cannot open its interface.\n\nClick Yes to open Microsoft's official WebView2 download page (install the Evergreen Bootstrapper and relaunch ModDeck).",
        )
    } else {
        (
            "ModDeck - 缺少 WebView2 运行库",
            "未检测到系统 Microsoft Edge WebView2 运行库，ModDeck 无法创建界面窗口（常见于精简版 Windows 系统）。\n\n是否立即打开微软官方下载页面（下载并安装 Evergreen Bootstrapper 后重新启动 ModDeck）？",
        )
    };
    let title = HSTRING::from(title_s);
    let body = HSTRING::from(body_s);
    let choice = unsafe { MessageBoxW(None, &body, &title, MB_YESNO | MB_ICONERROR) };
    if choice == IDYES {
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let url: Vec<u16> = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section\0"
            .encode_utf16()
            .collect();
        unsafe {
            let _ = ShellExecuteW(
                HWND::default(),
                PCWSTR(op.as_ptr()),
                PCWSTR(url.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
        }
    }
}

#[cfg(not(windows))]
fn has_webview2_runtime() -> bool {
    true
}

#[cfg(not(windows))]
fn prompt_missing_webview2(_base_dir: &Path, _prefer_en: bool) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let base_dir = resolve_base_dir();
    install_panic_hook(base_dir.clone());
    if !input::acquire_single_instance_or_focus() {
        return;
    }
    let settings = normalize_settings(load_settings(&base_dir));
    if !has_webview2_runtime() {
        let prefer_en = is_non_zh_effective_locale(&settings.ui.language);
        prompt_missing_webview2(&base_dir, prefer_en);
        return;
    }
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
            import_sessions: imports::ImportSessionManager::default(),
            pending_queue: presets::PendingQueueState::default(),
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
                        if !IS_QUITTING.load(Ordering::Relaxed) {
                            let minimize_to_tray = window
                                .app_handle()
                                .state::<AppState>()
                                .0
                                .try_lock()
                                .ok()
                                .map(|g| g.settings.ui.close_behavior == "minimize")
                                .unwrap_or(false);
                            if minimize_to_tray {
                                api.prevent_close();
                                let _ = window.hide();
                                ensure_tray(window.app_handle());
                                return;
                            }
                        }
                        IS_QUITTING.store(true, Ordering::Relaxed);
                        window.app_handle().exit(0);
                    }
                    "overlay" => {
                        api.prevent_close();
                        let _ = window.hide();
                        if let Some(detail) = window.app_handle().get_webview_window("overlay-detail")
                        {
                            let _ = detail.hide();
                        }
                    }
                    "overlay-detail" => {
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

            if let Err(detail_err) = create_window_from_config(
                app.handle(),
                "overlay-detail",
                active_data_dir.as_deref(),
            ) {
                append_crash_log(
                    &setup_base_dir,
                    &format!("overlay-detail window startup init failed (non-fatal): {detail_err}"),
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
            imports::cleanup_stale_tmp_dirs(&setup_base_dir);
            spawn_mods_watcher(app.handle().clone());
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
            delete_mod,
            delete_mods,
            get_mod_details_cmd,
            open_character_folder,
            open_mod_folder,
            open_path,
            reload_f10,
            set_reload_hotkey,
            send_mod_hotkey,
            launch_game,
            launch_loader,
            toggle_overlay,
            overlay_hide,
            show_overlay_detail,
            hide_overlay_detail,
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
            pick_import_files,
            pick_import_folder,
            pick_import_folders,
            stage_dropped_file,
            cleanup_staged_drops,
            import_parse,
            import_commit,
            import_discard,
            import_run,
            get_storage_overview,
            restore_mod_backup,
            delete_mod_backup,
            prune_mod_backups,
            export_config_bundle,
            inspect_config_bundle,
            import_config_bundle,
            analyze_mod_ini,
            scan_character_hash_conflicts,
            add_variable_ignore_rule,
            audit_game_conflicts,
            export_conflict_audit_report,
            get_d3dx_auto_save_interval,
            set_d3dx_auto_save_interval,
            get_d3dx_sync_status,
            get_mod_presets,
            save_mod_preset,
            apply_mod_preset,
            delete_mod_preset,
            export_mod_presets,
            import_mod_presets,
            import_mod_presets_from_path,
            get_roster_presets,
            save_roster_preset,
            apply_roster_preset,
            delete_roster_preset,
            export_roster_preset,
            inspect_roster_preset_file,
            inspect_roster_preset_file_from_path,
            confirm_import_roster_preset,
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

#[cfg(test)]
mod tests {
    use super::{hotkey_conflict_eq, normalize_shortcut_for_tauri};
    use crate::models::UiSettings;

    #[test]
    fn default_overlay_hotkey_normalizes_to_alt_backslash() {
        let ui = UiSettings::default();
        assert_eq!(ui.overlay_hotkey, "Alt+\\");
        assert_eq!(
            normalize_shortcut_for_tauri(&ui.overlay_hotkey),
            "alt+Backslash"
        );
        assert!(hotkey_conflict_eq(&ui.overlay_hotkey, "Alt+Backslash"));
    }
}
