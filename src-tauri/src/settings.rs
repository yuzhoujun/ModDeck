use crate::games::builtin_games;
use crate::models::{GameSettings, ImportSettings, MetadataStore, Settings, UiSettings};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const SETTINGS_FILE: &str = "settings.json";
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
    let trimmed = value.trim().trim_end_matches(&['\\', '/'][..]);
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

pub fn load_metadata(base_dir: &Path) -> MetadataStore {
    let file_path = base_dir.join(METADATA_FILE);
    match fs::read_to_string(file_path) {
        Ok(raw) => serde_json::from_str::<MetadataStore>(&raw).unwrap_or_default(),
        Err(_) => MetadataStore::default(),
    }
}
