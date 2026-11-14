use crate::models::{
    CharacterInfo, CharacterMeta, GameDef, GameSettings, GameSnapshot, MetadataStore, ModDetails,
    ModInfo, Settings,
};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const CHARACTER_COVER_NAMES: &[&str] = &[
    ".preview.png",
    ".preview.jpg",
    ".preview.jpeg",
    ".preview.webp",
    "_cover.png",
    "_cover.jpg",
    "_cover.jpeg",
    "_cover.webp",
];

const IGNORED_PREVIEW_SUBDIRS: &[&str] = &[
    "res",
    "textures",
    "texture",
    "tex",
    "hlsl",
    "meshes",
    "mesh",
    "buffer",
    "buffers",
    "tattoos",
    "shaderfixes",
    "shaders",
];

#[derive(Debug, Clone, Deserialize)]
struct RosterEntry {
    zh: String,
    en: String,
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RosterFile {
    games: HashMap<String, Vec<RosterEntry>>,
}

pub fn load_builtin_roster_map() -> HashMap<String, Vec<String>> {
    let parsed: RosterFile =
        serde_json::from_str(include_str!("../../roster.json")).unwrap_or(RosterFile {
            games: HashMap::new(),
        });
    parsed
        .games
        .into_iter()
        .map(|(k, v)| (k, v.into_iter().map(|e| e.zh).collect()))
        .collect()
}

fn find_canonical_en(game_id: &str, token: &str) -> Option<String> {
    let parsed: RosterFile =
        serde_json::from_str(include_str!("../../roster.json")).ok()?;
    let list = parsed.games.get(game_id)?;
    let lower = token.trim().to_lowercase();
    for entry in list {
        if entry.zh.to_lowercase() == lower
            || entry.en.to_lowercase() == lower
            || entry.aliases.iter().any(|a| a.to_lowercase() == lower)
        {
            return Some(entry.en.clone());
        }
    }
    None
}

pub fn asset_url(abs_path: &Path) -> String {
    let raw = abs_path.to_string_lossy();
    let encoded = utf8_percent_encode(&raw, NON_ALPHANUMERIC).to_string();
    format!("http://moddeck.localhost/asset?p={encoded}")
}

pub fn decode_asset_query(query: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some(val) = pair.strip_prefix("p=") {
            let plus_fixed = val.replace('+', " ");
            return percent_decode_str(&plus_fixed)
                .decode_utf8()
                .ok()
                .map(|s| s.to_string());
        }
    }
    None
}

pub fn is_safe_segment(seg: &str) -> bool {
    if seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.') {
        return false;
    }
    !seg.chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '\0' | '*' | '?' | '"' | '<' | '>' | '|'))
}

pub fn is_inside(parent: &Path, child: &Path) -> bool {
    let p_norm = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let c_norm = fs::canonicalize(child).unwrap_or_else(|_| child.to_path_buf());
    c_norm.starts_with(&p_norm)
}

pub fn is_supported_image_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "avif")
    )
}

pub fn is_allowed_asset_path(base_dir: &Path, settings: &Settings, candidate: &Path) -> bool {
    if !is_supported_image_ext(candidate) || !candidate.is_file() {
        return false;
    }
    let covers_dir = base_dir.join("covers");
    if covers_dir.is_dir() && is_inside(&covers_dir, candidate) {
        return true;
    }
    for gs in settings.games.values() {
        if !gs.mods_path.is_empty() {
            let mp = Path::new(&gs.mods_path);
            if mp.is_dir() && is_inside(mp, candidate) {
                return true;
            }
        }
    }
    false
}

fn is_legacy_container(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "character" | "characters")
}

fn ignored_character_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('_')
}

fn ignored_mod_name(name: &str) -> bool {
    name.starts_with('.')
}

pub fn resolve_character_base(mods_path: &Path) -> PathBuf {
    if let Ok(entries) = fs::read_dir(mods_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    if is_legacy_container(name) {
                        if let Ok(children) = fs::read_dir(&path) {
                            if children.flatten().any(|c| c.path().is_dir()) {
                                return path;
                            }
                        }
                    }
                }
            }
        }
    }
    mods_path.to_path_buf()
}

pub fn resolve_character_dir(mods_path: &Path, character_folder: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(character_folder) {
        return Err(format!("Invalid character folder name: {character_folder}"));
    }
    let base = resolve_character_base(mods_path);
    let target = base.join(character_folder);
    if !is_inside(&base, &target) {
        return Err("Character folder path out of bounds".into());
    }
    if !target.is_dir() {
        return Err(format!("Character folder does not exist: {character_folder}"));
    }
    Ok(target)
}

