use crate::models::{
    CharacterInfo, CharacterMeta, GameDef, GameSettings, GameSnapshot, MetadataStore, ModDetails,
    ModHotkey, ModInfo, Settings,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
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
    if let Ok(c_norm) = fs::canonicalize(child) {
        return c_norm.starts_with(&p_norm);
    }
    // When `child` does not exist yet (e.g., before directory creation), canonicalize its nearest
    // existing ancestor so Windows `\\?\` UNC prefixes match cleanly.
    if let Some(child_parent) = child.parent() {
        if let Some(name) = child.file_name() {
            if let Ok(cp_norm) = fs::canonicalize(child_parent) {
                return cp_norm.join(name).starts_with(&p_norm);
            }
        }
    }
    child.starts_with(parent)
}

pub fn is_supported_image_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "bmp")
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

const DEFAULT_IGNORED_SANDBOX_DIRS: &[&str] = &["efmi-mcp"];

pub fn is_ignored_sandbox_dir(name: &str, extra_ignores: &[String]) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.starts_with('.') || trimmed.starts_with('_') {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if DEFAULT_IGNORED_SANDBOX_DIRS
        .iter()
        .any(|builtin| *builtin == lower)
    {
        return true;
    }
    extra_ignores
        .iter()
        .any(|custom| custom.trim().eq_ignore_ascii_case(trimmed))
}

