use crate::ini_analysis::{
    classify_variable_filter, collect_mod_ini_files, is_transient_variable, read_local_ignore_rules,
};
use crate::library::{is_safe_segment, resolve_character_dir};
use crate::models::{
    CharacterModAssignment, D3dxSyncStatus, ImportPresetsResult, ImportRosterResult,
    ModAssignmentItem, ModPresetExportFile, ModPresetExportItem, ModVariantPreset, RosterMatchedItem,
    RosterMissingMod, RosterPreset, RosterPresetExportAssignment, RosterPresetExportFile,
    RosterPresetExportMod, RosterPresetExportScheme, RosterSchemeImportInspection,
    SaveModPresetResult, SaveRosterPresetInput, ToggleResult,
};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const ROSTER_PRESETS_FILE: &str = "roster-presets.json";
const BRIDGE_FOLDER_NAME: &str = "_ModDeck_Preset_Bridge";
const BRIDGE_FILE_NAME: &str = "bridge.ini";

static PRESET_ID_SEQ: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn next_id(prefix: &str) -> String {
    let seq = PRESET_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{}_{}", now_ms(), seq)
}

fn strip_disabled_prefix(s: &str) -> &str {
    if s.len() >= 9 && s.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_") {
        &s[9..]
    } else {
        s
    }
}

fn starts_with_disabled_ci(s: &str) -> bool {
    s.len() >= 9 && s.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<T>(&raw).ok()
}

fn write_json_atomic<T: Serialize>(path: &Path, val: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let content =
        serde_json::to_string_pretty(val).map_err(|e| format!("Serialize JSON failed: {e}"))?;
    fs::write(&tmp, content).map_err(|e| format!("Write temp JSON failed: {e}"))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("Rename JSON failed: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct PendingPresetEntry {
    pub preset_id: String,
    pub character_folder: String,
    pub clean_mod_name: String,
    #[allow(dead_code)]
    pub mods_path: String,
    pub variables: HashMap<String, String>,
    pub reloading: bool,
}

#[derive(Debug, Clone)]
pub struct PendingModToggleEntry {
    pub initial_enabled: bool,
    pub current_enabled: bool,
}

#[derive(Debug, Default)]
pub struct PendingQueueState {
    pub preset_queue: HashMap<String, PendingPresetEntry>,
    pub mod_toggles: HashMap<String, PendingModToggleEntry>,
    pub roster_schemes: HashSet<String>,
}

fn make_queue_key(game_id: &str, character_folder: &str, mod_folder: &str) -> String {
    let clean = strip_disabled_prefix(mod_folder).to_ascii_lowercase();
    format!(
        "{game_id}:{}:{clean}",
        character_folder.to_ascii_lowercase()
    )
}

impl PendingQueueState {
    pub fn record_mod_toggle(
        &mut self,
        game_id: &str,
        character_folder: &str,
        mod_name: &str,
        new_enabled: bool,
    ) {
        let key = make_queue_key(game_id, character_folder, mod_name);
        if let Some(existing) = self.mod_toggles.get_mut(&key) {
            existing.current_enabled = new_enabled;
            if existing.current_enabled == existing.initial_enabled {
                self.mod_toggles.remove(&key);
            }
        } else {
            self.mod_toggles.insert(
                key,
                PendingModToggleEntry {
                    initial_enabled: !new_enabled,
                    current_enabled: new_enabled,
                },
            );
        }
    }

    pub fn clear_mod_toggles(&mut self, game_id: Option<&str>) {
        match game_id {
            None => self.mod_toggles.clear(),
            Some(gid) => {
                let prefix = format!("{gid}:");
                self.mod_toggles.retain(|k, _| !k.starts_with(&prefix));
            }
        }
    }

    pub fn clear_for_mod(&mut self, game_id: &str, character_folder: &str, mod_name: &str) {
        let key = make_queue_key(game_id, character_folder, mod_name);
        self.preset_queue.remove(&key);
        self.mod_toggles.remove(&key);
    }

    pub fn record_roster_scheme(&mut self, game_id: &str) {
        self.roster_schemes.insert(game_id.to_string());
    }

    pub fn clear_all(&mut self, game_id: Option<&str>) {
        match game_id {
            None => {
                self.preset_queue.clear();
                self.mod_toggles.clear();
                self.roster_schemes.clear();
            }
            Some(gid) => {
                let prefix = format!("{gid}:");
                self.preset_queue.retain(|k, _| !k.starts_with(&prefix));
                self.mod_toggles.retain(|k, _| !k.starts_with(&prefix));
                self.roster_schemes.remove(gid);
            }
        }
    }

    pub fn pending_count(&self, game_id: Option<&str>) -> usize {
        let prefix = game_id.map(|g| format!("{g}:"));
        let mut keys = HashSet::new();
        for (k, entry) in &self.preset_queue {
            if !entry.reloading && prefix.as_ref().map(|p| k.starts_with(p)).unwrap_or(true) {
                keys.insert(k.as_str());
            }
        }
        for k in self.mod_toggles.keys() {
            if prefix.as_ref().map(|p| k.starts_with(p)).unwrap_or(true) {
                keys.insert(k.as_str());
            }
        }
        let count = keys.len();
        let has_scheme = match game_id {
            None => !self.roster_schemes.is_empty(),
            Some(g) => self.roster_schemes.contains(g),
        };
        if has_scheme && count == 0 {
            1
        } else {
            count
        }
    }

    pub fn entries_for_game(&self, game_id: &str) -> Vec<&PendingPresetEntry> {
        let prefix = format!("{game_id}:");
        self.preset_queue
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, v)| v)
            .collect()
    }
}

fn mod_preset_file_path(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
) -> PathBuf {
    let clean = strip_disabled_prefix(mod_folder);
    base_dir
        .join("presets")
        .join(game_id)
        .join(character_folder)
        .join(format!("{clean}.json"))
}

fn normalize_ini_rel_clean(rel: &str) -> String {
    let parts: Vec<&str> = rel.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return String::new();
    }
    let mut out = Vec::with_capacity(parts.len());
    for (idx, p) in parts.iter().enumerate() {
        if idx + 1 == parts.len() {
            out.push(strip_disabled_prefix(p));
        } else {
            out.push(*p);
        }
    }
    out.join("/")
}

pub fn inspect_mod_default_variables(mod_path: &Path) -> HashMap<String, String> {
    static NS_RX: OnceLock<Regex> = OnceLock::new();
    static PERSIST_RX: OnceLock<Regex> = OnceLock::new();
    let ns_rx = NS_RX.get_or_init(|| Regex::new(r"(?i)^namespace\s*=\s*(.+)$").unwrap());
    let persist_rx = PERSIST_RX.get_or_init(|| {
        Regex::new(r"(?i)^(?:global\s+persist|persist\s+global|persist)\s+\$([a-zA-Z0-9_]+)\s*=\s*([^;]+)").unwrap()
    });

    let mut default_vars = HashMap::new();
    let (active, disabled) = collect_mod_ini_files(mod_path, false);
    for rel in active.into_iter().chain(disabled) {
        let Ok(bytes) = fs::read(mod_path.join(&rel)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut ns = String::new();
        let clean_rel = rel
            .split(['\\', '/'])
            .map(strip_disabled_prefix)
            .collect::<Vec<_>>()
            .join("\\");

        for raw_line in text.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
                continue;
            }
            if let Some(cap) = ns_rx.captures(line) {
                ns = cap[1].trim().replace('/', "\\");
                continue;
            }
            if let Some(cap) = persist_rx.captures(line) {
                let var_name = cap[1].trim();
                let default_val = cap[2].trim().to_string();
                let key = if !ns.is_empty() {
                    format!("$\\{ns}\\{var_name}")
                } else {
                    format!("$\\{clean_rel}\\{var_name}")
                }
                .to_ascii_lowercase();
                default_vars.insert(key, default_val);
            }
        }
    }
    default_vars
}