fn inspect_mod_ini_status(dir: &Path, max_depth: usize) -> (bool, bool, bool) {
    let mut has_ini = false;
    let mut has_active_ini = false;
    let mut has_disabled_ini = false;

    for entry in WalkDir::new(dir)
        .max_depth(max_depth + 1)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_name()
                    .to_str()
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(false)
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(s) => s,
            None => continue,
        };
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".ini") || lower == "desktop.ini" {
            continue;
        }
        has_ini = true;
        if lower.starts_with("disabled_") {
            has_disabled_ini = true;
        } else {
            has_active_ini = true;
        }
    }

    (has_ini, has_active_ini, has_disabled_ini)
}

fn is_mod_effectively_enabled(folder_name: &str, mod_path: &Path) -> bool {
    if folder_name.to_ascii_lowercase().starts_with("disabled_") {
        return false;
    }
    let (_has_ini, has_active, has_disabled) = inspect_mod_ini_status(mod_path, 2);
    if has_disabled && !has_active {
        return false;
    }
    true
}

fn find_character_cover_file(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut files: HashMap<String, String> = HashMap::new();
    for entry in entries.flatten() {
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                files.insert(name.to_ascii_lowercase(), name.to_string());
            }
        }
    }
    for cover_name in CHARACTER_COVER_NAMES {
        if let Some(actual) = files.get(*cover_name) {
            return Some(dir.join(actual));
        }
    }
    None
}

fn is_preview_keyword(lower_name: &str) -> bool {
    ["preview", "cover", "thumbnail", "thumb", "screen", "screenshot", "showcase"]
        .iter()
        .any(|kw| lower_name.contains(kw))
}

fn is_regular_preview_prefix(lower_name: &str) -> bool {
    ["preview", "cover", "thumbnail", "thumb", "screen", "screenshot", "showcase"]
        .iter()
        .any(|kw| lower_name.starts_with(kw))
}

fn pick_preferred_image(names: &[String], allow_fallback_any: bool) -> Option<String> {
    let regular: Vec<&String> = names.iter().filter(|n| !n.starts_with('.')).collect();
    let dotted: Vec<&String> = names.iter().filter(|n| n.starts_with('.')).collect();

    if let Some(found) = regular
        .iter()
        .find(|n| is_regular_preview_prefix(&n.to_ascii_lowercase()))
    {
        return Some((*found).clone());
    }
    if let Some(found) = dotted
        .iter()
        .find(|n| is_preview_keyword(&n.to_ascii_lowercase()))
    {
        return Some((*found).clone());
    }
    if !allow_fallback_any {
        return None;
    }
    if let Some(first) = regular.first() {
        return Some((*first).clone());
    }
    if let Some(first) = dotted.first() {
        return Some((*first).clone());
    }
    None
}

fn list_supported_images(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with("._") && is_supported_image_ext(&p) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    names
}

fn find_mod_preview(dir: &Path) -> Option<PathBuf> {
    let root_images = list_supported_images(dir);
    for exact in [
        ".preview.png",
        ".preview.jpg",
        ".preview.jpeg",
        ".preview.webp",
        ".preview.gif",
        ".preview.avif",
    ] {
        if let Some(actual) = root_images.iter().find(|n| n.eq_ignore_ascii_case(exact)) {
            return Some(dir.join(actual));
        }
    }
    if let Some(picked) = pick_preferred_image(&root_images, true) {
        return Some(dir.join(picked));
    }

    // Check immediate subdirectories (excluding texture/buffer asset folders)
    let ignored: HashSet<&str> = IGNORED_PREVIEW_SUBDIRS.iter().copied().collect();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let sub = entry.path();
            if !sub.is_dir() {
                continue;
            }
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with('.') || ignored.contains(name.to_ascii_lowercase().as_str()) {
                continue;
            }
            let sub_images = list_supported_images(&sub);
            if let Some(picked) = pick_preferred_image(&sub_images, false) {
                return Some(sub.join(picked));
            }
        }
    }
    None
}

fn mtime_ms(path: &Path) -> f64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn get_meta<'a>(
    metadata: &'a MetadataStore,
    game_id: &str,
    folder: &str,
) -> Option<&'a CharacterMeta> {
    metadata.games.get(game_id).and_then(|m| m.get(folder))
}