fn ignored_character_name(name: &str) -> bool {
    is_ignored_sandbox_dir(name, &[])
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

pub fn is_mod_effectively_enabled(folder_name: &str, mod_path: &Path) -> bool {
    if folder_name.to_ascii_lowercase().starts_with("disabled_") {
        return false;
    }
    let (_has_ini, has_active, has_disabled) = inspect_mod_ini_status(mod_path, 2);
    if has_disabled && !has_active {
        return false;
    }
    true
}

pub fn resolve_mod_target_dir(
    mods_path: &Path,
    character_folder: &str,
    mod_folder: &str,
) -> Result<PathBuf, String> {
    if !is_safe_segment(mod_folder) {
        return Err("Invalid mod folder name".to_string());
    }
    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let direct = char_dir.join(mod_folder);
    if direct.is_dir() && is_inside(&char_dir, &direct) {
        return Ok(direct);
    }
    let clean = if mod_folder.len() >= 9 && mod_folder.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
    {
        &mod_folder[9..]
    } else {
        mod_folder
    };
    let alt = if mod_folder.len() >= 9 && mod_folder.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
    {
        clean.to_string()
    } else {
        format!("DISABLED_{clean}")
    };
    let alt_dir = char_dir.join(&alt);
    if alt_dir.is_dir() && is_inside(&char_dir, &alt_dir) {
        return Ok(alt_dir);
    }
    if is_inside(&char_dir, &direct) {
        Ok(direct)
    } else {
        Err("Mod directory escapes character folder".to_string())
    }
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
    let roster_cache = crate::roster::load_roster_cache(base_dir);
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
            if is_legacy_container(&folder)
                || is_ignored_sandbox_dir(&folder, &settings.ui.ignored_mod_dirs)
            {
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
                .or_else(|| crate::roster::find_canonical_en(&game.id, &folder, roster_cache.as_ref()))
                .or_else(|| crate::roster::find_canonical_en(&game.id, &display_name, roster_cache.as_ref()));

            let mut cover_url = meta
                .and_then(|m| m.cover_file.as_ref())
                .and_then(|cf| {
                    let abs = crate::metadata::cover_path(base_dir, &game.id, cf);
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

            let kind = crate::roster::infer_character_kind(
                &game.id,
                &folder,
                meta.and_then(|m| m.kind.as_deref()),
                roster_cache.as_ref(),
            );

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

pub fn strip_disabled_prefix(name: &str) -> &str {
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

    ini_files.sort();
    let hotkeys = extract_ini_hotkeys(&mod_path, &ini_files);
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
        hotkeys,
        preview_url,
    })
}

fn decode_ini_text_lossy(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() >= 2 {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for chunk in bytes[2..].chunks_exact(2) {
            units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
        }
        return String::from_utf16_lossy(&units);
    }
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string()
}

fn classify_hotkey_hint(key: &str, key_type: Option<&str>) -> Option<&'static str> {
    let cleaned = key.split(';').next().unwrap_or("").trim();
    let mut has_non_modifier = false;
    for chunk in cleaned.split_whitespace() {
        let parts: Vec<&str> = if chunk == "+" {
            vec!["+"]
        } else if chunk.contains('+') {
            chunk.split('+').filter(|s| !s.is_empty()).collect()
        } else {
            vec![chunk]
        };
        for raw in parts {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            if lower.starts_with("no_") {
                continue;
            }
            let stripped = if lower.starts_with("vk_") {
                &lower[3..]
            } else {
                lower.as_str()
            };
            if matches!(
                stripped,
                "lbutton" | "rbutton" | "mbutton" | "xbutton1" | "xbutton2"
            ) {
                return Some("mouse");
            }
            if !matches!(
                stripped,
                "ctrl"
                    | "control"
                    | "lctrl"
                    | "rctrl"
                    | "lcontrol"
                    | "rcontrol"
                    | "alt"
                    | "lalt"
                    | "ralt"
                    | "menu"
                    | "lmenu"
                    | "rmenu"
                    | "shift"
                    | "lshift"
                    | "rshift"
                    | "win"
                    | "lwin"
                    | "rwin"
            ) {
                has_non_modifier = true;
            }
        }
    }
    if !has_non_modifier {
        return Some("modifier-hold");
    }
    if key_type
        .map(|t| t.trim().eq_ignore_ascii_case("hold"))
        .unwrap_or(false)
    {
        return Some("hold");
    }
    None
}

fn flush_section_hotkeys(
    hotkeys: &mut Vec<ModHotkey>,
    section: &str,
    keys: &mut Vec<String>,
    key_type: &mut Option<String>,
) {
    let sec_type = key_type.take().filter(|s| !s.is_empty());
    if section.is_empty() {
        keys.clear();
        return;
    }
    for k in keys.drain(..) {
        let hint_kind = classify_hotkey_hint(&k, sec_type.as_deref()).map(str::to_string);
        hotkeys.push(ModHotkey {
            section: section.to_string(),
            key: k,
            key_type: sec_type.clone(),
            hint_kind,
        });
    }
}

fn extract_ini_hotkeys(mod_path: &Path, ini_files: &[String]) -> Vec<ModHotkey> {
    let mut hotkeys = Vec::new();
    for rel in ini_files.iter().take(20) {
        let full = mod_path.join(rel);
        let Ok(meta) = fs::metadata(&full) else {
            continue;
        };
        if meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = fs::read(&full) else {
            continue;
        };
        let text = decode_ini_text_lossy(&bytes);
        let mut section = String::new();
        let mut sec_keys: Vec<String> = Vec::new();
        let mut sec_type: Option<String> = None;

        for raw_line in text.lines() {
            let trimmed = raw_line.trim();
            if trimmed.is_empty() || trimmed.starts_with(';') {
                continue;
            }
            if let Some(after_open) = trimmed.strip_prefix('[') {
                if let Some(end_idx) = after_open.find(']') {
                    flush_section_hotkeys(&mut hotkeys, &section, &mut sec_keys, &mut sec_type);
                    section = after_open[..end_idx].trim().to_string();
                    continue;
                }
            }
            if section.is_empty() {
                continue;
            }
            let Some((lhs, rhs)) = trimmed.split_once('=') else {
                continue;
            };
            let prop = lhs.trim();
            let val = rhs.split(';').next().unwrap_or("").trim();
            if prop.eq_ignore_ascii_case("key") || prop.eq_ignore_ascii_case("back") {
                if !val.is_empty() {
                    sec_keys.push(val.to_string());
                }
            } else if prop.eq_ignore_ascii_case("type") {
                if !val.is_empty() {
                    sec_type = Some(val.to_ascii_lowercase());
                }
            }
        }
        flush_section_hotkeys(&mut hotkeys, &section, &mut sec_keys, &mut sec_type);
    }
    hotkeys
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

/// Lists character category directory names under a configured `mods_path`.
pub fn list_character_folder_names(mods_path: &Path) -> Vec<String> {
    if !mods_path.is_dir() {
        return Vec::new();
    }
    let char_base = resolve_character_base(mods_path);
    let Ok(entries) = fs::read_dir(&char_base) else {
        return Vec::new();
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if ["characters", "character", "角色", "mods"].contains(&lower.as_str()) {
            continue;
        }
        if name.starts_with('.') || name.starts_with("__") {
            continue;
        }
        folders.push(name);
    }
    folders
}

/// Creates a new character category directory, optionally writing metadata and `.preview.png`.
pub fn create_character_dir(
    mods_path: &Path,
    metadata: &mut MetadataStore,
    game_id: &str,
    input: &crate::models::CreateCharacterInput,
) -> Result<String, String> {
    let raw_folder = input.folder.trim();
    if raw_folder.is_empty()
        || !is_safe_segment(raw_folder)
        || raw_folder.contains('\\')
        || raw_folder.contains('/')
        || raw_folder.chars().any(|c| matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Invalid character folder name".to_string());
    }
    if !mods_path.is_dir() {
        return Err("Mods folder does not exist".to_string());
    }

    let char_base = resolve_character_base(mods_path);
    let target_dir = char_base.join(raw_folder);
    if !is_inside(&char_base, &target_dir) {
        return Err("Target character folder escapes mods root".to_string());
    }
    if target_dir.exists() {
        return Err("Character folder already exists".to_string());
    }
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Failed to create character folder: {e}"))?;

    let meta = CharacterMeta {
        display_name: input
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        aliases: input.aliases.clone(),
        canonical_en_name: None,
        cover_file: None,
        order: None,
        hidden: None,
        note: None,
        kind: input.kind.as_deref().and_then(|k| match k.trim() {
            "utility" => Some("utility".to_string()),
            "character" => Some("character".to_string()),
            _ => None,
        }),
    };
    crate::metadata::set_character_meta(metadata, game_id, raw_folder, meta);

    if let Some(data_url) = input.cover_data_url.as_deref().map(str::trim).filter(|s| !s.is_empty())
    {
        crate::metadata::save_character_cover_data(&target_dir, data_url)?;
    }

    Ok(raw_folder.to_string())
}

fn decode_image_data_url(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    let trimmed = data_url.trim();
    let Some(rest) = trimmed.strip_prefix("data:image/") else {
        return Err("Unsupported preview image data URL".to_string());
    };
    let Some((mime_sub, encoded)) = rest.split_once(";base64,") else {
        return Err("Preview image data URL must be base64-encoded".to_string());
    };
    let ext = match mime_sub.trim().to_ascii_lowercase().as_str() {
        "png" => ".png",
        "jpeg" | "jpg" => ".jpg",
        "webp" => ".webp",
        "gif" => ".gif",
        "bmp" => ".bmp",
        _ => return Err(format!("Unsupported preview image type: {mime_sub}")),
    };
    let bytes = BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("Invalid preview base64 image data: {e}"))?;
    if bytes.is_empty() {
        return Err("Preview image data is empty".to_string());
    }
    Ok((ext, bytes))
}

/// Saves a chosen image file or base64 data URL to `<modPath>/preview<ext>` after clearing older `preview.*` files.
pub fn set_mod_preview_file(
    mods_path: &Path,
    character_folder: &str,
    mod_folder: &str,
    source_image_or_data: &str,
) -> Result<(), String> {
    let trimmed_source = source_image_or_data.trim();
    if trimmed_source.is_empty() {
        return Err("Selected preview file is invalid or unsupported".to_string());
    }
    if !is_safe_segment(mod_folder) {
        return Err("Invalid mod folder".to_string());
    }
    let char_dir = resolve_character_dir(mods_path, character_folder)?;
    let mod_dir = char_dir.join(mod_folder);
    if !is_inside(&char_dir, &mod_dir) || !mod_dir.is_dir() {
        return Err("Mod folder does not exist".to_string());
    }

    let is_data_url = trimmed_source.starts_with("data:image/");
    let decoded_payload = if is_data_url {
        Some(decode_image_data_url(trimmed_source)?)
    } else {
        let source_path = Path::new(trimmed_source);
        if !source_path.is_file() || !is_supported_image_ext(source_path) {
            return Err("Selected preview file is invalid or unsupported".to_string());
        }
        None
    };

    for old_ext in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"] {
        let candidate = mod_dir.join(format!("preview{old_ext}"));
        if candidate.is_file() {
            let _ = fs::remove_file(&candidate);
        }
    }

    if let Some((ext, bytes)) = decoded_payload {
        let dest = mod_dir.join(format!("preview{ext}"));
        fs::write(&dest, bytes).map_err(|e| format!("Failed to write preview image: {e}"))?;
    } else {
        let source_path = Path::new(trimmed_source);
        let ext = source_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!(".{}", e.to_lowercase()))
            .unwrap_or_else(|| ".png".to_string());
        let dest = mod_dir.join(format!("preview{ext}"));
        fs::copy(source_path, &dest).map_err(|e| format!("Failed to copy preview image: {e}"))?;
    }
    Ok(())
}