pub fn find_d3dx_ini_path(mods_path: &Path) -> Option<PathBuf> {
    if let Some(parent) = mods_path.parent() {
        let c1 = parent.join("d3dx.ini");
        if c1.is_file() {
            return Some(c1);
        }
    }
    let c2 = mods_path.join("d3dx.ini");
    if c2.is_file() {
        return Some(c2);
    }
    None
}

pub fn find_d3dx_user_ini_path(mods_path: &Path) -> Option<PathBuf> {
    if let Some(parent) = mods_path.parent() {
        let c1 = parent.join("d3dx_user.ini");
        if c1.is_file() {
            return Some(c1);
        }
    }
    let c2 = mods_path.join("d3dx_user.ini");
    if c2.is_file() {
        return Some(c2);
    }
    None
}

pub fn get_d3dx_auto_save_interval(mods_path: &Path) -> i64 {
    static INTERVAL_RX: OnceLock<Regex> = OnceLock::new();
    let rx = INTERVAL_RX.get_or_init(|| {
        RegexBuilder::new(r"^\s*settings_auto_save_interval\s*=\s*(-?\d+)")
            .case_insensitive(true)
            .multi_line(true)
            .build()
            .unwrap()
    });
    let Some(ini_path) = find_d3dx_ini_path(mods_path) else {
        return 60;
    };
    let Ok(bytes) = fs::read(ini_path) else {
        return 60;
    };
    let text = String::from_utf8_lossy(&bytes);
    rx.captures(&text)
        .and_then(|c| c[1].parse::<i64>().ok())
        .unwrap_or(60)
}

pub fn set_d3dx_auto_save_interval(mods_path: &Path, interval: i64) -> ToggleResult {
    static INTERVAL_RX: OnceLock<Regex> = OnceLock::new();
    let rx = INTERVAL_RX.get_or_init(|| {
        RegexBuilder::new(r"^(\s*settings_auto_save_interval\s*=\s*)-?\d+")
            .case_insensitive(true)
            .multi_line(true)
            .build()
            .unwrap()
    });
    let Some(ini_path) = find_d3dx_ini_path(mods_path) else {
        return ToggleResult::err("d3dx.ini not found");
    };
    let Ok(bytes) = fs::read(&ini_path) else {
        return ToggleResult::err("Failed to read d3dx.ini");
    };
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let updated = if rx.is_match(&content) {
        rx.replace(&content, format!("${{1}}{interval}")).into_owned()
    } else {
        format!("{content}\r\nsettings_auto_save_interval = {interval}\r\n")
    };
    match fs::write(&ini_path, updated) {
        Ok(()) => ToggleResult::ok(),
        Err(err) => ToggleResult::err(err.to_string()),
    }
}

pub fn get_d3dx_sync_status(mods_path: &Path, pending_count: usize) -> D3dxSyncStatus {
    let interval = if mods_path.as_os_str().is_empty() {
        60
    } else {
        get_d3dx_auto_save_interval(mods_path)
    };
    let user_ini = if mods_path.as_os_str().is_empty() {
        None
    } else {
        find_d3dx_user_ini_path(mods_path)
    };
    if let Some(p) = user_ini {
        let mtime_ms = fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        D3dxSyncStatus {
            exists: true,
            file_path: Some(p.to_string_lossy().to_string()),
            mtime_ms,
            auto_save_interval: interval,
            game_running: false,
            pending_count,
        }
    } else {
        D3dxSyncStatus {
            exists: false,
            file_path: None,
            mtime_ms: 0,
            auto_save_interval: interval,
            game_running: false,
            pending_count,
        }
    }
}

fn match_d3dx_key(lower_line_key: &str, target_key: &str, clean_mod_lower: &str) -> bool {
    let target_suffix = target_key.strip_prefix('$').unwrap_or(target_key);
    let var_name_only = target_key
        .rfind('\\')
        .map(|i| &target_key[i..])
        .unwrap_or(target_key);
    if !clean_mod_lower.is_empty() && lower_line_key.contains("\\mods\\") {
        let mod_seg = format!("\\{clean_mod_lower}\\");
        if !lower_line_key.contains(&mod_seg) {
            return false;
        }
        return lower_line_key == target_key
            || lower_line_key.ends_with(target_suffix)
            || lower_line_key.ends_with(var_name_only);
    }
    lower_line_key == target_key || lower_line_key.ends_with(target_suffix)
}

pub fn read_active_d3dx_user_variables(
    mods_path: &Path,
    known_keys: &[String],
    mod_folder: &str,
) -> HashMap<String, String> {
    let Some(user_ini) = find_d3dx_user_ini_path(mods_path) else {
        return HashMap::new();
    };
    let Ok(bytes) = fs::read(user_ini) else {
        return HashMap::new();
    };
    let raw = String::from_utf8_lossy(&bytes);
    let clean_mod_lower = strip_disabled_prefix(mod_folder).to_ascii_lowercase();
    let normalized_known: Vec<String> = known_keys.iter().map(|k| k.to_ascii_lowercase()).collect();

    let mut result = HashMap::new();
    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if !line.starts_with("$\\") {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let lower_full_key = k.trim().to_ascii_lowercase();
        let val = v.trim().to_string();

        if !normalized_known.is_empty() {
            for target_key in &normalized_known {
                if match_d3dx_key(&lower_full_key, target_key, &clean_mod_lower) {
                    result.insert(target_key.clone(), val.clone());
                }
            }
        } else if !clean_mod_lower.is_empty() && lower_full_key.contains("\\mods\\") {
            result.insert(lower_full_key, val);
        }
    }
    result
}

fn build_full_3dmigoto_var_key(
    raw_key: &str,
    character_folder: &str,
    clean_mod_name: &str,
) -> String {
    let lower = raw_key.to_ascii_lowercase();
    if lower.contains("\\mods\\") {
        return raw_key.to_string();
    }
    if let Some(rel_part) = raw_key.strip_prefix("$\\") {
        if !character_folder.is_empty() && !clean_mod_name.is_empty() {
            if rel_part.to_ascii_lowercase().contains(".ini\\") {
                return format!("$\\mods\\{character_folder}\\{clean_mod_name}\\{rel_part}");
            }
            return format!("$\\{rel_part}");
        }
    }
    raw_key.to_string()
}

