use crate::games::get_all_games;
use crate::models::{
    AutoDetectPathsResult, ClearShaderCacheResult, EnvironmentCheck, EnvironmentShaderCacheInfo,
    EnvironmentShaderFixesInfo, GameDef, GameSettings, Settings,
};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct RegistryAppEntry {
    pub display_name: String,
    pub install_location: String,
    pub display_icon: String,
    pub uninstall_string: String,
}

fn clean_registry_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Strip surrounding quotes and trailing ",0" icon indices.
    let without_quotes = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        trimmed.split(',').next().unwrap_or("")
    };
    let candidate = without_quotes.trim();
    if candidate.is_empty() {
        None
    } else {
        Some(PathBuf::from(candidate))
    }
}

fn normalize_display_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    let normalized = trimmed.replace('/', "\\");
    #[cfg(not(windows))]
    let normalized = trimmed.to_string();

    if normalized.len() > 3 && normalized.ends_with('\\') {
        normalized.trim_end_matches('\\').to_string()
    } else {
        normalized
    }
}

fn is_resources_bin_dir(path: &Path) -> bool {
    let is_bin = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("bin"))
        .unwrap_or(false);
    let is_resources = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("resources"))
        .unwrap_or(false);
    is_bin && is_resources
}

/// Checks if a path points to or sits inside an XXMI Launcher installation root.
pub fn infer_xxmi_root_from_path(raw_path: &str) -> Option<String> {
    let trimmed = normalize_display_path(raw_path);
    if trimmed.is_empty() {
        return None;
    }
    let start = PathBuf::from(&trimmed);
    let base = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start
    };

    // Pass 1: walk ancestors preferring the true XXMI root markers.
    let mut cursor = base.clone();
    for _ in 0..8 {
        let has_config = cursor.join("XXMI Launcher Config.json").is_file();
        let has_bin_exe = cursor
            .join("Resources")
            .join("Bin")
            .join("XXMI Launcher.exe")
            .is_file();
        if has_config || has_bin_exe {
            return Some(normalize_display_path(&cursor.to_string_lossy()));
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        if parent == cursor {
            break;
        }
        cursor = parent.to_path_buf();
    }

    // Pass 2: fall back to direct XXMI Launcher.exe only when not inside Resources\Bin.
    let mut cursor = base;
    for _ in 0..8 {
        if !is_resources_bin_dir(&cursor) && cursor.join("XXMI Launcher.exe").is_file() {
            return Some(normalize_display_path(&cursor.to_string_lossy()));
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        if parent == cursor {
            break;
        }
        cursor = parent.to_path_buf();
    }
    None
}

pub fn effective_xxmi_root(settings: &Settings, game_id: Option<&str>) -> Option<String> {
    if let Some(root) = settings.xxmi_root.as_deref() {
        let trimmed = root.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
            return infer_xxmi_root_from_path(trimmed).or_else(|| Some(trimmed.to_string()));
        }
    }
    if let Some(gid) = game_id {
        if let Some(gs) = settings.games.get(gid) {
            if let Some(lp) = gs.loader_path.as_deref().and_then(infer_xxmi_root_from_path) {
                return Some(lp);
            }
            if let Some(mp) = infer_xxmi_root_from_path(&gs.mods_path) {
                return Some(mp);
            }
        }
    }
    for gs in settings.games.values() {
        if let Some(lp) = gs.loader_path.as_deref().and_then(infer_xxmi_root_from_path) {
            return Some(lp);
        }
        if let Some(mp) = infer_xxmi_root_from_path(&gs.mods_path) {
            return Some(mp);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn query_registry_apps() -> Vec<RegistryAppEntry> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const WOW_SUBKEY: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    const KEYWORDS: [&str; 18] = [
        "xxmi",
        "hypergryph",
        "gryphlink",
        "鹰角",
        "终末地",
        "endfield",
        "mihoyo",
        "hoyoplay",
        "米哈游",
        "绝区零",
        "星穹",
        "star rail",
        "wuthering",
        "鸣潮",
        "库洛",
        "kuro",
        "neverness",
        "异环",
    ];

    let roots: Vec<(winreg::HKEY, &str)> = vec![
        (HKEY_CURRENT_USER, SUBKEY),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, WOW_SUBKEY),
    ];

    let mut results = Vec::new();
    for (hive, path) in roots {
        let hkey = RegKey::predef(hive);
        let Ok(uninstall) = hkey.open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for name in uninstall.enum_keys().flatten() {
            let Ok(item) = uninstall.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display_name: String = item.get_value("DisplayName").unwrap_or_default();
            let lower = display_name.to_lowercase();
            if display_name.is_empty()
                || (!KEYWORDS.iter().any(|kw| lower.contains(kw)) && !lower.contains("nte"))
            {
                continue;
            }
            let install_location: String = item.get_value("InstallLocation").unwrap_or_default();
            let display_icon: String = item.get_value("DisplayIcon").unwrap_or_default();
            let uninstall_string: String = item.get_value("UninstallString").unwrap_or_default();
            results.push(RegistryAppEntry {
                display_name,
                install_location,
                display_icon,
                uninstall_string,
            });
        }
    }
    results
}

#[cfg(not(target_os = "windows"))]
pub fn query_registry_apps() -> Vec<RegistryAppEntry> {
    Vec::new()
}

fn find_xxmi_launcher_exe(xxmi_root: &Path) -> Option<PathBuf> {
    let bin_exe = xxmi_root
        .join("Resources")
        .join("Bin")
        .join("XXMI Launcher.exe");
    if bin_exe.is_file() {
        return Some(bin_exe);
    }
    let root_exe = xxmi_root.join("XXMI Launcher.exe");
    if root_exe.is_file() {
        return Some(root_exe);
    }
    None
}

fn importer_code_for_game(game: &GameDef) -> Option<String> {
    match game.id.as_str() {
        "wuthering-waves" => Some("WWMI".to_string()),
        "honkai-star-rail" => Some("SRMI".to_string()),
        "zzz" => Some("ZZMI".to_string()),
        "endfield" => Some("EFMI".to_string()),
        "neverness-to-everness" => Some("NTEMI".to_string()),
        _ => {
            let code = game
                .loader
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim();
            if code.is_empty() {
                None
            } else {
                Some(code.to_string())
            }
        }
    }
}

fn exe_candidates_for_game(game: &GameDef) -> Vec<String> {
    let mut out = Vec::new();
    match game.id.as_str() {
        "wuthering-waves" => {
            out.push("Client-Win64-Shipping.exe".to_string());
            out.push("Wuthering Waves.exe".to_string());
        }
        "honkai-star-rail" => out.push("StarRail.exe".to_string()),
        "zzz" => out.push("ZenlessZoneZero.exe".to_string()),
        "endfield" => out.push("Endfield.exe".to_string()),
        _ => {}
    }
    if let Some(hint) = &game.exe_hint {
        let cleaned = hint.trim();
        if !cleaned.is_empty() && cleaned.to_lowercase().ends_with(".exe") {
            let file_name = Path::new(cleaned)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(cleaned)
                .to_string();
            if !out.contains(&file_name) {
                out.push(file_name);
            }
        }
    }
    out
}

fn launcher_exe_candidates() -> Vec<String> {
    [
        "Launcher.exe",
        "launcher.exe",
        "NTELauncher.exe",
        "GRYPHLINK.exe",
        "Gryphlink.exe",
        "HYP.exe",
        "KRLauncher.exe",
    ]
    .into_iter()
    .map(|s| s.to_string())
    .collect()
}

fn find_exe_in_dir(dir: &Path, exe_names: &[String]) -> Option<PathBuf> {
    find_exe_in_dir_depth(dir, exe_names, 2)
}

fn find_exe_in_dir_depth(dir: &Path, exe_names: &[String], depth: usize) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    for name in exe_names {
        if name.is_empty() {
            continue;
        }
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
    }
    if depth == 0 {
        return None;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_lowercase();
        if matches!(
            dir_name.as_str(),
            "_commonredist" | "directx" | "logs" | "cache" | "crashpad" | "temp" | "webcache" | "mods"
        ) {
            continue;
        }
        subdirs.push(path);
    }
    subdirs.sort();
    for subdir in subdirs {
        if let Some(found) = find_exe_in_dir_depth(&subdir, exe_names, depth - 1) {
            return Some(found);
        }
    }
    None
}