pub fn build_snapshot(
    base_dir: &Path,
    game: &GameDef,
    game_settings: &GameSettings,
    metadata: &MetadataStore,
    settings: &Settings,
) -> GameSnapshot {
    let mods_path = Path::new(&game_settings.mods_path);
    let exists = !game_settings.mods_path.is_empty() && mods_path.is_dir();
    if !exists {
        return GameSnapshot {
            game: game.clone(),
            settings: game_settings.clone(),
            characters: Vec::new(),
            total_mods: 0,
            enabled_mods: 0,
            mods_path_exists: false,
        };
    }

    let base = resolve_character_base(mods_path);
    let mut characters = Vec::new();
    let custom_order = settings
        .character_orders
        .get(&game.id)
        .cloned()
        .unwrap_or_default();

    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            let char_path = entry.path();
            if !char_path.is_dir() {
                continue;
            }
            let folder = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if is_legacy_container(&folder) || ignored_character_name(&folder) {
                continue;
            }

            let meta = get_meta(metadata, &game.id, &folder);
            if meta.and_then(|m| m.hidden).unwrap_or(false) && !settings.ui.show_hidden {
                continue;
            }

            let mut mod_count = 0usize;
            let mut enabled_count = 0usize;
            if let Ok(children) = fs::read_dir(&char_path) {
                for child in children.flatten() {
                    let mod_path = child.path();
                    if !mod_path.is_dir() {
                        continue;
                    }
                    let child_name = match child.file_name().to_str() {
                        Some(n) => n.to_string(),
                        None => continue,
                    };
                    if ignored_mod_name(&child_name) {
                        continue;
                    }
                    mod_count += 1;
                    if is_mod_effectively_enabled(&child_name, &mod_path) {
                        enabled_count += 1;
                    }
                }
            }

            let display_name = meta
                .and_then(|m| m.display_name.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| folder.clone());

            let canonical_en_name = meta
                .and_then(|m| m.canonical_en_name.clone())
                .or_else(|| find_canonical_en(&game.id, &folder))
                .or_else(|| find_canonical_en(&game.id, &display_name));

            let mut cover_url = meta
                .and_then(|m| m.cover_file.as_ref())
                .and_then(|cf| {
                    let abs = base_dir.join("covers").join(&game.id).join(cf);
                    if abs.is_file() {
                        Some(asset_url(&abs))
                    } else {
                        None
                    }
                });
            if cover_url.is_none() {
                if let Some(local_cover) = find_character_cover_file(&char_path) {
                    cover_url = Some(asset_url(&local_cover));
                }
            }

            let aliases = meta.and_then(|m| m.aliases.clone()).unwrap_or_default();
            let known = meta
                .map(|m| {
                    m.display_name.is_some()
                        || m.canonical_en_name.is_some()
                        || m.aliases.as_ref().map(|a| !a.is_empty()).unwrap_or(false)
                })
                .unwrap_or(false)
                || canonical_en_name.is_some();

            let order = meta
                .and_then(|m| m.order)
                .filter(|&o| o >= 0)
                .map(|o| o as usize)
                .unwrap_or(usize::MAX);

            let kind = meta
                .and_then(|m| m.kind.clone())
                .filter(|k| k == "utility")
                .unwrap_or_else(|| "character".into());

            characters.push(CharacterInfo {
                folder,
                display_name,
                aliases,
                canonical_en_name,
                mod_count,
                enabled_count,
                hidden_count: mod_count.saturating_sub(enabled_count),
                has_cover: cover_url.is_some(),
                cover_url,
                known,
                order,
                kind,
            });
        }
    }

    let order_index: HashMap<String, usize> = custom_order
        .into_iter()
        .enumerate()
        .map(|(i, f)| (f, i))
        .collect();
    let sort_mode = settings.ui.sort_characters.as_str();
    characters.sort_by(|a, b| {
        if sort_mode == "count" && b.mod_count != a.mod_count {
            return b.mod_count.cmp(&a.mod_count);
        }
        if sort_mode == "custom" {
            match (order_index.get(&a.folder), order_index.get(&b.folder)) {
                (Some(la), Some(rb)) if la != rb => return la.cmp(rb),
                (Some(_), None) => return std::cmp::Ordering::Less,
                (None, Some(_)) => return std::cmp::Ordering::Greater,
                _ => {}
            }
            if a.order != b.order {
                return a.order.cmp(&b.order);
            }
        }
        a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase())
    });

    let total_mods = characters.iter().map(|c| c.mod_count).sum();
    let enabled_mods = characters.iter().map(|c| c.enabled_count).sum();

    GameSnapshot {
        game: game.clone(),
        settings: game_settings.clone(),
        characters,
        total_mods,
        enabled_mods,
        mods_path_exists: true,
    }
}

