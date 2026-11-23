use crate::games::builtin_games;
use crate::models::{GameSettings, ImportSettings, MetadataStore, Settings, UiSettings};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "settings.json";
#[allow(dead_code)]
pub const METADATA_FILE: &str = "characters.json";

pub fn resolve_base_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("ModDeck");
        if fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("ModDeck-data");
        }
    }
    PathBuf::from("ModDeck-data")
}

pub fn default_settings() -> Settings {
    let mut games = HashMap::new();
    for g in builtin_games() {
        games.insert(g.id, GameSettings::default());
    }
    Settings {
        schema_version: 1,
        active_game_id: "wuthering-waves".into(),
        xxmi_root: Some(String::new()),
        games,
        custom_games: Vec::new(),
        hidden_game_ids: Vec::new(),
        only_show_configured_games: false,
        ui: UiSettings::default(),
        import: ImportSettings::default(),
        character_orders: HashMap::new(),
        mod_orders: HashMap::new(),
        recent_mods: Vec::new(),
        extra: HashMap::new(),
    }
}

pub fn normalize_mods_path(value: &str) -> String {
    let raw = value.trim();
    #[cfg(windows)]
    let normalized = raw.replace('/', "\\");
    #[cfg(not(windows))]
    let normalized = raw.to_string();

    let trimmed = normalized.trim_end_matches(&['\\', '/'][..]);
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name.eq_ignore_ascii_case("mods") {
            return trimmed.to_string();
        }
    }
    let candidate = path.join("Mods");
    if candidate.is_dir() {
        return candidate.to_string_lossy().to_string();
    }
    trimmed.to_string()
}

pub fn load_settings(base_dir: &Path) -> Settings {
    let file_path = base_dir.join(SETTINGS_FILE);
    let mut settings = match fs::read_to_string(&file_path) {
        Ok(raw) => serde_json::from_str::<Settings>(&raw).unwrap_or_else(|_| default_settings()),
        Err(_) => default_settings(),
    };

    for g in builtin_games() {
        settings.games.entry(g.id).or_default();
    }
    for gs in settings.games.values_mut() {
        gs.mods_path = normalize_mods_path(&gs.mods_path);
    }
    settings
}

pub fn merge_settings_patch(current: &Settings, patch: &Value) -> Settings {
    let mut base_val = serde_json::to_value(current).unwrap_or(Value::Object(Default::default()));
    deep_merge_json(&mut base_val, patch);
    let mut next = serde_json::from_value::<Settings>(base_val).unwrap_or_else(|_| current.clone());
    for gs in next.games.values_mut() {
        gs.mods_path = normalize_mods_path(&gs.mods_path);
    }
    next
}