/// Creates missing category directories on disk after a remote roster sync.
pub fn sync_missing_roster_folders_to_disk(
    settings: &Settings,
    metadata: &mut MetadataStore,
    cache: Option<&crate::models::RosterCacheFile>,
    prefer_en: bool,
) -> (usize, bool) {
    let mut created_count = 0usize;
    let mut metadata_changed = false;

    for game in crate::games::get_all_games(settings) {
        let Some(gs) = settings.games.get(&game.id) else {
            continue;
        };
        let mods_path = Path::new(&gs.mods_path);
        if gs.mods_path.trim().is_empty() || !mods_path.is_dir() {
            continue;
        }
        let char_base = resolve_character_base(mods_path);
        let existing_folders = list_character_folder_names(mods_path);
        let mut existing_norms = HashSet::new();
        for f in &existing_folders {
            let n = crate::roster::normalize_match_text(f);
            if !n.is_empty() {
                existing_norms.insert(n);
            }
            if let Some(meta) = crate::metadata::get_character_meta(metadata, &game.id, f) {
                if let Some(dn) = &meta.display_name {
                    let n = crate::roster::normalize_match_text(dn);
                    if !n.is_empty() {
                        existing_norms.insert(n);
                    }
                }
                if let Some(en) = &meta.canonical_en_name {
                    let n = crate::roster::normalize_match_text(en);
                    if !n.is_empty() {
                        existing_norms.insert(n);
                    }
                }
                if let Some(aliases) = &meta.aliases {
                    for a in aliases {
                        let n = crate::roster::normalize_match_text(a);
                        if !n.is_empty() {
                            existing_norms.insert(n);
                        }
                    }
                }
            }
        }

        for entry in crate::roster::get_merged_roster(&game.id, cache) {
            if entry.zh == "其他" {
                continue;
            }
            let mut tokens = Vec::new();
            for candidate in std::iter::once(entry.zh.as_str())
                .chain(std::iter::once(entry.en.as_str()))
                .chain(std::iter::once(entry.pinyin.as_str()))
                .chain(entry.aliases.iter().map(String::as_str))
            {
                let norm = crate::roster::normalize_match_text(candidate);
                if !norm.is_empty() {
                    tokens.push(norm);
                }
            }
            if tokens.iter().any(|tok| existing_norms.contains(tok)) {
                continue;
            }

            let raw_name = if prefer_en && !entry.en.is_empty() {
                entry.en.as_str()
            } else {
                entry.zh.as_str()
            };
            let folder_name: String = raw_name
                .chars()
                .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
                .collect::<String>()
                .trim()
                .to_string();
            if folder_name.is_empty() || !is_safe_segment(&folder_name) {
                continue;
            }
            let target_dir = char_base.join(&folder_name);
            if !is_inside(&char_base, &target_dir) {
                continue;
            }
            if !target_dir.exists() && fs::create_dir_all(&target_dir).is_ok() {
                created_count += 1;
            }
            for tok in tokens {
                existing_norms.insert(tok);
            }
            existing_norms.insert(crate::roster::normalize_match_text(&folder_name));
            if entry.kind.as_deref() == Some("utility") {
                let mut current = crate::metadata::get_character_meta(metadata, &game.id, &folder_name)
                    .cloned()
                    .unwrap_or_default();
                if current.kind.as_deref() != Some("utility") {
                    current.kind = Some("utility".to_string());
                    crate::metadata::set_character_meta(metadata, &game.id, &folder_name, current);
                    metadata_changed = true;
                }
            }
        }
    }

    (created_count, metadata_changed)
}