pub fn apply_variables_to_d3dx_user_ini(
    mods_path: &Path,
    variables: &HashMap<String, String>,
    character_folder: &str,
    mod_folder: &str,
) -> bool {
    let Some(user_ini) = find_d3dx_user_ini_path(mods_path) else {
        return false;
    };
    let Ok(bytes) = fs::read(&user_ini) else {
        return false;
    };
    let raw = String::from_utf8_lossy(&bytes);
    let clean_mod_name = strip_disabled_prefix(mod_folder);
    let clean_mod_lower = clean_mod_name.to_ascii_lowercase();

    let mut var_map: Vec<(String, String, String)> = Vec::new();
    for (k, v) in variables {
        if !is_transient_variable(k) {
            var_map.push((k.to_ascii_lowercase(), k.clone(), v.clone()));
        }
    }

    let mut updated_lines = Vec::new();
    let mut handled_keys = HashSet::new();

    for raw_line in raw.lines() {
        let line = raw_line.trim();
        if line.starts_with("$\\") {
            if let Some((k, _)) = line.split_once('=') {
                let current_key = k.trim();
                let lower_key = current_key.to_ascii_lowercase();
                if let Some((target_lower, _, target_val)) = var_map
                    .iter()
                    .find(|(tk, _, _)| match_d3dx_key(&lower_key, tk, &clean_mod_lower))
                {
                    updated_lines.push(format!("{current_key} = {target_val}"));
                    handled_keys.insert(target_lower.clone());
                    continue;
                }
            }
        }
        updated_lines.push(raw_line.to_string());
    }

    for (target_lower, orig_key, val) in &var_map {
        if !handled_keys.contains(target_lower) {
            let full_key = build_full_3dmigoto_var_key(orig_key, character_folder, clean_mod_name);
            updated_lines.push(format!("{full_key} = {val}"));
        }
    }

    fs::write(&user_ini, updated_lines.join("\r\n")).is_ok()
}

pub fn clear_preset_bridge_ini(mods_path: &Path) {
    let bridge_file = mods_path.join(BRIDGE_FOLDER_NAME).join(BRIDGE_FILE_NAME);
    if bridge_file.is_file() {
        let _ = fs::write(bridge_file, "; ModDeck Preset Bridge Idle\r\n");
    }
}

pub fn sync_bridge_file_from_queue(
    mods_path: &Path,
    game_id: &str,
    pending: &PendingQueueState,
) {
    let entries = pending.entries_for_game(game_id);
    if entries.is_empty() {
        clear_preset_bridge_ini(mods_path);
        return;
    }

    let bridge_dir = mods_path.join(BRIDGE_FOLDER_NAME);
    if fs::create_dir_all(&bridge_dir).is_err() {
        return;
    }
    let bridge_file = bridge_dir.join(BRIDGE_FILE_NAME);

    let mut existing_keys: Vec<(String, String)> = Vec::new();
    if let Some(user_ini) = find_d3dx_user_ini_path(mods_path) {
        if let Ok(bytes) = fs::read(user_ini) {
            for raw_line in String::from_utf8_lossy(&bytes).lines() {
                let line = raw_line.trim();
                if line.starts_with("$\\") {
                    if let Some((k, _)) = line.split_once('=') {
                        let key_str = k.trim().to_string();
                        existing_keys.push((key_str.to_ascii_lowercase(), key_str));
                    }
                }
            }
        }
    }

    let mut assignment_lines = Vec::new();
    let mut assigned_canonical = HashSet::new();

    for entry in entries {
        let clean_mod_lower = entry.clean_mod_name.to_ascii_lowercase();
        assignment_lines.push(format!(
            "  ; Character: {} | Mod: {}",
            entry.character_folder, entry.clean_mod_name
        ));

        for (raw_key, raw_val) in &entry.variables {
            if is_transient_variable(raw_key) {
                continue;
            }
            let trimmed_val = raw_val.trim();
            if trimmed_val.parse::<f64>().is_err() {
                continue;
            }
            let target_lower = raw_key.to_ascii_lowercase();
            let resolved = existing_keys
                .iter()
                .find(|(lk, _)| match_d3dx_key(lk, &target_lower, &clean_mod_lower))
                .map(|(_, rk)| rk.clone())
                .unwrap_or_else(|| {
                    build_full_3dmigoto_var_key(
                        raw_key,
                        &entry.character_folder,
                        &entry.clean_mod_name,
                    )
                });

            let lower_resolved = resolved.to_ascii_lowercase();
            if assigned_canonical.insert(lower_resolved) {
                assignment_lines.push(format!("  {resolved} = {trimmed_val}"));
            }
        }
    }

    if assignment_lines.is_empty() {
        clear_preset_bridge_ini(mods_path);
        return;
    }

    let mut content = vec![
        "; Auto-generated by ModDeck Preset Engine (Multi-Character Batch Bridge)".to_string(),
        "[Constants]".to_string(),
        "global $md_preset_applied = 0".to_string(),
        String::new(),
        "[Present]".to_string(),
        "if $md_preset_applied == 0".to_string(),
    ];
    content.extend(assignment_lines);
    content.push("  $md_preset_applied = 1".to_string());
    content.push("endif".to_string());
    content.push(String::new());

    let _ = fs::write(bridge_file, content.join("\r\n"));
}

fn are_variables_equal(
    vars_a: &HashMap<String, String>,
    vars_b: &HashMap<String, String>,
    is_ignored: &dyn Fn(&str) -> bool,
) -> bool {
    let mut map_a = HashMap::new();
    for (k, v) in vars_a {
        if !is_ignored(k) {
            map_a.insert(k.to_ascii_lowercase(), v.as_str());
        }
    }
    let mut map_b = HashMap::new();
    for (k, v) in vars_b {
        if !is_ignored(k) {
            map_b.insert(k.to_ascii_lowercase(), v.as_str());
        }
    }

    let all_keys: HashSet<&String> = map_a.keys().chain(map_b.keys()).collect();
    for k in all_keys {
        match (map_a.get(k), map_b.get(k)) {
            (Some(a), Some(b)) => {
                if let (Ok(na), Ok(nb)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                    if (na - nb).abs() > 0.0005 {
                        return false;
                    }
                } else if !a.eq_ignore_ascii_case(b) {
                    return false;
                }
            }
            (None, None) => {}
            _ => return false,
        }
    }
    true
}

fn is_preset_content_identical(
    preset: &ModVariantPreset,
    active_inis: &[String],
    variables: &HashMap<String, String>,
    is_ignored: &dyn Fn(&str) -> bool,
) -> bool {
    let set_a: HashSet<String> = preset
        .active_ini_files
        .iter()
        .map(|f| f.replace('\\', "/").to_ascii_lowercase())
        .collect();
    let set_b: HashSet<String> = active_inis
        .iter()
        .map(|f| f.replace('\\', "/").to_ascii_lowercase())
        .collect();
    if set_a != set_b {
        return false;
    }
    let empty_vars = HashMap::new();
    are_variables_equal(
        preset.variables.as_ref().unwrap_or(&empty_vars),
        variables,
        is_ignored,
    )
}