#[derive(Debug, Default)]
struct XxmiImporterHint {
    mods_path: Option<PathBuf>,
    game_folder: Option<PathBuf>,
    start_exe_path: Option<PathBuf>,
    launcher_folder: Option<PathBuf>,
    game_exe_names: Vec<String>,
    launcher_folder_files: Vec<String>,
}

fn read_str_field(obj: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(|v| v.as_str())
        .map(normalize_display_path)
        .filter(|s| !s.is_empty())
}

fn read_str_array(obj: &serde_json::Map<String, Value>, key: &str, out: &mut Vec<String>) {
    if let Some(arr) = obj.get(key).and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if !out.iter().any(|x| x.eq_ignore_ascii_case(s)) {
                    out.push(s.to_string());
                }
            }
        }
    }
}

fn apply_importer_section(
    xxmi_root: &Path,
    obj: &serde_json::Map<String, Value>,
    hint: &mut XxmiImporterHint,
) {
    if hint.mods_path.is_none() {
        if let Some(folder_str) = read_str_field(obj, "importer_folder") {
            let p = PathBuf::from(&folder_str);
            let resolved = if p.is_absolute() {
                p
            } else {
                let direct = xxmi_root.join(&p);
                if direct.is_dir() {
                    direct
                } else {
                    xxmi_root.join("XXMI").join(&p)
                }
            };
            let mods = resolved.join("Mods");
            if mods.is_dir() {
                hint.mods_path = Some(PathBuf::from(normalize_display_path(&mods.to_string_lossy())));
            }
        }
    }
    if hint.start_exe_path.is_none() {
        if let Some(start_exe) = read_str_field(obj, "start_exe_path") {
            let p = PathBuf::from(start_exe);
            if p.is_file() {
                hint.start_exe_path = Some(p);
            }
        }
    }
    if hint.game_folder.is_none() {
        if let Some(game_folder) = read_str_field(obj, "game_folder") {
            let gf = PathBuf::from(game_folder);
            if gf.is_dir() {
                hint.game_folder = Some(gf);
            }
        }
    }
    if hint.launcher_folder.is_none() {
        if let Some(launcher_folder) = read_str_field(obj, "launcher_folder") {
            let lf = PathBuf::from(launcher_folder);
            if lf.is_dir() {
                hint.launcher_folder = Some(lf);
            }
        }
    }
    read_str_array(obj, "game_exe_names", &mut hint.game_exe_names);
    read_str_array(obj, "launcher_folder_files", &mut hint.launcher_folder_files);
}