/// Sanitizes a user or archive-supplied folder/file segment for safe path joining.
pub fn sanitize_segment(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    let mut s = trimmed.to_string();
    while s.starts_with('.') {
        s.remove(0);
    }
    let s = s.trim().to_string();
    if s.is_empty() || s == "." || s == ".." {
        fallback.to_string()
    } else {
        s
    }
}

/// Returns a unique directory name under `parent` by appending `(2)`, `(3)`, ... when needed.
/// Checks if a sibling mod directory already claims `bare_name` (enabled or `DISABLED_`-prefixed).
fn has_bare_dir_conflict(parent: &Path, bare_name: &str) -> bool {
    if parent.join(bare_name).exists() || parent.join(format!("DISABLED_{bare_name}")).exists() {
        return true;
    }
    let Ok(entries) = fs::read_dir(parent) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|fname| strip_disabled_prefix(fname).eq_ignore_ascii_case(bare_name))
    })
}

pub fn unique_dir_name(parent: &Path, base_name: &str) -> String {
    let clean = sanitize_segment(base_name, "mod");
    let has_disabled = clean.len() != strip_disabled_prefix(&clean).len();
    let bare = strip_disabled_prefix(&clean);
    if !parent.join(&clean).exists() && !has_bare_dir_conflict(parent, bare) {
        return clean;
    }
    let mut idx = 2usize;
    loop {
        let candidate_bare = format!("{bare} ({idx})");
        let candidate = if has_disabled {
            format!("DISABLED_{candidate_bare}")
        } else {
            candidate_bare.clone()
        };
        if !parent.join(&candidate).exists() && !has_bare_dir_conflict(parent, &candidate_bare) {
            return candidate;
        }
        idx += 1;
    }
}