fn evaluate_preset_active(
    preset: &ModVariantPreset,
    current_active_inis: &[String],
    effective_vars: &HashMap<String, String>,
    is_ignored: &dyn Fn(&str) -> bool,
) -> bool {
    let desired: HashSet<String> = preset
        .active_ini_files
        .iter()
        .map(|f| f.replace('\\', "/").to_ascii_lowercase())
        .collect();
    let current: HashSet<String> = current_active_inis.iter().cloned().collect();
    if desired != current {
        return false;
    }
    if let Some(vars) = &preset.variables {
        for (k, v) in vars {
            if is_ignored(k) {
                continue;
            }
            if let Some(eff) = effective_vars.get(&k.to_ascii_lowercase()) {
                if let (Ok(na), Ok(nb)) = (v.trim().parse::<f64>(), eff.trim().parse::<f64>()) {
                    if (na - nb).abs() > 0.0005 {
                        return false;
                    }
                } else if !v.eq_ignore_ascii_case(eff) {
                    return false;
                }
            }
        }
    }
    true
}

pub fn get_mod_presets(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    mod_path: Option<&Path>,
    mods_path: Option<&Path>,
    global_ignore_rules: &[String],
    pending: &PendingQueueState,
) -> Vec<ModVariantPreset> {
    let clean_mod_name = strip_disabled_prefix(mod_folder).to_string();
    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let mut list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();

    let mut current_active_inis = Vec::new();
    let mut default_vars = HashMap::new();
    let mut local_ignore_rules = Vec::new();

    if let Some(mp) = mod_path.filter(|p| p.is_dir()) {
        let (active, _) = collect_mod_ini_files(mp, false);
        current_active_inis = active
            .iter()
            .map(|r| normalize_ini_rel_clean(r).to_ascii_lowercase())
            .collect();
        default_vars = inspect_mod_default_variables(mp);
        local_ignore_rules = read_local_ignore_rules(mp).1;
    }

    let is_ignored = |key: &str| {
        classify_variable_filter(key, global_ignore_rules, &local_ignore_rules).0
    };

    let known_keys: Vec<String> = default_vars.keys().cloned().collect();
    let mut effective_vars = default_vars.clone();
    if let Some(root) = mods_path {
        let active_d3d = read_active_d3dx_user_variables(root, &known_keys, mod_folder);
        for (k, v) in active_d3d {
            effective_vars.insert(k, v);
        }
    }

    let q_key = make_queue_key(game_id, character_folder, mod_folder);
    let pending_entry = pending.preset_queue.get(&q_key);
    if let Some(pe) = pending_entry {
        if pe.reloading {
            for (k, v) in &pe.variables {
                effective_vars.insert(k.to_ascii_lowercase(), v.clone());
            }
        }
    }

    let mut list_modified = false;
    if let Some(def) = list.iter_mut().find(|p| p.id == "__default__") {
        if def.name == "默认 (初始)" || def.name == "默认(初始)" {
            def.name = "默认".to_string();
            list_modified = true;
        }
        let prev_len = def.variables.as_ref().map(|m| m.len()).unwrap_or(0);
        if !default_vars.is_empty() && prev_len != default_vars.len() {
            def.variables = Some(default_vars.clone());
            list_modified = true;
        }
    } else {
        let mut default_inis = Vec::new();
        if let Some(mp) = mod_path.filter(|p| p.is_dir()) {
            let (active, disabled) = collect_mod_ini_files(mp, false);
            let chosen = if !active.is_empty() { active } else { disabled };
            default_inis = chosen
                .iter()
                .map(|r| normalize_ini_rel_clean(r))
                .collect();
        }
        list.insert(
            0,
            ModVariantPreset {
                id: "__default__".to_string(),
                name: "默认".to_string(),
                mod_name: clean_mod_name,
                character_folder: character_folder.to_string(),
                active_ini_files: default_inis,
                variables: Some(default_vars),
                is_active: None,
                is_pending: None,
                updated_at: 0,
            },
        );
        list_modified = true;
    }

    if list_modified {
        let _ = write_json_atomic(&file_path, &list);
    }

    for p in &mut list {
        p.is_active = Some(evaluate_preset_active(
            p,
            &current_active_inis,
            &effective_vars,
            &is_ignored,
        ));
        p.is_pending = Some(
            pending_entry
                .map(|pe| !pe.reloading && pe.preset_id == p.id)
                .unwrap_or(false),
        );
    }

    list
}

pub fn save_mod_preset(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    mod_path: &Path,
    mods_path: &Path,
    preset_name: &str,
    global_ignore_rules: &[String],
    pending: &mut PendingQueueState,
) -> SaveModPresetResult {
    let name = preset_name.trim();
    if name.is_empty() {
        return SaveModPresetResult {
            ok: false,
            reloaded: None,
            error: Some("Preset name cannot be empty".to_string()),
            synced_f10: None,
            possible_stale: None,
            stale_reason: None,
        };
    }
    if !mod_path.is_dir() {
        return SaveModPresetResult {
            ok: false,
            reloaded: None,
            error: Some("Mod folder does not exist".to_string()),
            synced_f10: None,
            possible_stale: None,
            stale_reason: None,
        };
    }

    let clean_mod_name = strip_disabled_prefix(mod_folder).to_string();
    pending
        .preset_queue
        .remove(&make_queue_key(game_id, character_folder, mod_folder));

    let (active_inis, _) = collect_mod_ini_files(mod_path, false);
    let clean_active_inis: Vec<String> = active_inis
        .iter()
        .map(|r| normalize_ini_rel_clean(r))
        .collect();

    let default_vars = inspect_mod_default_variables(mod_path);
    let local_ignore_rules = read_local_ignore_rules(mod_path).1;
    let is_ignored = |key: &str| {
        classify_variable_filter(key, global_ignore_rules, &local_ignore_rules).0
    };

    let known_keys: Vec<String> = default_vars.keys().cloned().collect();
    let active_vars = read_active_d3dx_user_variables(mods_path, &known_keys, mod_folder);

    let mut snapshot_vars = HashMap::new();
    for (k, v) in default_vars {
        if !is_ignored(&k) {
            snapshot_vars.insert(k, v);
        }
    }
    for (k, v) in active_vars {
        if !is_ignored(&k) {
            snapshot_vars.insert(k, v);
        }
    }

    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let mut list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();
    let existing_idx = list.iter().position(|p| p.name.eq_ignore_ascii_case(name));

    if let Some(dup) = list.iter().enumerate().find_map(|(i, p)| {
        if Some(i) == existing_idx {
            return None;
        }
        if is_preset_content_identical(p, &clean_active_inis, &snapshot_vars, &is_ignored) {
            Some(p)
        } else {
            None
        }
    }) {
        return SaveModPresetResult {
            ok: false,
            reloaded: None,
            error: Some(format!(
                "Current appearance matches existing preset \"{}\" cleanly; no duplicate needed",
                dup.name
            )),
            synced_f10: None,
            possible_stale: Some(true),
            stale_reason: Some("unsynced-game-running".to_string()),
        };
    }

    let new_preset = ModVariantPreset {
        id: existing_idx
            .map(|i| list[i].id.clone())
            .unwrap_or_else(|| next_id("preset")),
        name: name.to_string(),
        mod_name: clean_mod_name,
        character_folder: character_folder.to_string(),
        active_ini_files: clean_active_inis,
        variables: Some(snapshot_vars),
        is_active: None,
        is_pending: None,
        updated_at: now_ms(),
    };

    if let Some(i) = existing_idx {
        list[i] = new_preset;
    } else {
        list.push(new_preset);
    }

    if let Err(err) = write_json_atomic(&file_path, &list) {
        return SaveModPresetResult {
            ok: false,
            reloaded: None,
            error: Some(err),
            synced_f10: None,
            possible_stale: None,
            stale_reason: None,
        };
    }

    SaveModPresetResult {
        ok: true,
        reloaded: None,
        error: None,
        synced_f10: Some(false),
        possible_stale: None,
        stale_reason: None,
    }
}