fn read_xxmi_config_importers(xxmi_root: &Path) -> std::collections::HashMap<String, XxmiImporterHint> {
    let mut map = std::collections::HashMap::new();
    let cfg_path = xxmi_root.join("XXMI Launcher Config.json");
    let Ok(raw) = fs::read_to_string(&cfg_path) else {
        return map;
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return map;
    };
    let Some(importers) = val.get("Importers").and_then(|v| v.as_object()) else {
        return map;
    };

    for (code, entry) in importers {
        let mut hint = XxmiImporterHint::default();
        if let Some(imp_obj) = entry.get("Importer").and_then(|v| v.as_object()) {
            apply_importer_section(xxmi_root, imp_obj, &mut hint);
        }
        if let Some(game_obj) = entry.get("Game").and_then(|v| v.as_object()) {
            apply_importer_section(xxmi_root, game_obj, &mut hint);
        }
        map.insert(code.to_uppercase(), hint);
    }

    map
}

fn find_mods_dir_for_importer(xxmi_root: &Path, code: &str) -> Option<PathBuf> {
    let candidates = [
        xxmi_root.join("XXMI").join(code).join("Mods"),
        xxmi_root.join(code).join("Mods"),
    ];
    candidates.into_iter().find(|p| p.is_dir())
}

fn registry_hints_for_game(apps: &[RegistryAppEntry], game: &GameDef) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let patterns: Vec<&str> = match game.id.as_str() {
        "wuthering-waves" => vec!["wuthering", "鸣潮", "wwmi", "库洛", "kuro"],
        "honkai-star-rail" => vec!["star rail", "星穹", "srmi", "米哈游", "mihoyo", "hoyoplay"],
        "zzz" => vec!["zenless", "绝区零", "zzmi", "米哈游", "mihoyo", "hoyoplay"],
        "endfield" => vec!["endfield", "终末地", "efmi", "鹰角", "hypergryph", "gryphlink"],
        "neverness-to-everness" => vec!["neverness", "异环", "nte"],
        _ => vec![],
    };
    for app in apps {
        let lower = app.display_name.to_lowercase();
        let matched = patterns.iter().any(|p| lower.contains(p))
            || (!game.name.is_empty() && lower.contains(&game.name.to_lowercase()))
            || (!game.short_name.is_empty() && lower.contains(&game.short_name.to_lowercase()));
        if !matched {
            continue;
        }
        if !app.install_location.trim().is_empty() {
            dirs.push(PathBuf::from(app.install_location.trim()));
        }
        if let Some(icon_path) = clean_registry_path(&app.display_icon) {
            if let Some(parent) = icon_path.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    dirs
}

/// Detects XXMI root, per-game `Mods` folders, launcher executables, and installed game binaries.
pub fn detect_xxmi_and_game_paths(
    settings: &Settings,
    explicit_xxmi_root: Option<&str>,
) -> AutoDetectPathsResult {
    let mut next_settings = settings.clone();
    let registry_apps = query_registry_apps();

    let mut xxmi_candidates: Vec<PathBuf> = Vec::new();
    if let Some(raw) = explicit_xxmi_root.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(inferred) = infer_xxmi_root_from_path(raw) {
            xxmi_candidates.push(PathBuf::from(inferred));
        }
        xxmi_candidates.push(PathBuf::from(raw));
    }
    if let Some(eff) = effective_xxmi_root(&next_settings, None) {
        xxmi_candidates.push(PathBuf::from(eff));
    }
    for app in &registry_apps {
        if app.display_name.to_lowercase().contains("xxmi") {
            if !app.install_location.trim().is_empty() {
                xxmi_candidates.push(PathBuf::from(app.install_location.trim()));
            }
            for raw in [&app.display_icon, &app.uninstall_string] {
                if let Some(p) = clean_registry_path(raw) {
                    if let Some(inferred) = infer_xxmi_root_from_path(&p.to_string_lossy()) {
                        xxmi_candidates.push(PathBuf::from(inferred));
                    } else if let Some(parent) = p.parent() {
                        xxmi_candidates.push(parent.to_path_buf());
                    }
                }
            }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        xxmi_candidates.push(PathBuf::from(appdata).join("XXMI Launcher"));
    }

    let resolved_xxmi_root = xxmi_candidates
        .iter()
        .filter(|p| p.is_dir())
        .find_map(|p| infer_xxmi_root_from_path(&p.to_string_lossy()).map(PathBuf::from))
        .or_else(|| xxmi_candidates.into_iter().find(|p| p.is_dir()));

    if let Some(root) = &resolved_xxmi_root {
        next_settings.xxmi_root = Some(normalize_display_path(&root.to_string_lossy()));
    }

    let config_hints = resolved_xxmi_root
        .as_deref()
        .map(read_xxmi_config_importers)
        .unwrap_or_default();
    let default_loader = resolved_xxmi_root
        .as_deref()
        .and_then(find_xxmi_launcher_exe);

    let force_overwrite_from_explicit = explicit_xxmi_root.is_some();
    let launcher_names = launcher_exe_candidates();
    let games = get_all_games(&next_settings);
    let mut detected_set = HashSet::new();
    let mut detected_games = Vec::new();

    for game in &games {
        let code = importer_code_for_game(game);
        let hint = code
            .as_deref()
            .and_then(|c| config_hints.get(&c.to_uppercase()));

        let detected_mods = hint.and_then(|h| h.mods_path.clone()).or_else(|| {
            resolved_xxmi_root
                .as_deref()
                .zip(code.as_deref())
                .and_then(|(root, c)| find_mods_dir_for_importer(root, c))
        });

        let mut game_exe_names = exe_candidates_for_game(game);
        if let Some(h) = hint {
            for name in &h.game_exe_names {
                if !game_exe_names.iter().any(|x| x.eq_ignore_ascii_case(name)) {
                    game_exe_names.push(name.clone());
                }
            }
        }
        let mut per_game_launchers = launcher_names.clone();
        if let Some(h) = hint {
            for name in &h.launcher_folder_files {
                if !per_game_launchers.iter().any(|x| x.eq_ignore_ascii_case(name)) {
                    per_game_launchers.push(name.clone());
                }
            }
        }
        let mut launcher_plus_exe = per_game_launchers.clone();
        for n in &game_exe_names {
            if !launcher_plus_exe.iter().any(|x| x.eq_ignore_ascii_case(n)) {
                launcher_plus_exe.push(n.clone());
            }
        }

        let current_mods_nonempty = settings
            .games
            .get(&game.id)
            .map(|g| !g.mods_path.trim().is_empty())
            .unwrap_or(false);
        let has_active_game_or_mods = detected_mods.is_some()
            || current_mods_nonempty
            || hint
                .and_then(|h| h.game_folder.as_deref())
                .map(|p| p.is_dir())
                .unwrap_or(false);

        // Priority A: Importer.launcher_folder
        let detected_game_exe = hint
            .and_then(|h| h.launcher_folder.as_deref())
            .and_then(|dir| find_exe_in_dir(dir, &launcher_plus_exe))
            // Priority B: Parent / grandparent of Importer.game_folder (e.g. Hypergryph / miHoYo Launcher)
            .or_else(|| {
                hint.and_then(|h| h.game_folder.as_deref()).and_then(|gf| {
                    let parent1 = gf.parent();
                    let parent2 = parent1.and_then(|p| p.parent());
                    parent1
                        .and_then(|dir| find_exe_in_dir(dir, &per_game_launchers))
                        .or_else(|| {
                            parent2.and_then(|dir| find_exe_in_dir(dir, &per_game_launchers))
                        })
                })
            })
            // Priority C: Registry official launcher if game/mods is configured
            .or_else(|| {
                if !has_active_game_or_mods {
                    return None;
                }
                registry_hints_for_game(&registry_apps, game)
                    .into_iter()
                    .find_map(|dir| find_exe_in_dir(&dir, &launcher_plus_exe))
            })
            // Priority D: Explicit start_exe_path or direct game binary inside Importer.game_folder
            .or_else(|| {
                hint.and_then(|h| h.start_exe_path.clone())
                    .filter(|p| p.is_file())
            })
            .or_else(|| {
                hint.and_then(|h| h.game_folder.as_deref())
                    .and_then(|dir| find_exe_in_dir(dir, &game_exe_names))
            });

        let gs = next_settings
            .games
            .entry(game.id.clone())
            .or_insert_with(GameSettings::default);

        let mut any_detected = false;
        if let Some(mods) = detected_mods {
            let mods_str = normalize_display_path(&mods.to_string_lossy());
            let same_normalized = !gs.mods_path.trim().is_empty()
                && normalize_display_path(&gs.mods_path).eq_ignore_ascii_case(&mods_str);
            if force_overwrite_from_explicit || gs.mods_path.trim().is_empty() || same_normalized {
                gs.mods_path = mods_str;
            }
            any_detected = true;
        }
        if let Some(loader) = &default_loader {
            let loader_str = normalize_display_path(&loader.to_string_lossy());
            if any_detected
                && (force_overwrite_from_explicit
                    || gs
                        .loader_path
                        .as_deref()
                        .map(|s| s.trim().is_empty())
                        .unwrap_or(true))
            {
                gs.loader_path = Some(loader_str);
            }
        }
        if let Some(game_exe) = detected_game_exe {
            let existing_valid = gs
                .game_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| Path::new(s).is_file())
                .unwrap_or(false);
            if !existing_valid {
                gs.game_path = Some(normalize_display_path(&game_exe.to_string_lossy()));
            }
            any_detected = true;
        }

        if any_detected && detected_set.insert(game.id.clone()) {
            detected_games.push(game.id.clone());
        }
    }

    AutoDetectPathsResult {
        ok: true,
        xxmi_root: resolved_xxmi_root.map(|p| normalize_display_path(&p.to_string_lossy())),
        detected_games,
        settings: Some(next_settings),
        error: None,
    }
}