pub fn list_mods(
    mods_path: &Path,
    character_folder: &str,
    sort_mode: &str,
    custom_order: &[String],
) -> Result<Vec<ModInfo>, String> {
    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let mut mods = Vec::new();

    if let Ok(entries) = fs::read_dir(&char_dir) {
        for entry in entries.flatten() {
            let mod_path = entry.path();
            if !mod_path.is_dir() {
                continue;
            }
            let folder_name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if ignored_mod_name(&folder_name) {
                continue;
            }
            let name = strip_disabled_prefix(&folder_name).to_string();
            let enabled = is_mod_effectively_enabled(&folder_name, &mod_path);
            let (has_ini, _, _) = inspect_mod_ini_status(&mod_path, 2);
            let preview_url = find_mod_preview(&mod_path).map(|p| asset_url(&p));
            let updated_at = mtime_ms(&mod_path);

            mods.push(ModInfo {
                character_folder: character_folder.to_string(),
                folder_name,
                name,
                enabled,
                has_ini,
                preview_url,
                updated_at,
                file_count: None,
            });
        }
    }

    match sort_mode {
        "recent" => mods.sort_by(|a, b| b.updated_at.total_cmp(&a.updated_at)),
        "enabled" => mods.sort_by(|a, b| {
            if a.enabled != b.enabled {
                return b.enabled.cmp(&a.enabled);
            }
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }),
        "custom" => {
            let order_index: HashMap<&str, usize> = custom_order
                .iter()
                .enumerate()
                .map(|(i, s)| (s.as_str(), i))
                .collect();
            mods.sort_by(|a, b| {
                match (
                    order_index.get(a.name.as_str()),
                    order_index.get(b.name.as_str()),
                ) {
                    (Some(la), Some(rb)) if la != rb => return la.cmp(rb),
                    (Some(_), None) => return std::cmp::Ordering::Less,
                    (None, Some(_)) => return std::cmp::Ordering::Greater,
                    _ => {}
                }
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            });
        }
        _ => mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
    }

    Ok(mods)
}

fn strip_disabled_prefix(name: &str) -> &str {
    // Compare ASCII bytes first so byte index 9 is guaranteed to be a valid UTF-8 boundary.
    if name
        .as_bytes()
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"disabled_"))
    {
        &name[9..]
    } else {
        name
    }
}

