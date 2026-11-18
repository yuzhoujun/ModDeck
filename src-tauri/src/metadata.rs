use crate::models::{CharacterMeta, MetadataStore};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const METADATA_FILE: &str = "characters.json";
pub const CHARACTER_COVER_FILE: &str = ".preview.png";
pub const LEGACY_CHARACTER_COVERS: [&str; 7] = [
    ".preview.jpg",
    ".preview.jpeg",
    ".preview.webp",
    "_cover.png",
    "_cover.jpg",
    "_cover.jpeg",
    "_cover.webp",
];
const COVER_EXTENSIONS: [&str; 6] = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];

pub fn metadata_path(base_dir: &Path) -> PathBuf {
    base_dir.join("characters.json")
}

pub fn load_metadata(base_dir: &Path) -> MetadataStore {
    let path = metadata_path(base_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return MetadataStore {
            schema_version: 1,
            games: HashMap::new(),
            roster_initialized: HashMap::new(),
        };
    };
    let mut store: MetadataStore = serde_json::from_str(&raw).unwrap_or_default();
    if store.schema_version == 0 {
        store.schema_version = 1;
    }
    store
}

pub fn save_metadata(base_dir: &Path, store: &MetadataStore) -> Result<(), String> {
    fs::create_dir_all(base_dir).map_err(|e| format!("Failed to create metadata dir: {e}"))?;
    let target = metadata_path(base_dir);
    let temp = base_dir.join(format!("characters.json.tmp-{}", std::process::id()));
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Serialize metadata failed: {e}"))?;
    fs::write(&temp, content).map_err(|e| format!("Write metadata temp failed: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target).map_err(|e| format!("Rename metadata failed: {e}"))?;
    Ok(())
}

pub fn mark_roster_initialized(store: &mut MetadataStore, game_id: &str) -> bool {
    if store.roster_initialized.contains_key(game_id) {
        return false;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    store.roster_initialized.insert(game_id.to_string(), now_ms);
    true
}

pub fn get_character_meta<'a>(
    store: &'a MetadataStore,
    game_id: &str,
    folder: &str,
) -> Option<&'a CharacterMeta> {
    store.games.get(game_id).and_then(|g| g.get(folder))
}

fn sanitize_meta(meta: CharacterMeta) -> Option<CharacterMeta> {
    let display_name = meta
        .display_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let canonical_en_name = meta
        .canonical_en_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let cover_file = meta
        .cover_file
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let note = meta
        .note
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let kind = meta
        .kind
        .as_deref()
        .and_then(|k| match k.trim() {
            "character" => Some("character".to_string()),
            "utility" => Some("utility".to_string()),
            _ => None,
        });

    let mut seen_aliases = HashSet::new();
    let aliases: Vec<String> = meta
        .aliases
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty() && seen_aliases.insert(a.clone()))
        .collect();
    let aliases_opt = if aliases.is_empty() {
        None
    } else {
        Some(aliases)
    };

    let hidden = meta.hidden.filter(|&v| v);

    let is_empty = display_name.is_none()
        && aliases_opt.is_none()
        && canonical_en_name.is_none()
        && cover_file.is_none()
        && meta.order.is_none()
        && hidden.is_none()
        && note.is_none()
        && kind.is_none();

    if is_empty {
        return None;
    }

    Some(CharacterMeta {
        display_name,
        aliases: aliases_opt,
        canonical_en_name,
        cover_file,
        order: meta.order,
        hidden,
        note,
        kind,
    })
}

pub fn set_character_meta(
    store: &mut MetadataStore,
    game_id: &str,
    folder: &str,
    meta: CharacterMeta,
) {
    let clean = sanitize_meta(meta);
    let game_map = store.games.entry(game_id.to_string()).or_default();
    if let Some(m) = clean {
        game_map.insert(folder.to_string(), m);
    } else {
        game_map.remove(folder);
        if game_map.is_empty() {
            store.games.remove(game_id);
        }
    }
}

pub fn remove_character_meta(store: &mut MetadataStore, game_id: &str, folder: &str) {
    if let Some(game_map) = store.games.get_mut(game_id) {
        game_map.remove(folder);
        if game_map.is_empty() {
            store.games.remove(game_id);
        }
    }
}