pub fn resolve_env_root(mods_path: &str) -> Option<PathBuf> {
    let trimmed = mods_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mods = PathBuf::from(trimmed);
    let parent = mods.parent().map(Path::to_path_buf);
    if let Some(p) = &parent {
        if p.join("d3dx.ini").is_file() {
            return Some(p.clone());
        }
    }
    if mods.join("d3dx.ini").is_file() {
        return Some(mods);
    }
    parent.or(Some(mods))
}

fn inspect_shader_extras(
    root: &Path,
    raw_lines: &[&str],
) -> (EnvironmentShaderCacheInfo, EnvironmentShaderFixesInfo) {
    let mut enabled_in_ini: Option<bool> = None;
    let mut in_rendering = false;
    for raw_line in raw_lines {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(end) = trimmed.find(']') {
                let sec = trimmed[1..end].trim();
                in_rendering = sec.eq_ignore_ascii_case("rendering");
                continue;
            }
        }
        if !in_rendering {
            continue;
        }
        let clean = trimmed.split(';').next().unwrap_or("").trim();
        if let Some((lhs, rhs)) = clean.split_once('=') {
            if lhs.trim().eq_ignore_ascii_case("cache_shaders") {
                let val = rhs.trim();
                if val == "1" || val.eq_ignore_ascii_case("true") {
                    enabled_in_ini = Some(true);
                } else if val == "0" || val.eq_ignore_ascii_case("false") {
                    enabled_in_ini = Some(false);
                }
            }
        }
    }

    let cache_dir = root.join("ShaderCache");
    let cache_exists = cache_dir.is_dir();
    let mut cache_files = 0usize;
    let mut cache_bytes = 0u64;
    if cache_exists {
        let mut stack = vec![cache_dir];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.is_file() {
                    cache_files += 1;
                    if let Ok(meta) = fs::metadata(&path) {
                        cache_bytes = cache_bytes.saturating_add(meta.len());
                    }
                }
            }
        }
    }

    let fixes_dir = root.join("ShaderFixes");
    let fixes_exists = fixes_dir.is_dir();
    let mut fixes_count = 0usize;
    let mut sample_files = Vec::new();
    if fixes_exists {
        if let Ok(entries) = fs::read_dir(&fixes_dir) {
            let mut names: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().is_file())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|name| {
                    let lower = name.to_ascii_lowercase();
                    lower.ends_with(".hlsl") || lower.ends_with(".asm") || lower.ends_with(".txt")
                })
                .collect();
            names.sort();
            fixes_count = names.len();
            sample_files = names.into_iter().take(5).collect();
        }
    }

    (
        EnvironmentShaderCacheInfo {
            enabled_in_ini,
            dir_exists: cache_exists,
            file_count: cache_files,
            total_bytes: cache_bytes,
        },
        EnvironmentShaderFixesInfo {
            dir_exists: fixes_exists,
            file_count: fixes_count,
            sample_files,
        },
    )
}