fn sync_mod_ini_activation(mod_path: &Path, desired_active_norm: &HashSet<String>) {
    fn walk(cur: &Path, rel: &str, desired: &HashSet<String>) {
        let Ok(entries) = fs::read_dir(cur) else {
            return;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let full = entry.path();
            let next_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if full.is_dir() {
                walk(&full, &next_rel, desired);
                continue;
            }
            if !full.is_file() {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".ini") && lower != "desktop.ini" {
                let clean_name = strip_disabled_prefix(&name);
                let rel_norm = normalize_ini_rel_clean(&next_rel).to_ascii_lowercase();
                let should_be_active = desired.is_empty() || desired.contains(&rel_norm);
                let is_disabled = starts_with_disabled_ci(&name);
                if should_be_active && is_disabled {
                    let _ = fs::rename(&full, cur.join(clean_name));
                } else if !should_be_active && !is_disabled {
                    let _ = fs::rename(&full, cur.join(format!("DISABLED_{name}")));
                }
            }
        }
    }
    walk(mod_path, "", desired_active_norm);
}

pub fn apply_mod_preset(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    mod_path: &Path,
    mods_path: &Path,
    preset_id: &str,
    skip_bridge: bool,
    global_ignore_rules: &[String],
    pending: &mut PendingQueueState,
) -> ToggleResult {
    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let mut list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();
    let mut target = list
        .iter()
        .find(|p| p.id == preset_id || (preset_id == "default" && p.id == "__default__"))
        .cloned();
    if target.is_none() {
        list = get_mod_presets(
            base_dir,
            game_id,
            character_folder,
            mod_folder,
            Some(mod_path),
            Some(mods_path),
            global_ignore_rules,
            pending,
        );
        target = list
            .into_iter()
            .find(|p| p.id == preset_id || (preset_id == "default" && p.id == "__default__"));
    }
    let Some(target_preset) = target else {
        return ToggleResult::err("Preset not found");
    };
    if !mod_path.is_dir() {
        return ToggleResult::err("Mod folder does not exist");
    }

    let clean_mod_name = strip_disabled_prefix(mod_folder).to_string();
    let desired_active_norm: HashSet<String> = target_preset
        .active_ini_files
        .iter()
        .map(|f| f.replace('\\', "/").to_ascii_lowercase())
        .collect();
    sync_mod_ini_activation(mod_path, &desired_active_norm);

    let mut merged_vars = inspect_mod_default_variables(mod_path);
    if let Some(preset_vars) = &target_preset.variables {
        for (k, v) in preset_vars {
            merged_vars.insert(k.clone(), v.clone());
        }
    }
    let local_ignore_rules = read_local_ignore_rules(mod_path).1;
    merged_vars.retain(|k, _| {
        !classify_variable_filter(k, global_ignore_rules, &local_ignore_rules).0
    });

    if !merged_vars.is_empty() {
        apply_variables_to_d3dx_user_ini(mods_path, &merged_vars, character_folder, mod_folder);
    }

    let q_key = make_queue_key(game_id, character_folder, mod_folder);
    pending.preset_queue.insert(
        q_key,
        PendingPresetEntry {
            preset_id: preset_id.to_string(),
            character_folder: character_folder.to_string(),
            clean_mod_name,
            mods_path: mods_path.to_string_lossy().to_string(),
            variables: merged_vars,
            reloading: false,
        },
    );

    if !skip_bridge {
        sync_bridge_file_from_queue(mods_path, game_id, pending);
    }
    ToggleResult::ok()
}

pub fn delete_mod_preset(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    preset_id: &str,
) -> ToggleResult {
    if preset_id == "__default__" {
        return ToggleResult::err("Default baseline preset cannot be deleted");
    }
    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();
    let filtered: Vec<ModVariantPreset> =
        list.into_iter().filter(|p| p.id != preset_id).collect();
    match write_json_atomic(&file_path, &filtered) {
        Ok(()) => ToggleResult::ok(),
        Err(err) => ToggleResult::err(err),
    }
}

pub fn build_mod_preset_export_data(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    preset_id: Option<&str>,
) -> Result<(ModPresetExportFile, String), String> {
    let clean_mod_name = strip_disabled_prefix(mod_folder).to_string();
    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();

    let (selected, default_name) = if let Some(pid) = preset_id.filter(|s| *s != "all" && !s.is_empty()) {
        let target = list
            .iter()
            .find(|p| p.id == pid)
            .ok_or_else(|| "Preset not found".to_string())?;
        if target.id == "__default__" {
            return Err("Default baseline preset does not need export".to_string());
        }
        (
            vec![target.clone()],
            sanitize_filename(&format!("{clean_mod_name}_{}.moddeck-preset.json", target.name)),
        )
    } else {
        let custom: Vec<ModVariantPreset> =
            list.into_iter().filter(|p| p.id != "__default__").collect();
        if custom.is_empty() {
            return Err("No custom presets available to export for this mod".to_string());
        }
        (
            custom,
            sanitize_filename(&format!("{clean_mod_name}_presets.moddeck-preset.json")),
        )
    };

    let export_file = ModPresetExportFile {
        moddeck_file_type: "mod-preset".to_string(),
        version: 1,
        game_id: game_id.to_string(),
        character_folder: character_folder.to_string(),
        mod_name: clean_mod_name,
        exported_at: now_ms(),
        presets: selected
            .into_iter()
            .map(|p| ModPresetExportItem {
                name: p.name,
                active_ini_files: p.active_ini_files,
                variables: p.variables.unwrap_or_default(),
            })
            .collect(),
    };
    Ok((export_file, default_name))
}