fn set_ini_enabled_inside(mod_dir: &Path, enable: bool) -> Result<(), String> {
    let mut targets = Vec::new();
    for entry in WalkDir::new(mod_dir)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_name()
                    .to_str()
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(false)
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".ini") && lower != "desktop.ini" {
                targets.push((entry.path().to_path_buf(), name.to_string()));
            }
        }
    }

    for (src, name) in targets {
        let bare = strip_disabled_prefix(&name);
        let target_name = if enable {
            bare.to_string()
        } else {
            format!("DISABLED_{bare}")
        };
        if target_name == name {
            continue;
        }
        if let Some(parent) = src.parent() {
            let dest = parent.join(&target_name);
            if !dest.exists() {
                fs::rename(&src, &dest).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn set_single_mod_enabled(char_dir: &Path, mod_folder: &str, enable: bool) -> Result<(), String> {
    if !is_safe_segment(mod_folder) {
        return Err(format!("Invalid mod folder name: {mod_folder}"));
    }
    let bare = strip_disabled_prefix(mod_folder);
    let mut current_path = char_dir.join(mod_folder);
    if !current_path.is_dir() {
        let alt_name = if mod_folder.eq_ignore_ascii_case(bare) {
            format!("DISABLED_{bare}")
        } else {
            bare.to_string()
        };
        let alt_path = char_dir.join(&alt_name);
        if alt_path.is_dir() {
            current_path = alt_path;
        } else {
            return Err(format!("Mod folder not found: {mod_folder}"));
        }
    }

    let current_name = current_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(mod_folder)
        .to_string();
    let desired_name = if enable {
        bare.to_string()
    } else {
        format!("DISABLED_{bare}")
    };

    if current_name == desired_name {
        if enable {
            let _ = set_ini_enabled_inside(&current_path, true);
        }
        return Ok(());
    }

    let dest_path = char_dir.join(&desired_name);
    if dest_path.exists() {
        return Err(format!("Target mod folder already exists: {desired_name}"));
    }

    match fs::rename(&current_path, &dest_path) {
        Ok(()) => {
            if enable {
                let _ = set_ini_enabled_inside(&dest_path, true);
            }
            Ok(())
        }
        Err(_) => {
            // File-lock fallback while game is running: toggle internal .ini files
            set_ini_enabled_inside(&current_path, enable)
        }
    }
}

pub fn toggle_mod(
    mods_path: &Path,
    character_folder: &str,
    mod_folder: &str,
    enable: bool,
    exclusive: bool,
) -> Result<(), String> {
    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let target_bare = strip_disabled_prefix(mod_folder).to_ascii_lowercase();

    if enable && exclusive {
        if let Ok(entries) = fs::read_dir(&char_dir) {
            for entry in entries.flatten() {
                if !entry.path().is_dir() {
                    continue;
                }
                let sibling = match entry.file_name().to_str() {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if ignored_mod_name(&sibling) {
                    continue;
                }
                if strip_disabled_prefix(&sibling).to_ascii_lowercase() == target_bare {
                    continue;
                }
                if is_mod_effectively_enabled(&sibling, &entry.path()) {
                    let _ = set_single_mod_enabled(&char_dir, &sibling, false);
                }
            }
        }
    }

    set_single_mod_enabled(&char_dir, mod_folder, enable)
}

pub fn get_mod_details(
    mods_path: &Path,
    character_folder: &str,
    mod_folder: &str,
) -> Result<ModDetails, String> {
    if !is_safe_segment(mod_folder) {
        return Err("Invalid mod folder name".into());
    }
    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let bare = strip_disabled_prefix(mod_folder);
    let mut actual_folder = mod_folder.to_string();
    let mut mod_path = char_dir.join(&actual_folder);
    if !mod_path.is_dir() {
        let alt = if mod_folder.to_ascii_lowercase().starts_with("disabled_") {
            bare.to_string()
        } else {
            format!("DISABLED_{bare}")
        };
        let alt_path = char_dir.join(&alt);
        if alt_path.is_dir() {
            actual_folder = alt;
            mod_path = alt_path;
        } else {
            return Err("Mod folder does not exist".into());
        }
    }

    let mut file_count = 0usize;
    let mut size_bytes = 0u64;
    let mut ini_files = Vec::new();

    for entry in WalkDir::new(&mod_path)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_name()
                    .to_str()
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(false)
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        file_count += 1;
        if let Ok(meta) = entry.metadata() {
            size_bytes += meta.len();
        }
        if let Some(name) = entry.file_name().to_str() {
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".ini") && !lower.starts_with("disabled_") {
                if let Ok(rel) = entry.path().strip_prefix(&mod_path) {
                    ini_files.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    let enabled = is_mod_effectively_enabled(&actual_folder, &mod_path);
    let preview_url = find_mod_preview(&mod_path).map(|p| asset_url(&p));
    let updated_at = mtime_ms(&mod_path);

    Ok(ModDetails {
        character_folder: character_folder.to_string(),
        folder_name: actual_folder,
        name: bare.to_string(),
        path: mod_path.to_string_lossy().to_string(),
        enabled,
        file_count,
        size_bytes,
        updated_at,
        ini_files,
        hotkeys: Vec::new(),
        preview_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("moddeck_test_{label}_{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn snapshot_scans_characters_container_and_covers() {
        let root = make_temp_dir("snapshot");
        let base_dir = root.join("app_data");
        let mods_path = root.join("EFMI_Mods");
        let char_dir = mods_path.join("Characters").join("佩丽卡");
        let mod_enabled = char_dir.join("SkinA");
        let mod_disabled = char_dir.join("DISABLED_SkinB");

        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&mod_enabled).unwrap();
        fs::create_dir_all(&mod_disabled).unwrap();
        fs::write(char_dir.join(".preview.png"), b"png").unwrap();
        fs::write(mod_enabled.join("mod.ini"), b"[TextureOverride]").unwrap();
        fs::write(mod_disabled.join("mod.ini"), b"[TextureOverride]").unwrap();

        let mut settings = crate::settings::default_settings();
        settings.games.insert(
            "endfield".into(),
            GameSettings {
                mods_path: mods_path.to_string_lossy().to_string(),
                ..Default::default()
            },
        );
        let game = crate::games::builtin_games()
            .into_iter()
            .find(|g| g.id == "endfield")
            .expect("builtin endfield game");
        let gs = settings.games.get("endfield").unwrap().clone();
        let metadata = MetadataStore::default();

        let snap = build_snapshot(&base_dir, &game, &gs, &metadata, &settings);
        assert!(snap.mods_path_exists);
        assert_eq!(snap.characters.len(), 1);
        assert_eq!(snap.characters[0].folder, "佩丽卡");
        assert_eq!(snap.characters[0].canonical_en_name.as_deref(), Some("Perlica"));
        assert_eq!(snap.characters[0].mod_count, 2);
        assert_eq!(snap.characters[0].enabled_count, 1);
        assert!(snap.characters[0].cover_url.is_some());
        assert_eq!(snap.total_mods, 2);
        assert_eq!(snap.enabled_mods, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_and_toggle_mods_with_exclusive_and_preview_rules() {
        let root = make_temp_dir("toggle");
        let mods_path = root.join("Mods");
        let char_dir = mods_path.join("Endmin");
        let mod_a = char_dir.join("AlphaMod");
        let mod_b = char_dir.join("DISABLED_BetaMod");
        let mod_utf8 = char_dir.join("怒骊x祀 p切换 修复绳子");

        fs::create_dir_all(&mod_a).unwrap();
        fs::create_dir_all(&mod_b).unwrap();
        fs::create_dir_all(&mod_utf8).unwrap();
        fs::write(mod_a.join("mod.ini"), b"[Constants]").unwrap();
        fs::write(mod_b.join("mod.ini"), b"[Constants]").unwrap();
        fs::write(mod_utf8.join("mod.ini"), b"[Constants]").unwrap();
        fs::write(mod_b.join(".JASM_Cover.jpg"), b"jpg").unwrap();

        let listed = list_mods(&mods_path, "Endmin", "name", &[]).unwrap();
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].name, "AlphaMod");
        assert!(listed[0].enabled);
        assert_eq!(listed[1].name, "BetaMod");
        assert!(!listed[1].enabled);
        assert_eq!(listed[2].name, "怒骊x祀 p切换 修复绳子");
        assert!(listed[2].enabled);
        let preview_decoded = listed[1]
            .preview_url
            .as_deref()
            .and_then(|u| u.split('?').nth(1))
            .and_then(decode_asset_query)
            .unwrap_or_default();
        assert!(preview_decoded.ends_with(".JASM_Cover.jpg"));

        toggle_mod(&mods_path, "Endmin", "DISABLED_BetaMod", true, true).unwrap();
        assert!(char_dir.join("BetaMod").is_dir());
        assert!(char_dir.join("DISABLED_AlphaMod").is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn asset_url_roundtrip_and_boundary_check() {
        let root = make_temp_dir("assets");
        let base_dir = root.join("data");
        let covers = base_dir.join("covers").join("efmi");
        let mods_path = root.join("Mods");
        let outside = root.join("secret.png");

        fs::create_dir_all(&covers).unwrap();
        fs::create_dir_all(&mods_path).unwrap();
        let cover_img = covers.join("hero.png");
        let mod_img = mods_path.join("preview.webp");
        let ini_file = mods_path.join("mod.ini");

        fs::write(&cover_img, b"png").unwrap();
        fs::write(&mod_img, b"webp").unwrap();
        fs::write(&ini_file, b"[ini]").unwrap();
        fs::write(&outside, b"png").unwrap();

        let url = asset_url(&cover_img);
        let query = url.split('?').nth(1).unwrap();
        let decoded = decode_asset_query(query).unwrap();
        assert_eq!(PathBuf::from(decoded), cover_img);

        let mut settings = crate::settings::default_settings();
        settings.games.insert(
            "efmi".into(),
            GameSettings {
                mods_path: mods_path.to_string_lossy().to_string(),
                ..Default::default()
            },
        );

        assert!(is_allowed_asset_path(&base_dir, &settings, &cover_img));
        assert!(is_allowed_asset_path(&base_dir, &settings, &mod_img));
        assert!(!is_allowed_asset_path(&base_dir, &settings, &ini_file));
        assert!(!is_allowed_asset_path(&base_dir, &settings, &outside));

        let _ = fs::remove_dir_all(&root);
    }
}