/// Recursively copies a directory tree from `src` to `dst` (which must not already exist).
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dst.display()));
    }
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create dir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| format!("Dir entry error: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("File type error: {e}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("Failed to copy {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// Moves `src` to `dst`, falling back to recursive copy + remove across volumes.
pub fn move_dir_or_copy(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir {}: {e}", parent.display()))?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_dir_recursive(src, dst)?;
            fs::remove_dir_all(src)
                .map_err(|e| format!("Failed to remove source {}: {e}", src.display()))
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveredCategoryCover {
    pub folder: String,
    pub file_name: String,
    pub file_path: PathBuf,
    pub size: u64,
}

/// Lists `.preview.*` / `_cover.*` category cover files stored inside `modsPath`.
pub fn scan_game_category_covers(mods_path: &Path) -> Vec<DiscoveredCategoryCover> {
    let mut out = Vec::new();
    if !mods_path.is_dir() {
        return out;
    }
    let char_base = resolve_character_base(mods_path);
    let Ok(entries) = fs::read_dir(&char_base) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(folder) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if ignored_character_name(&folder) || is_legacy_container(&folder) {
            continue;
        }
        if let Some(cover_path) = find_character_cover_file(&path) {
            if let Ok(meta) = fs::metadata(&cover_path) {
                if let Some(file_name) = cover_path.file_name().and_then(|s| s.to_str()) {
                    out.push(DiscoveredCategoryCover {
                        folder,
                        file_name: file_name.to_string(),
                        size: meta.len(),
                        file_path: cover_path,
                    });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod stage1_tests {
    use super::*;

    #[test]
    fn snapshot_resolves_electron_relative_cover_and_utility_kind() {
        let root = std::env::temp_dir().join(format!("moddeck-stage1-lib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("data");
        let mods_path = root.join("Mods");
        let ow_dir = mods_path.join("OpenWorld");
        fs::create_dir_all(&ow_dir).unwrap();

        let src_cover = root.join("cover_src.png");
        fs::write(&src_cover, b"fake-png").unwrap();
        let saved_rel = crate::metadata::save_cover(&base_dir, "endfield", "OpenWorld", &src_cover).unwrap();
        assert!(saved_rel.starts_with("endfield/"));

        let mut metadata = MetadataStore::default();
        crate::metadata::set_character_meta(
            &mut metadata,
            "endfield",
            "OpenWorld",
            CharacterMeta {
                cover_file: Some(saved_rel),
                ..Default::default()
            },
        );

        let mut settings = crate::settings::default_settings();
        settings.games.insert(
            "endfield".to_string(),
            GameSettings {
                mods_path: mods_path.to_string_lossy().to_string(),
                ..Default::default()
            },
        );
        let game = crate::games::get_game(&settings, "endfield").unwrap();
        let snap = build_snapshot(&base_dir, &game, &settings.games["endfield"], &metadata, &settings);

        assert_eq!(snap.characters.len(), 1);
        assert!(snap.characters[0].has_cover);
        assert_eq!(snap.characters[0].kind, "utility");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_character_and_sets_mod_preview() {
        let root = std::env::temp_dir().join(format!("moddeck-stage1-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mods_path = root.join("Mods");
        fs::create_dir_all(&mods_path).unwrap();

        let mut metadata = MetadataStore::default();
        let folder = create_character_dir(
            &mods_path,
            &mut metadata,
            "endfield",
            &crate::models::CreateCharacterInput {
                folder: "NewHero".to_string(),
                display_name: Some("New Hero".to_string()),
                aliases: Some(vec!["NH".to_string()]),
                kind: Some("character".to_string()),
                cover_data_url: None,
            },
        )
        .unwrap();
        assert_eq!(folder, "NewHero");

        let mod_dir = mods_path.join("NewHero").join("CoolMod");
        fs::create_dir_all(&mod_dir).unwrap();
        let img = root.join("shot.webp");
        fs::write(&img, b"webp-bytes").unwrap();
        set_mod_preview_file(&mods_path, "NewHero", "CoolMod", &img.to_string_lossy()).unwrap();
        assert!(mod_dir.join("preview.webp").is_file());

        let data_url = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(b"png-bytes"));
        set_mod_preview_file(&mods_path, "NewHero", "CoolMod", &data_url).unwrap();
        assert!(!mod_dir.join("preview.webp").exists());
        assert_eq!(fs::read(mod_dir.join("preview.png")).unwrap(), b"png-bytes");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extracts_mod_details_hotkeys_with_sections_and_punctuation() {
        let root = std::env::temp_dir().join(format!("moddeck-hotkeys-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mods_path = root.join("Mods");
        let mod_dir = mods_path.join("Arclight").join("TestMod");
        fs::create_dir_all(&mod_dir).unwrap();
        fs::write(
            mod_dir.join("mod.ini"),
            "; header\r\n[Key$Makeup]\r\nkey = 0 ; toggle\r\n[Key$Skin]\r\nkey = ,\r\nback = /\r\ntype = cycle\r\n[KeyCombo]\r\nkey = no_modifiers .\r\n[KeyToggleUI]\r\ncondition = $ActiveCharacter\r\nkey = CTRL ALT\r\ntype = hold\r\n[KeyHoldAlt]\r\ntype = hold\r\nkey = Alt 1\r\n[KeyMouse]\r\nkey = VK_LBUTTON\r\ntype = hold\r\n",
        )
        .unwrap();

        let details = get_mod_details(&mods_path, "Arclight", "TestMod").unwrap();
        assert_eq!(details.hotkeys.len(), 7);
        assert_eq!(details.hotkeys[0].section, "Key$Makeup");
        assert_eq!(details.hotkeys[0].key, "0");
        assert_eq!(details.hotkeys[0].hint_kind, None);
        assert_eq!(details.hotkeys[1].section, "Key$Skin");
        assert_eq!(details.hotkeys[1].key, ",");
        assert_eq!(details.hotkeys[1].key_type.as_deref(), Some("cycle"));
        assert_eq!(details.hotkeys[1].hint_kind, None);
        assert_eq!(details.hotkeys[2].section, "Key$Skin");
        assert_eq!(details.hotkeys[2].key, "/");
        assert_eq!(details.hotkeys[3].section, "KeyCombo");
        assert_eq!(details.hotkeys[3].key, "no_modifiers .");
        assert_eq!(details.hotkeys[3].hint_kind, None);
        assert_eq!(details.hotkeys[4].section, "KeyToggleUI");
        assert_eq!(details.hotkeys[4].key, "CTRL ALT");
        assert_eq!(details.hotkeys[4].key_type.as_deref(), Some("hold"));
        assert_eq!(details.hotkeys[4].hint_kind.as_deref(), Some("modifier-hold"));
        assert_eq!(details.hotkeys[5].section, "KeyHoldAlt");
        assert_eq!(details.hotkeys[5].key, "Alt 1");
        assert_eq!(details.hotkeys[5].hint_kind.as_deref(), Some("hold"));
        assert_eq!(details.hotkeys[6].section, "KeyMouse");
        assert_eq!(details.hotkeys[6].key, "VK_LBUTTON");
        assert_eq!(details.hotkeys[6].hint_kind.as_deref(), Some("mouse"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_excludes_efmi_mcp_and_custom_ignored_dirs() {
        let root = std::env::temp_dir().join(format!("moddeck-ignore-dirs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("data");
        let mods_path = root.join("Mods");
        fs::create_dir_all(mods_path.join("EFMI-MCP").join("Dummy")).unwrap();
        fs::create_dir_all(mods_path.join("_ModDeck_Preset_Bridge")).unwrap();
        fs::create_dir_all(mods_path.join("CustomTempTool")).unwrap();
        fs::create_dir_all(mods_path.join("Perlica").join("SkinA")).unwrap();

        let mut settings = crate::settings::default_settings();
        settings.games.insert(
            "endfield".to_string(),
            GameSettings {
                mods_path: mods_path.to_string_lossy().to_string(),
                ..Default::default()
            },
        );
        settings.ui.ignored_mod_dirs = vec!["customtemptool".to_string()];
        let game = crate::games::get_game(&settings, "endfield").unwrap();
        let metadata = MetadataStore::default();
        let snap = build_snapshot(&base_dir, &game, &settings.games["endfield"], &metadata, &settings);

        let folders: Vec<&str> = snap.characters.iter().map(|c| c.folder.as_str()).collect();
        assert_eq!(folders, vec!["Perlica"]);

        let _ = fs::remove_dir_all(&root);
    }
}