pub fn import_mod_presets_from_file(
    base_dir: &Path,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
    source_file_path: &Path,
) -> ImportPresetsResult {
    let clean_mod_name = strip_disabled_prefix(mod_folder).to_string();
    let Ok(raw) = fs::read_to_string(source_file_path) else {
        return ImportPresetsResult {
            ok: false,
            error: Some("Failed to read preset file".to_string()),
            count: None,
            names: None,
        };
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return ImportPresetsResult {
            ok: false,
            error: Some("Preset file is not valid JSON".to_string()),
            count: None,
            names: None,
        };
    };

    let mut incoming: Vec<ModPresetExportItem> = Vec::new();
    if parsed.get("moddeckFileType").and_then(|v| v.as_str()) == Some("mod-preset") {
        if let Some(arr) = parsed.get("presets") {
            if let Ok(items) = serde_json::from_value::<Vec<ModPresetExportItem>>(arr.clone()) {
                incoming.extend(items);
            }
        }
    } else if parsed.is_array() {
        if let Ok(items) = serde_json::from_value::<Vec<ModPresetExportItem>>(parsed) {
            incoming.extend(items);
        }
    } else if parsed.get("name").is_some()
        && (parsed.get("variables").is_some() || parsed.get("activeIniFiles").is_some())
    {
        if let Ok(item) = serde_json::from_value::<ModPresetExportItem>(parsed) {
            incoming.push(item);
        }
    } else {
        return ImportPresetsResult {
            ok: false,
            error: Some("No compatible ModDeck preset data found in file".to_string()),
            count: None,
            names: None,
        };
    }

    if incoming.is_empty() {
        return ImportPresetsResult {
            ok: false,
            error: Some("Preset file contains no valid items".to_string()),
            count: None,
            names: None,
        };
    }

    let file_path = mod_preset_file_path(base_dir, game_id, character_folder, mod_folder);
    let mut list: Vec<ModVariantPreset> = read_json_file(&file_path).unwrap_or_default();
    let mut imported_names = Vec::new();

    for item in incoming {
        let raw_name = item.name.trim();
        if raw_name.is_empty() || raw_name == "默认" {
            continue;
        }
        let mut final_name = raw_name.to_string();
        let mut counter = 1usize;
        while list.iter().any(|p| p.name.eq_ignore_ascii_case(&final_name)) {
            final_name = format!("{raw_name} ({counter})");
            counter += 1;
        }
        list.push(ModVariantPreset {
            id: next_id("preset"),
            name: final_name.clone(),
            mod_name: clean_mod_name.clone(),
            character_folder: character_folder.to_string(),
            active_ini_files: item.active_ini_files,
            variables: Some(item.variables),
            is_active: None,
            is_pending: None,
            updated_at: now_ms(),
        });
        imported_names.push(final_name);
    }

    if imported_names.is_empty() {
        return ImportPresetsResult {
            ok: false,
            error: Some("No valid presets imported".to_string()),
            count: None,
            names: None,
        };
    }

    if let Err(err) = write_json_atomic(&file_path, &list) {
        return ImportPresetsResult {
            ok: false,
            error: Some(err),
            count: None,
            names: None,
        };
    }

    ImportPresetsResult {
        ok: true,
        error: None,
        count: Some(imported_names.len()),
        names: Some(imported_names),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RosterPresetsStore {
    schema_version: u32,
    presets: HashMap<String, Vec<RosterPreset>>,
}

impl Default for RosterPresetsStore {
    fn default() -> Self {
        Self {
            schema_version: 1,
            presets: HashMap::new(),
        }
    }
}

fn load_roster_presets_store(base_dir: &Path) -> RosterPresetsStore {
    read_json_file(&base_dir.join(ROSTER_PRESETS_FILE)).unwrap_or_default()
}

fn save_roster_presets_store(base_dir: &Path, store: &RosterPresetsStore) -> Result<(), String> {
    write_json_atomic(&base_dir.join(ROSTER_PRESETS_FILE), store)
}

fn get_assignment_mod_items(assignment: &CharacterModAssignment) -> Vec<ModAssignmentItem> {
    if let Some(mods) = &assignment.mods {
        if !mods.is_empty() {
            return mods
                .iter()
                .filter(|m| !m.mod_name.trim().is_empty())
                .cloned()
                .collect();
        }
    }
    if let Some(mod_name) = &assignment.mod_name {
        if !mod_name.trim().is_empty() {
            return vec![ModAssignmentItem {
                mod_name: mod_name.clone(),
                preset_id: assignment.preset_id.clone(),
            }];
        }
    }
    Vec::new()
}

pub fn get_roster_presets(base_dir: &Path, game_id: &str) -> Vec<RosterPreset> {
    let store = load_roster_presets_store(base_dir);
    store.presets.get(game_id).cloned().unwrap_or_default()
}

pub fn save_roster_preset(
    base_dir: &Path,
    game_id: &str,
    input: &SaveRosterPresetInput,
) -> ToggleResult {
    let name = input.name.trim();
    if name.is_empty() {
        return ToggleResult::err("Scheme name cannot be empty");
    }
    let mut store = load_roster_presets_store(base_dir);
    let list = store.presets.entry(game_id.to_string()).or_default();
    let existing_idx = list.iter().position(|p| p.name.eq_ignore_ascii_case(name));
    let new_preset = RosterPreset {
        id: existing_idx
            .map(|i| list[i].id.clone())
            .unwrap_or_else(|| next_id("roster")),
        name: name.to_string(),
        game_id: game_id.to_string(),
        updated_at: now_ms(),
        assignments: input.assignments.clone(),
    };
    if let Some(i) = existing_idx {
        list[i] = new_preset;
    } else {
        list.push(new_preset);
    }
    match save_roster_presets_store(base_dir, &store) {
        Ok(()) => ToggleResult::ok(),
        Err(err) => ToggleResult::err(err),
    }
}

pub fn delete_roster_preset(base_dir: &Path, game_id: &str, preset_id: &str) -> ToggleResult {
    let mut store = load_roster_presets_store(base_dir);
    let list = store.presets.entry(game_id.to_string()).or_default();
    let prev_len = list.len();
    list.retain(|p| p.id != preset_id);
    if list.len() == prev_len {
        return ToggleResult::err("Scheme not found");
    }
    match save_roster_presets_store(base_dir, &store) {
        Ok(()) => ToggleResult::ok(),
        Err(err) => ToggleResult::err(err),
    }
}

pub fn apply_roster_preset(
    base_dir: &Path,
    game_id: &str,
    mods_path: &Path,
    preset_id: &str,
    global_ignore_rules: &[String],
    pending: &mut PendingQueueState,
) -> ToggleResult {
    let store = load_roster_presets_store(base_dir);
    let Some(preset) = store
        .presets
        .get(game_id)
        .and_then(|list| list.iter().find(|p| p.id == preset_id))
        .cloned()
    else {
        return ToggleResult::err("Scheme not found");
    };

    pending.clear_mod_toggles(Some(game_id));

    for (char_folder, assignment) in &preset.assignments {
        if !is_safe_segment(char_folder) {
            continue;
        }
        let Ok(char_dir) = resolve_character_dir(mods_path, char_folder) else {
            continue;
        };
        if !char_dir.is_dir() {
            continue;
        }
        let items = get_assignment_mod_items(assignment);
        let target_map: HashMap<String, ModAssignmentItem> = items
            .into_iter()
            .map(|it| (it.mod_name.to_ascii_lowercase(), it))
            .collect();

        let Ok(entries) = fs::read_dir(&char_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let src_path = entry.path();
            if !src_path.is_dir() {
                continue;
            }
            let Some(dir_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if dir_name.starts_with('.') {
                continue;
            }
            let clean_mod_name = strip_disabled_prefix(&dir_name).to_string();
            let target_item = target_map.get(&clean_mod_name.to_ascii_lowercase());
            let should_enable = target_item.is_some();
            let is_disabled = starts_with_disabled_ci(&dir_name);

            let mut active_path = src_path.clone();
            if should_enable && is_disabled {
                let dest = char_dir.join(&clean_mod_name);
                if fs::rename(&src_path, &dest).is_ok() {
                    active_path = dest;
                }
            } else if !should_enable && !is_disabled {
                let dest = char_dir.join(format!("DISABLED_{clean_mod_name}"));
                if fs::rename(&src_path, &dest).is_ok() {
                    active_path = dest;
                }
            }

            if let Some(pid) = target_item.and_then(|it| it.preset_id.as_deref()) {
                let _ = apply_mod_preset(
                    base_dir,
                    game_id,
                    char_folder,
                    &clean_mod_name,
                    &active_path,
                    mods_path,
                    pid,
                    true,
                    global_ignore_rules,
                    pending,
                );
            }
        }
    }

    sync_bridge_file_from_queue(mods_path, game_id, pending);
    ToggleResult::ok()
}

pub fn build_roster_preset_export_data(
    base_dir: &Path,
    game_id: &str,
    preset_id: &str,
) -> Result<(RosterPresetExportFile, String), String> {
    let store = load_roster_presets_store(base_dir);
    let preset = store
        .presets
        .get(game_id)
        .and_then(|list| list.iter().find(|p| p.id == preset_id))
        .ok_or_else(|| "Scheme not found".to_string())?;

    let mut assignments = HashMap::new();
    for (char_folder, assignment) in &preset.assignments {
        let items = get_assignment_mod_items(assignment);
        let mut mods = Vec::new();
        for it in items {
            let clean_mod = strip_disabled_prefix(&it.mod_name).to_string();
            let mut preset_name: Option<String> = None;
            let mut preset_variables: Option<HashMap<String, String>> = None;
            let mut preset_active_inis: Option<Vec<String>> = None;

            if let Some(pid) = &it.preset_id {
                if pid == "__default__" || pid == "default" {
                    preset_name = Some("默认".to_string());
                } else {
                    let mod_file = mod_preset_file_path(base_dir, game_id, char_folder, &clean_mod);
                    let list: Vec<ModVariantPreset> = read_json_file(&mod_file).unwrap_or_default();
                    if let Some(p) = list.into_iter().find(|x| x.id == *pid) {
                        preset_name = Some(p.name);
                        preset_variables = p.variables;
                        preset_active_inis = Some(p.active_ini_files);
                    }
                }
            }

            mods.push(RosterPresetExportMod {
                mod_name: clean_mod,
                preset_id: it.preset_id,
                preset_name,
                preset_variables,
                preset_active_inis,
            });
        }
        assignments.insert(char_folder.clone(), RosterPresetExportAssignment { mods });
    }

    let default_name = sanitize_filename(&format!("{}.moddeck-scheme.json", preset.name));
    let export_file = RosterPresetExportFile {
        moddeck_file_type: "roster-scheme".to_string(),
        version: 1,
        game_id: game_id.to_string(),
        exported_at: now_ms(),
        scheme: RosterPresetExportScheme {
            name: preset.name.clone(),
            game_id: game_id.to_string(),
            assignments,
        },
    };
    Ok((export_file, default_name))
}

fn empty_roster_inspection(err: impl Into<String>) -> RosterSchemeImportInspection {
    RosterSchemeImportInspection {
        ok: false,
        error: Some(err.into()),
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
    }
}

pub fn inspect_roster_preset_file_content(
    game_id: &str,
    mods_path: &Path,
    source_file_path: &Path,
) -> RosterSchemeImportInspection {
    let Ok(raw) = fs::read_to_string(source_file_path) else {
        return empty_roster_inspection("Failed to read scheme file");
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return empty_roster_inspection("Scheme file is not valid JSON");
    };
    let scheme_val = parsed.get("scheme").unwrap_or(&parsed);
    let Some(assignments_obj) = scheme_val.get("assignments").and_then(|v| v.as_object()) else {
        return empty_roster_inspection("Scheme file does not contain valid assignments");
    };

    let source_game_id = parsed
        .get("gameId")
        .or_else(|| scheme_val.get("gameId"))
        .and_then(|v| v.as_str())
        .unwrap_or(game_id)
        .to_string();
    let fallback_name = source_file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Scheme");
    let scheme_name = scheme_val
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_name)
        .to_string();

    let mut missing_characters = Vec::new();
    let mut missing_mods = Vec::new();
    let mut matched_items = Vec::new();
    let mut total_characters = 0usize;
    let mut matched_characters = 0usize;
    let mut total_mods = 0usize;
    let mut matched_mods = 0usize;

    for (char_folder, assignment_val) in assignments_obj {
        if !is_safe_segment(char_folder) {
            continue;
        }
        total_characters += 1;

        let Ok(assignment) =
            serde_json::from_value::<RosterPresetExportAssignment>(assignment_val.clone())
        else {
            continue;
        };
        let items: Vec<(String, Option<String>)> = if !assignment.mods.is_empty() {
            assignment
                .mods
                .into_iter()
                .map(|m| (m.mod_name, m.preset_name))
                .collect()
        } else if let Ok(legacy) =
            serde_json::from_value::<CharacterModAssignment>(assignment_val.clone())
        {
            get_assignment_mod_items(&legacy)
                .into_iter()
                .map(|m| (m.mod_name, None))
                .collect()
        } else {
            Vec::new()
        };

        let char_dir_opt = resolve_character_dir(mods_path, char_folder).ok();
        let char_exists = char_dir_opt.as_ref().map(|d| d.is_dir()).unwrap_or(false);
        if !char_exists {
            missing_characters.push(char_folder.clone());
            for (mod_name, _) in items {
                total_mods += 1;
                missing_mods.push(RosterMissingMod {
                    character_folder: char_folder.clone(),
                    mod_name,
                });
            }
            continue;
        }

        matched_characters += 1;
        let char_dir = char_dir_opt.unwrap();
        let mut disk_clean_mods = HashSet::new();
        if let Ok(entries) = fs::read_dir(&char_dir) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    if let Some(n) = e.file_name().to_str() {
                        disk_clean_mods.insert(strip_disabled_prefix(n).to_ascii_lowercase());
                    }
                }
            }
        }

        for (raw_mod, preset_name) in items {
            total_mods += 1;
            let clean_mod = strip_disabled_prefix(&raw_mod).to_string();
            if disk_clean_mods.contains(&clean_mod.to_ascii_lowercase()) {
                matched_mods += 1;
                matched_items.push(RosterMatchedItem {
                    character_folder: char_folder.clone(),
                    mod_name: clean_mod,
                    preset_name,
                });
            } else {
                missing_mods.push(RosterMissingMod {
                    character_folder: char_folder.clone(),
                    mod_name: clean_mod,
                });
            }
        }
    }

    RosterSchemeImportInspection {
        ok: true,
        error: None,
        scheme_name: Some(scheme_name),
        source_game_id: Some(source_game_id),
        target_game_id: Some(game_id.to_string()),
        total_characters,
        matched_characters,
        total_mods,
        matched_mods,
        missing_characters,
        missing_mods,
        matched_items,
        raw_export: Some(parsed),
    }
}