/// Checks `d3dx.ini` `exclude_recursive = DISABLED*`, `ShaderCache`, and `ShaderFixes` per game.
pub fn check_environment_for_settings(
    settings: &Settings,
    game_id: Option<&str>,
    is_en: bool,
) -> Vec<EnvironmentCheck> {
    let all_games = get_all_games(settings);
    let target_ids: Vec<String> = if let Some(gid) = game_id {
        vec![gid.to_string()]
    } else {
        all_games.into_iter().map(|g| g.id).collect()
    };

    let mut result = Vec::new();
    for target in target_ids {
        let mods_path = settings
            .games
            .get(&target)
            .map(|g| g.mods_path.trim().to_string())
            .unwrap_or_default();
        if mods_path.is_empty() {
            result.push(EnvironmentCheck {
                game_id: target,
                mods_path,
                root: String::new(),
                d3dx_path: String::new(),
                status: "no-root".to_string(),
                detail: Some(if is_en {
                    "Mods directory is not configured".to_string()
                } else {
                    "尚未配置 Mods 目录".to_string()
                }),
                shader_cache: None,
                shader_fixes: None,
            });
            continue;
        }

        let root = resolve_env_root(&mods_path).unwrap_or_else(|| PathBuf::from(&mods_path));
        let d3dx_path = root.join("d3dx.ini");
        let root_str = normalize_display_path(&root.to_string_lossy());
        let d3dx_str = normalize_display_path(&d3dx_path.to_string_lossy());

        if !d3dx_path.is_file() {
            let (shader_cache, shader_fixes) = inspect_shader_extras(&root, &[]);
            result.push(EnvironmentCheck {
                game_id: target,
                mods_path,
                root: root_str,
                d3dx_path: d3dx_str,
                status: "missing-file".to_string(),
                detail: Some(if is_en {
                    "d3dx.ini not found".to_string()
                } else {
                    "未找到 d3dx.ini".to_string()
                }),
                shader_cache: Some(shader_cache),
                shader_fixes: Some(shader_fixes),
            });
            continue;
        }

        match fs::read(&d3dx_path) {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                let raw_lines: Vec<&str> = text.lines().collect();
                let mut ok = false;
                for raw_line in &raw_lines {
                    let clean = raw_line.split(';').next().unwrap_or("").trim();
                    if let Some((lhs, rhs)) = clean.split_once('=') {
                        if lhs.trim().eq_ignore_ascii_case("exclude_recursive")
                            && rhs.split_whitespace().any(|tok| {
                                tok.eq_ignore_ascii_case("DISABLED*")
                                    || tok.eq_ignore_ascii_case("DISABLED")
                            })
                        {
                            ok = true;
                            break;
                        }
                    }
                }
                let (shader_cache, shader_fixes) = inspect_shader_extras(&root, &raw_lines);
                result.push(EnvironmentCheck {
                    game_id: target,
                    mods_path,
                    root: root_str,
                    d3dx_path: d3dx_str,
                    status: if ok {
                        "ok".to_string()
                    } else {
                        "missing-line".to_string()
                    },
                    detail: if ok {
                        None
                    } else {
                        Some(if is_en {
                            "Missing exclude_recursive = DISABLED* rule".to_string()
                        } else {
                            "缺少 exclude_recursive = DISABLED* 规则".to_string()
                        })
                    },
                    shader_cache: Some(shader_cache),
                    shader_fixes: Some(shader_fixes),
                });
            }
            Err(err) => {
                result.push(EnvironmentCheck {
                    game_id: target,
                    mods_path,
                    root: root_str,
                    d3dx_path: d3dx_str,
                    status: "missing-file".to_string(),
                    detail: Some(err.to_string()),
                    shader_cache: None,
                    shader_fixes: None,
                });
            }
        }
    }
    result
}