fn deep_merge_json(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t_map), Value::Object(p_map)) => {
            for (k, v) in p_map {
                match t_map.get_mut(k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        deep_merge_json(existing, v);
                    }
                    _ => {
                        t_map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (t, p) => {
            *t = p.clone();
        }
    }
}

pub fn save_settings(base_dir: &Path, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    let target = base_dir.join(SETTINGS_FILE);
    let tmp = base_dir.join(format!("{SETTINGS_FILE}.tmp"));
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(dead_code)]
pub fn load_metadata(base_dir: &Path) -> MetadataStore {
    let file_path = base_dir.join(METADATA_FILE);
    match fs::read_to_string(file_path) {
        Ok(raw) => serde_json::from_str::<MetadataStore>(&raw).unwrap_or_default(),
        Err(_) => MetadataStore::default(),
    }
}

use crate::detect::infer_xxmi_root_from_path;
use crate::games::{get_all_games, is_builtin_game};
use crate::models::{GameDef, RecentMod};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

/// Normalizes settings fields, game entries, custom games, recent mods, and inferred `xxmiRoot`.
pub fn normalize_settings(mut settings: Settings) -> Settings {
    if settings.schema_version == 0 {
        settings.schema_version = 1;
    }

    // Deduplicate custom games and disallow colliding built-in IDs.
    let mut seen_custom = HashSet::new();
    let mut clean_custom: Vec<GameDef> = Vec::new();
    for mut g in settings.custom_games.drain(..) {
        let id = g.id.trim().to_string();
        if id.is_empty() || is_builtin_game(&id) || !seen_custom.insert(id.clone()) {
            continue;
        }
        g.id = id;
        g.is_custom = Some(true);
        clean_custom.push(g);
    }
    settings.custom_games = clean_custom;

    let all_games = get_all_games(&settings);
    let valid_ids: HashSet<String> = all_games.iter().map(|g| g.id.clone()).collect();

    if !valid_ids.contains(&settings.active_game_id) {
        settings.active_game_id = all_games
            .first()
            .map(|g| g.id.clone())
            .unwrap_or_else(|| "wuthering-waves".to_string());
    }

    // Normalize per-game settings and ensure every game entry exists.
    let mut normalized_games = HashMap::new();
    for g in &all_games {
        let mut gs = settings.games.remove(&g.id).unwrap_or_default();
        gs.mods_path = normalize_mods_path(&gs.mods_path);
        gs.game_path = gs
            .game_path
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        gs.loader_path = gs
            .loader_path
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        gs.launch_args = gs
            .launch_args
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        normalized_games.insert(g.id.clone(), gs);
    }
    settings.games = normalized_games;

    // Normalize or infer xxmi_root.
    settings.xxmi_root = settings
        .xxmi_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| infer_xxmi_root_from_path(s).unwrap_or_else(|| s.to_string()));

    if settings.xxmi_root.is_none() {
        for gs in settings.games.values() {
            if let Some(inferred) = gs
                .loader_path
                .as_deref()
                .and_then(infer_xxmi_root_from_path)
                .or_else(|| infer_xxmi_root_from_path(&gs.mods_path))
            {
                settings.xxmi_root = Some(inferred);
                break;
            }
        }
    }

    // Deduplicate hiddenGameIds.
    let mut seen_hidden = HashSet::new();
    settings.hidden_game_ids = settings
        .hidden_game_ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen_hidden.insert(s.clone()))
        .collect();

    if settings.ui.recent_mod_count == 0 {
        settings.ui.recent_mod_count = 8;
    } else if settings.ui.recent_mod_count > 50 {
        settings.ui.recent_mod_count = 50;
    }

    let mut seen_ignored_dirs = HashSet::new();
    settings.ui.ignored_mod_dirs = settings
        .ui
        .ignored_mod_dirs
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && !s.contains('/')
                && !s.contains('\\')
                && seen_ignored_dirs.insert(s.to_ascii_lowercase())
        })
        .collect();

    let mirror_mode = settings.ui.update_mirror_mode.trim().to_ascii_lowercase();
    settings.ui.update_mirror_mode = match mirror_mode.as_str() {
        "ghfast" | "ghproxy" | "custom" => mirror_mode,
        _ => "direct".to_string(),
    };
    settings.ui.update_custom_mirror = settings.ui.update_custom_mirror.trim().to_string();

    let max_recent = settings.ui.recent_mod_count as usize;
    settings.recent_mods.retain(|item| {
        !item.game_id.trim().is_empty()
            && !item.character_folder.trim().is_empty()
            && !item.mod_folder.trim().is_empty()
    });
    if settings.recent_mods.len() > max_recent {
        settings.recent_mods.truncate(max_recent);
    }

    settings
}