pub fn confirm_import_roster_preset(
    base_dir: &Path,
    game_id: &str,
    raw_export: &Value,
    custom_name: Option<&str>,
) -> ImportRosterResult {
    let scheme_val = raw_export.get("scheme").unwrap_or(raw_export);
    let Some(assignments_obj) = scheme_val.get("assignments").and_then(|v| v.as_object()) else {
        return ImportRosterResult {
            ok: false,
            error: Some("Incomplete scheme data".to_string()),
            scheme_id: None,
            scheme_name: None,
        };
    };

    let base_name = custom_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            scheme_val
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("Imported Scheme")
        .to_string();

    let mut store = load_roster_presets_store(base_dir);
    let list = store.presets.entry(game_id.to_string()).or_default();

    let mut final_name = base_name.clone();
    let mut counter = 1usize;
    while list.iter().any(|p| p.name.eq_ignore_ascii_case(&final_name)) {
        final_name = format!("{base_name} ({counter})");
        counter += 1;
    }

    let mut final_assignments = HashMap::new();
    for (char_folder, assignment_val) in assignments_obj {
        let mut raw_mods: Vec<RosterPresetExportMod> = Vec::new();
        if let Ok(enhanced) =
            serde_json::from_value::<RosterPresetExportAssignment>(assignment_val.clone())
        {
            if !enhanced.mods.is_empty() {
                raw_mods = enhanced.mods;
            }
        }
        if raw_mods.is_empty() {
            if let Ok(legacy) =
                serde_json::from_value::<CharacterModAssignment>(assignment_val.clone())
            {
                raw_mods = get_assignment_mod_items(&legacy)
                    .into_iter()
                    .map(|m| RosterPresetExportMod {
                        mod_name: m.mod_name,
                        preset_id: m.preset_id,
                        preset_name: None,
                        preset_variables: None,
                        preset_active_inis: None,
                    })
                    .collect();
            }
        }

        let mut processed = Vec::new();
        for it in raw_mods {
            let clean_mod = strip_disabled_prefix(&it.mod_name).to_string();
            let mut assigned_preset_id = it.preset_id.clone();

            if let (Some(p_name), Some(p_vars)) = (it.preset_name.as_deref(), it.preset_variables) {
                if p_name != "默认" && !p_vars.is_empty() {
                    let mod_file = mod_preset_file_path(base_dir, game_id, char_folder, &clean_mod);
                    let mut local_presets: Vec<ModVariantPreset> =
                        read_json_file(&mod_file).unwrap_or_default();
                    if let Some(existing) = local_presets
                        .iter()
                        .find(|p| p.name.eq_ignore_ascii_case(p_name))
                    {
                        assigned_preset_id = Some(existing.id.clone());
                    } else {
                        let new_pid = next_id("preset");
                        local_presets.push(ModVariantPreset {
                            id: new_pid.clone(),
                            name: p_name.to_string(),
                            mod_name: clean_mod.clone(),
                            character_folder: char_folder.clone(),
                            active_ini_files: it.preset_active_inis.unwrap_or_default(),
                            variables: Some(p_vars),
                            is_active: None,
                            is_pending: None,
                            updated_at: now_ms(),
                        });
                        let _ = write_json_atomic(&mod_file, &local_presets);
                        assigned_preset_id = Some(new_pid);
                    }
                }
            }

            processed.push(ModAssignmentItem {
                mod_name: clean_mod,
                preset_id: assigned_preset_id,
            });
        }

        let first = processed.first().cloned();
        final_assignments.insert(
            char_folder.clone(),
            CharacterModAssignment {
                mod_name: first.as_ref().map(|m| m.mod_name.clone()),
                preset_id: first.and_then(|m| m.preset_id),
                mods: Some(processed),
            },
        );
    }

    let scheme_id = next_id("roster");
    list.push(RosterPreset {
        id: scheme_id.clone(),
        name: final_name.clone(),
        game_id: game_id.to_string(),
        updated_at: now_ms(),
        assignments: final_assignments,
    });

    if let Err(err) = save_roster_presets_store(base_dir, &store) {
        return ImportRosterResult {
            ok: false,
            error: Some(err),
            scheme_id: None,
            scheme_name: None,
        };
    }

    ImportRosterResult {
        ok: true,
        error: None,
        scheme_id: Some(scheme_id),
        scheme_name: Some(final_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_and_roster_preset_roundtrip_and_bridge_write() {
        let root = std::env::temp_dir().join(format!("moddeck-preset-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let importer_dir = root.join("EFMI");
        let mods_dir = importer_dir.join("Mods");
        let mod_dir = mods_dir.join("Anke").join("SummerSkin");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(
            importer_dir.join("d3dx_user.ini"),
            "$\\mods\\Anke\\SummerSkin\\mod.ini\\color = 2\r\n",
        )
        .unwrap();
        fs::write(
            mod_dir.join("mod.ini"),
            "[Constants]\r\nglobal persist $color = 0\r\n",
        )
        .unwrap();

        let mut pending = PendingQueueState::default();
        let initial = get_mod_presets(
            &base_dir,
            "wuthering-waves",
            "Anke",
            "SummerSkin",
            Some(&mod_dir),
            Some(&mods_dir),
            &[],
            &pending,
        );
        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0].id, "__default__");

        let save_res = save_mod_preset(
            &base_dir,
            "wuthering-waves",
            "Anke",
            "SummerSkin",
            &mod_dir,
            &mods_dir,
            "BlueVariant",
            &[],
            &mut pending,
        );
        assert!(save_res.ok, "{:?}", save_res.error);

        let after = get_mod_presets(
            &base_dir,
            "wuthering-waves",
            "Anke",
            "SummerSkin",
            Some(&mod_dir),
            Some(&mods_dir),
            &[],
            &pending,
        );
        assert_eq!(after.len(), 2);
        let blue = after.iter().find(|p| p.name == "BlueVariant").unwrap();
        assert_eq!(blue.is_active, Some(true));

        // Apply __default__ preset and check d3dx_user.ini + bridge.ini + pending count
        let apply_res = apply_mod_preset(
            &base_dir,
            "wuthering-waves",
            "Anke",
            "SummerSkin",
            &mod_dir,
            &mods_dir,
            "__default__",
            false,
            &[],
            &mut pending,
        );
        assert!(apply_res.ok, "{:?}", apply_res.error);
        assert_eq!(pending.pending_count(Some("wuthering-waves")), 1);
        assert!(mods_dir.join(BRIDGE_FOLDER_NAME).join(BRIDGE_FILE_NAME).is_file());
        let user_ini_after = fs::read_to_string(importer_dir.join("d3dx_user.ini")).unwrap();
        assert!(user_ini_after.contains("= 0"));

        // Save, export, inspect, and re-import roster preset
        let mut assignments = HashMap::new();
        assignments.insert(
            "Anke".to_string(),
            CharacterModAssignment {
                mod_name: Some("SummerSkin".to_string()),
                preset_id: Some(blue.id.clone()),
                mods: Some(vec![ModAssignmentItem {
                    mod_name: "SummerSkin".to_string(),
                    preset_id: Some(blue.id.clone()),
                }]),
            },
        );
        let save_roster = save_roster_preset(
            &base_dir,
            "wuthering-waves",
            &SaveRosterPresetInput {
                name: "AbyssTeam".to_string(),
                assignments,
            },
        );
        assert!(save_roster.ok);
        let roster_list = get_roster_presets(&base_dir, "wuthering-waves");
        assert_eq!(roster_list.len(), 1);
        let (exported, _) =
            build_roster_preset_export_data(&base_dir, "wuthering-waves", &roster_list[0].id)
                .unwrap();
        let scheme_path = root.join("scheme.moddeck-scheme.json");
        write_json_atomic(&scheme_path, &exported).unwrap();
        let inspected =
            inspect_roster_preset_file_content("wuthering-waves", &mods_dir, &scheme_path);
        assert!(inspected.ok);
        assert_eq!(inspected.matched_mods, 1);

        let _ = fs::remove_dir_all(&root);
    }
}