pub fn clear_shader_cache_for_game(
    settings: &Settings,
    game_id: &str,
    is_en: bool,
) -> ClearShaderCacheResult {
    let mods_path = settings
        .games
        .get(game_id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return ClearShaderCacheResult {
            ok: false,
            deleted_files: None,
            freed_bytes: None,
            error: Some(if is_en {
                "Mods directory is not configured".to_string()
            } else {
                "尚未配置 Mods 目录".to_string()
            }),
        };
    }

    let Some(root) = resolve_env_root(mods_path) else {
        return ClearShaderCacheResult {
            ok: false,
            deleted_files: None,
            freed_bytes: None,
            error: Some("Invalid mods path".to_string()),
        };
    };
    let cache_dir = root.join("ShaderCache");
    if !cache_dir.is_dir() {
        return ClearShaderCacheResult {
            ok: true,
            deleted_files: Some(0),
            freed_bytes: Some(0),
            error: None,
        };
    }

    let Ok(canon_root) = root.canonicalize() else {
        return ClearShaderCacheResult {
            ok: false,
            deleted_files: None,
            freed_bytes: None,
            error: Some("Failed to resolve root directory".to_string()),
        };
    };
    let Ok(canon_cache) = cache_dir.canonicalize() else {
        return ClearShaderCacheResult {
            ok: false,
            deleted_files: None,
            freed_bytes: None,
            error: Some("Failed to resolve ShaderCache directory".to_string()),
        };
    };
    if !canon_cache.starts_with(&canon_root) {
        return ClearShaderCacheResult {
            ok: false,
            deleted_files: None,
            freed_bytes: None,
            error: Some("ShaderCache escapes importer root".to_string()),
        };
    }

    let mut deleted_files = 0usize;
    let mut freed_bytes = 0u64;
    let entries = match fs::read_dir(&canon_cache) {
        Ok(e) => e,
        Err(err) => {
            return ClearShaderCacheResult {
                ok: false,
                deleted_files: None,
                freed_bytes: None,
                error: Some(err.to_string()),
            };
        }
    };

    for entry in entries.flatten() {
        let full = entry.path();
        if !full.starts_with(&canon_cache) {
            continue;
        }
        if full.is_file() {
            let size = fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
            if let Err(err) = fs::remove_file(&full) {
                return ClearShaderCacheResult {
                    ok: false,
                    deleted_files: None,
                    freed_bytes: None,
                    error: Some(err.to_string()),
                };
            }
            deleted_files += 1;
            freed_bytes = freed_bytes.saturating_add(size);
        } else if full.is_dir() {
            if let Err(err) = fs::remove_dir_all(&full) {
                return ClearShaderCacheResult {
                    ok: false,
                    deleted_files: None,
                    freed_bytes: None,
                    error: Some(err.to_string()),
                };
            }
            deleted_files += 1;
        }
    }

    ClearShaderCacheResult {
        ok: true,
        deleted_files: Some(deleted_files),
        freed_bytes: Some(freed_bytes),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_xxmi_root_from_nested_mods_and_detects_importers() {
        let root = std::env::temp_dir().join(format!("moddeck-xxmi-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let efmi_mods = root.join("XXMI").join("EFMI").join("Mods");
        let bin_dir = root.join("Resources").join("Bin");
        fs::create_dir_all(&efmi_mods).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(bin_dir.join("XXMI Launcher.exe"), b"").unwrap();
        fs::write(root.join("XXMI Launcher Config.json"), r#"{"Importers":{}}"#).unwrap();

        let inferred = infer_xxmi_root_from_path(&efmi_mods.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(&inferred), root);

        let settings = crate::settings::default_settings();
        let res = detect_xxmi_and_game_paths(&settings, Some(&root.to_string_lossy()));
        assert!(res.ok);
        assert!(res.detected_games.contains(&"endfield".to_string()));
        let updated = res.settings.unwrap();
        assert_eq!(
            PathBuf::from(&updated.games["endfield"].mods_path),
            efmi_mods
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_xxmi_root_above_resources_bin_and_reads_launcher_folder() {
        let root = std::env::temp_dir().join(format!("moddeck-xxmi-bin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let efmi_dir = root.join("XXMI").join("EFMI");
        let efmi_mods = efmi_dir.join("Mods");
        let bin_dir = root.join("Resources").join("Bin");
        let launcher_dir = root.join("Hypergryph Launcher");
        let game_dir = launcher_dir.join("games").join("Arknights Endfield");
        fs::create_dir_all(&efmi_mods).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(bin_dir.join("XXMI Launcher.exe"), b"").unwrap();
        fs::write(launcher_dir.join("Launcher.exe"), b"").unwrap();

        let imp_forward = efmi_dir.to_string_lossy().replace('\\', "/");
        let config = serde_json::json!({
            "Importers": {
                "EFMI": {
                    "Importer": {
                        "importer_folder": imp_forward
                    },
                    "Game": {
                        "game_folder": game_dir.to_string_lossy().to_string(),
                        "launcher_folder": launcher_dir.to_string_lossy().to_string()
                    }
                }
            }
        });
        fs::write(
            root.join("XXMI Launcher Config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let inferred = infer_xxmi_root_from_path(&bin_dir.to_string_lossy()).unwrap();
        assert_eq!(PathBuf::from(&inferred), root);

        let mut settings = crate::settings::default_settings();
        settings.xxmi_root = Some(bin_dir.to_string_lossy().to_string());
        let res = detect_xxmi_and_game_paths(&settings, None);
        assert!(res.ok);
        assert_eq!(PathBuf::from(res.xxmi_root.as_deref().unwrap()), root);

        let updated = res.settings.unwrap();
        let endfield = &updated.games["endfield"];
        assert!(!endfield.mods_path.contains('/'));
        assert_eq!(PathBuf::from(&endfield.mods_path), efmi_mods);
        assert_eq!(
            PathBuf::from(endfield.game_path.as_deref().unwrap()),
            launcher_dir.join("Launcher.exe")
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_importer_nested_launcher_folder_and_checks_environment() {
        let root = std::env::temp_dir().join(format!("moddeck-env-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let efmi_dir = root.join("XXMI").join("EFMI");
        let efmi_mods = efmi_dir.join("Mods");
        let cache_dir = efmi_dir.join("ShaderCache");
        let fixes_dir = efmi_dir.join("ShaderFixes");
        let bin_dir = root.join("Resources").join("Bin");
        let launcher_dir = root.join("Hypergryph Launcher");
        let game_dir = launcher_dir.join("games").join("Arknights Endfield");

        fs::create_dir_all(&efmi_mods).unwrap();
        fs::create_dir_all(&cache_dir).unwrap();
        fs::create_dir_all(&fixes_dir).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&game_dir).unwrap();
        fs::write(bin_dir.join("XXMI Launcher.exe"), b"").unwrap();
        fs::write(launcher_dir.join("Launcher.exe"), b"").unwrap();
        fs::write(game_dir.join("Endfield.exe"), b"").unwrap();
        fs::write(cache_dir.join("shader.bin"), b"12345").unwrap();
        fs::write(fixes_dir.join("fix.hlsl"), b"// fix").unwrap();
        fs::write(
            efmi_dir.join("d3dx.ini"),
            "[Rendering]\r\ncache_shaders = 1\r\n[Loader]\r\nexclude_recursive = DISABLED*\r\n",
        )
        .unwrap();

        let imp_forward = efmi_dir.to_string_lossy().replace('\\', "/");
        let config = serde_json::json!({
            "Importers": {
                "EFMI": {
                    "Importer": {
                        "importer_folder": imp_forward,
                        "game_folder": game_dir.to_string_lossy().to_string(),
                        "launcher_folder": launcher_dir.to_string_lossy().to_string(),
                        "game_exe_names": ["Endfield.exe"],
                        "launcher_folder_files": ["Launcher.exe"]
                    }
                }
            }
        });
        fs::write(
            root.join("XXMI Launcher Config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        let settings = crate::settings::default_settings();
        let res = detect_xxmi_and_game_paths(&settings, Some(&root.to_string_lossy()));
        assert!(res.ok);
        let updated = res.settings.unwrap();
        assert_eq!(
            PathBuf::from(updated.games["endfield"].game_path.as_deref().unwrap()),
            launcher_dir.join("Launcher.exe")
        );

        let checks = check_environment_for_settings(&updated, Some("endfield"), true);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, "ok");
        assert_eq!(PathBuf::from(&checks[0].root), efmi_dir);
        assert_eq!(PathBuf::from(&checks[0].d3dx_path), efmi_dir.join("d3dx.ini"));
        let sc = checks[0].shader_cache.as_ref().unwrap();
        assert_eq!(sc.enabled_in_ini, Some(true));
        assert_eq!(sc.file_count, 1);
        assert_eq!(sc.total_bytes, 5);
        let sf = checks[0].shader_fixes.as_ref().unwrap();
        assert_eq!(sf.file_count, 1);

        let cleared = clear_shader_cache_for_game(&updated, "endfield", true);
        assert!(cleared.ok);
        assert_eq!(cleared.deleted_files, Some(1));
        assert_eq!(cleared.freed_bytes, Some(5));

        fs::write(efmi_dir.join("d3dx.ini"), "[Rendering]\r\ncache_shaders = 0\r\n").unwrap();
        let missing = check_environment_for_settings(&updated, Some("endfield"), true);
        assert_eq!(missing[0].status, "missing-line");

        let _ = fs::remove_dir_all(&root);
    }
}