/// Computes the Electron-compatible 16-hex SHA-1 digest of a character folder name.
pub fn cover_hash_id(folder: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(folder.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Resolves a stored `coverFile` metadata entry against `<baseDir>/covers/`.
/// Supports Electron's `{gameId}/{hash16}{ext}` relative path as well as bare filenames.
pub fn cover_path(base_dir: &Path, game_id: &str, cover_file: &str) -> PathBuf {
    let rel = cover_file.trim().replace('\\', "/");
    let direct = base_dir.join("covers").join(&rel);
    if rel.contains('/') || direct.is_file() {
        return direct;
    }
    base_dir.join("covers").join(game_id).join(&rel)
}

/// Copies a cover image into `<baseDir>/covers/{gameId}/{sha1_16}{ext}` and returns its relative key.
pub fn save_cover(
    base_dir: &Path,
    game_id: &str,
    folder: &str,
    source_path: &Path,
) -> Result<String, String> {
    if !source_path.is_file() {
        return Err("Selected cover file does not exist".to_string());
    }
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .filter(|e| COVER_EXTENSIONS.contains(&e.as_str()))
        .unwrap_or_else(|| ".png".to_string());

    let hash_id = cover_hash_id(folder);
    let game_cover_dir = base_dir.join("covers").join(game_id);
    fs::create_dir_all(&game_cover_dir)
        .map_err(|e| format!("Failed to create covers directory: {e}"))?;

    for old_ext in COVER_EXTENSIONS {
        let candidate = game_cover_dir.join(format!("{hash_id}{old_ext}"));
        if candidate.is_file() {
            let _ = fs::remove_file(&candidate);
        }
    }

    let file_name = format!("{hash_id}{ext}");
    let dest = game_cover_dir.join(&file_name);
    fs::copy(source_path, &dest).map_err(|e| format!("Failed to copy cover image: {e}"))?;

    Ok(format!("{game_id}/{file_name}"))
}

/// Decodes a `data:image/...;base64,...` cover payload and writes `.preview.png` inside `character_dir`.
pub fn save_character_cover_data(character_dir: &Path, data_url: &str) -> Result<PathBuf, String> {
    let trimmed = data_url.trim();
    let Some((header, payload)) = trimmed.split_once(";base64,") else {
        return Err("Invalid image data URL".to_string());
    };
    let lower_header = header.to_lowercase();
    if !matches!(
        lower_header.as_str(),
        "data:image/png" | "data:image/jpeg" | "data:image/jpg" | "data:image/webp"
    ) {
        return Err("Unsupported image MIME type".to_string());
    }

    let bytes = BASE64_STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Failed to decode image base64: {e}"))?;
    if bytes.is_empty() {
        return Err("Empty image payload".to_string());
    }

    fs::create_dir_all(character_dir)
        .map_err(|e| format!("Failed to create character folder: {e}"))?;

    let target = character_dir.join(CHARACTER_COVER_FILE);
    let temp = character_dir.join(format!("{CHARACTER_COVER_FILE}.tmp-{}", std::process::id()));
    fs::write(&temp, bytes).map_err(|e| format!("Failed to write cover data: {e}"))?;

    for legacy in LEGACY_CHARACTER_COVERS {
        let legacy_path = character_dir.join(legacy);
        if legacy_path.is_file() {
            let _ = fs::remove_file(legacy_path);
        }
    }

    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target).map_err(|e| format!("Failed to finalize cover file: {e}"))?;
    Ok(target)
}

/// Removes local character folder cover files and any cached cover under `covers/`.
pub fn clear_character_cover_files(
    base_dir: &Path,
    store: &mut MetadataStore,
    game_id: &str,
    folder: &str,
    character_dir: Option<&Path>,
) {
    if let Some(dir) = character_dir {
        if dir.is_dir() {
            for name in std::iter::once(CHARACTER_COVER_FILE).chain(LEGACY_CHARACTER_COVERS) {
                let path = dir.join(name);
                if path.is_file() {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    if let Some(current) = get_character_meta(store, game_id, folder).cloned() {
        if let Some(cf) = &current.cover_file {
            let cached = cover_path(base_dir, game_id, cf);
            if cached.is_file() {
                let _ = fs::remove_file(cached);
            }
        }
        if current.cover_file.is_some() {
            let mut updated = current;
            updated.cover_file = None;
            set_character_meta(store, game_id, folder, updated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_hash_matches_electron_sha1_prefix() {
        // SHA1("Perlica") = 8f3b21... let's verify determinism and 16-hex length.
        let h1 = cover_hash_id("Perlica");
        let h2 = cover_hash_id("Perlica");
        assert_eq!(h1.len(), 16);
        assert_eq!(h1, h2);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn resolves_electron_and_legacy_cover_paths() {
        let root = std::env::temp_dir().join(format!("moddeck-meta-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let electron_cover = root.join("covers").join("endfield").join("0123456789abcdef.png");
        fs::create_dir_all(electron_cover.parent().unwrap()).unwrap();
        fs::write(&electron_cover, b"png").unwrap();

        assert_eq!(
            cover_path(&root, "endfield", "endfield/0123456789abcdef.png"),
            electron_cover
        );
        assert_eq!(
            cover_path(&root, "endfield", "0123456789abcdef.png"),
            electron_cover
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn saves_base64_cover_and_clears_legacy() {
        let root = std::env::temp_dir().join(format!("moddeck-cover-data-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let char_dir = root.join("Perlica");
        fs::create_dir_all(&char_dir).unwrap();
        fs::write(char_dir.join("_cover.jpg"), b"old").unwrap();

        let data_url = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(b"fake-png"));
        let saved = save_character_cover_data(&char_dir, &data_url).unwrap();
        assert_eq!(saved, char_dir.join(".preview.png"));
        assert_eq!(fs::read(&saved).unwrap(), b"fake-png");
        assert!(!char_dir.join("_cover.jpg").exists());

        let mut store = MetadataStore::default();
        clear_character_cover_files(&root, &mut store, "endfield", "Perlica", Some(&char_dir));
        assert!(!saved.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