pub fn save_settings_atomic(base_dir: &Path, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(base_dir).map_err(|e| format!("Failed to create settings dir: {e}"))?;
    let target = base_dir.join("settings.json");
    let temp = base_dir.join(format!("settings.json.tmp-{}", std::process::id()));
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Serialize settings failed: {e}"))?;
    fs::write(&temp, content).map_err(|e| format!("Write settings temp failed: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target).map_err(|e| format!("Rename settings failed: {e}"))?;
    Ok(())
}

/// Prepends or promotes a recently toggled mod while honoring `ui.recentModCount`.
pub fn record_recent_mod(
    settings: &mut Settings,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    display_name: &str,
) {
    let strip_name = |s: &str| -> String {
        if s.len() >= 9 && s.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_") {
            s[9..].to_string()
        } else {
            s.to_string()
        }
    };
    let clean_target = strip_name(mod_folder);
    settings.recent_mods.retain(|item| {
        !(item.game_id == game_id
            && item.character_folder == character_folder
            && strip_name(&item.mod_folder) == clean_target)
    });

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);

    settings.recent_mods.insert(
        0,
        RecentMod {
            game_id: game_id.to_string(),
            character_folder: character_folder.to_string(),
            mod_folder: mod_folder.to_string(),
            name: display_name.to_string(),
            at: now_ms,
        },
    );

    let max_recent = (settings.ui.recent_mod_count as usize).clamp(1, 50);
    if settings.recent_mods.len() > max_recent {
        settings.recent_mods.truncate(max_recent);
    }
}

/// Loads custom external locale JSON files from portable `<exeDir>/languages/` and `<baseDir>/languages/`.
pub fn load_custom_locales(exe_dir: Option<&Path>, base_dir: &Path) -> HashMap<String, Value> {
    let mut locales = HashMap::new();
    let mut dirs = Vec::new();
    if let Some(dir) = exe_dir {
        dirs.push(dir.join("languages"));
    }
    dirs.push(base_dir.join("languages"));

    for lang_dir in dirs {
        let Ok(entries) = fs::read_dir(&lang_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if !ext.eq_ignore_ascii_case("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let code = stem.trim();
            if code.is_empty() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if parsed.is_object() {
                locales.insert(code.to_string(), parsed);
            }
        }
    }

    locales
}

/// Returns true when the effective UI language preference is non-Chinese (used for roster folder defaults).
pub fn is_non_zh_effective_locale(language: &str) -> bool {
    let lang = language.trim().to_lowercase();
    if lang.is_empty() || lang == "auto" {
        return false;
    }
    !lang.starts_with("zh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_custom_games_and_caps_recent_mods() {
        let mut s = default_settings();
        s.ui.recent_mod_count = 3;
        s.custom_games.push(GameDef {
            id: "my-game".to_string(),
            name: "My Game".to_string(),
            name_en: None,
            short_name: "MG".to_string(),
            short_name_en: None,
            loader: "XXMI".to_string(),
            exe_hint: None,
            accent: None,
            is_custom: None,
            locales: None,
        });
        s.custom_games.push(GameDef {
            id: "endfield".to_string(), // collides with built-in, must be stripped
            name: "Fake".to_string(),
            name_en: None,
            short_name: "F".to_string(),
            short_name_en: None,
            loader: "XXMI".to_string(),
            exe_hint: None,
            accent: None,
            is_custom: None,
            locales: None,
        });

        let mut normalized = normalize_settings(s);
        assert_eq!(normalized.custom_games.len(), 1);
        assert_eq!(normalized.custom_games[0].is_custom, Some(true));
        assert!(normalized.games.contains_key("my-game"));

        for idx in 0..5 {
            record_recent_mod(
                &mut normalized,
                "endfield",
                "Perlica",
                &format!("Mod{idx}"),
                &format!("Mod{idx}"),
            );
        }
        assert_eq!(normalized.recent_mods.len(), 3);
        assert_eq!(normalized.recent_mods[0].mod_folder, "Mod4");
    }

    #[test]
    fn loads_custom_locales_with_user_override() {
        let root = std::env::temp_dir().join(format!("moddeck-locales-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let exe_dir = root.join("exe");
        let base_dir = root.join("base");
        fs::create_dir_all(exe_dir.join("languages")).unwrap();
        fs::create_dir_all(base_dir.join("languages")).unwrap();
        fs::write(exe_dir.join("languages").join("ja.json"), r#"{"a":"1"}"#).unwrap();
        fs::write(base_dir.join("languages").join("ja.json"), r#"{"a":"2"}"#).unwrap();

        let locales = load_custom_locales(Some(&exe_dir), &base_dir);
        assert_eq!(locales["ja"]["a"], "2");

        let _ = fs::remove_dir_all(&root);
    }
}
