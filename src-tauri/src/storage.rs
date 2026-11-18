use crate::library::{
    is_inside, is_safe_segment, move_dir_or_copy, resolve_character_base, resolve_character_dir,
    scan_game_category_covers,
};
use crate::metadata::{load_metadata, save_metadata, METADATA_FILE};
use crate::models::{
    ConfigBundleInspection, ConfigBundleManifest, ConfigBundleRestoredCounts, ConfigBundleStats,
    GameSettings, ImportConfigBundleOptions, ImportConfigBundleResult, MetadataStore,
    ModBackupEntry, PruneBackupsResult, Settings, StorageCategoryStat, StorageOverview,
    ToggleResult,
};
use crate::settings::{normalize_settings, save_settings_atomic};
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn format_timestamp_dir_utc() -> String {
    let dt = OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}-{:03}Z",
        dt.year(),
        dt.month() as u8,
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
        dt.millisecond()
    )
}

fn parse_timestamp_dir(name: &str, fallback_ms: u64) -> u64 {
    // Matches Electron's format: 2026-11-13T12-30-45-123Z
    let b = name.as_bytes();
    if b.len() != 24 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b'-' || b[16] != b'-' || b[19] != b'-' || b[23] != b'Z' {
        return fallback_ms;
    }
    let Ok(year) = name[0..4].parse::<i32>() else {
        return fallback_ms;
    };
    let Ok(month_u8) = name[5..7].parse::<u8>() else {
        return fallback_ms;
    };
    let Ok(month) = Month::try_from(month_u8) else {
        return fallback_ms;
    };
    let Ok(day) = name[8..10].parse::<u8>() else {
        return fallback_ms;
    };
    let Ok(hour) = name[11..13].parse::<u8>() else {
        return fallback_ms;
    };
    let Ok(min) = name[14..16].parse::<u8>() else {
        return fallback_ms;
    };
    let Ok(sec) = name[17..19].parse::<u8>() else {
        return fallback_ms;
    };
    let Ok(ms) = name[20..23].parse::<u16>() else {
        return fallback_ms;
    };
    let Ok(date) = Date::from_calendar_date(year, month, day) else {
        return fallback_ms;
    };
    let Ok(t) = Time::from_hms_milli(hour, min, sec, ms) else {
        return fallback_ms;
    };
    let unix_ns = PrimitiveDateTime::new(date, t).assume_utc().unix_timestamp_nanos();
    if unix_ns <= 0 {
        fallback_ms
    } else {
        (unix_ns / 1_000_000) as u64
    }
}

fn measure_path_stats(target: &Path) -> (usize, u64) {
    if !target.exists() {
        return (0, 0);
    }
    if target.is_file() {
        let len = fs::metadata(target).map(|m| m.len()).unwrap_or(0);
        return (1, len);
    }
    if !target.is_dir() {
        return (0, 0);
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    for entry in WalkDir::new(target).into_iter().flatten() {
        if entry.file_type().is_file() {
            file_count += 1;
            if let Ok(meta) = entry.metadata() {
                total_bytes = total_bytes.saturating_add(meta.len());
            }
        }
    }
    (file_count, total_bytes)
}

fn dir_modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_epoch_ms)
}

fn cleanup_empty_parents(start_dir: &Path, stop_at: &Path) {
    let mut current = start_dir.to_path_buf();
    while current != stop_at && is_inside(stop_at, &current) {
        let Ok(mut entries) = fs::read_dir(&current) else {
            break;
        };
        if entries.next().is_some() {
            break;
        }
        if fs::remove_dir(&current).is_err() {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.to_path_buf();
    }
}

fn collect_mod_backup_leaf_dirs(game_dir: &Path) -> Vec<PathBuf> {
    let mut leaves = Vec::new();
    let Ok(l1) = fs::read_dir(game_dir) else {
        return leaves;
    };
    for e1 in l1.flatten() {
        let p1 = e1.path();
        if !p1.is_dir() {
            continue;
        }
        let l2: Vec<PathBuf> = fs::read_dir(&p1)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .collect();
        let sub_dirs2: Vec<PathBuf> = l2.iter().filter(|p| p.is_dir()).cloned().collect();
        if sub_dirs2.is_empty() {
            leaves.push(p1);
            continue;
        }
        let l2_all_dirs = l2.iter().all(|p| p.is_dir());
        let p1_is_mods = e1
            .file_name()
            .to_str()
            .map(|s| s.to_ascii_lowercase().contains("mod"))
            .unwrap_or(false);

        for p2 in sub_dirs2 {
            let l3: Vec<PathBuf> = fs::read_dir(&p2)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .collect();
            let sub_dirs3: Vec<PathBuf> = l3.iter().filter(|p| p.is_dir()).cloned().collect();
            if !sub_dirs3.is_empty() && l2_all_dirs && p1_is_mods {
                leaves.extend(sub_dirs3);
            } else {
                let has_ini_at_p2 = l3.iter().any(|p| {
                    p.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|s| s.to_ascii_lowercase().ends_with(".ini"))
                            .unwrap_or(false)
                });
                if has_ini_at_p2 || sub_dirs3.is_empty() {
                    leaves.push(p2);
                } else {
                    leaves.extend(sub_dirs3);
                }
            }
        }
    }
    leaves
}

fn resolve_existing_mod_target(
    char_dir: &Path,
    mod_folder: &str,
) -> Result<(PathBuf, String), String> {
    if !is_safe_segment(mod_folder) {
        return Err("Invalid mod folder name".to_string());
    }
    let base_name = strip_disabled_prefix(mod_folder).to_string();
    let mut target = char_dir.join(mod_folder);
    if !target.exists() {
        let alt = if mod_folder.len() >= 9
            && mod_folder.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
        {
            base_name.clone()
        } else {
            format!("DISABLED_{base_name}")
        };
        target = char_dir.join(alt);
    }
    if !is_inside(char_dir, &target) {
        return Err("Target mod path escapes character folder".to_string());
    }
    if !target.exists() {
        return Err(format!("Mod folder does not exist: {mod_folder}"));
    }
    Ok((target, base_name))
}

/// Moves one or more Mod folders into the OS Recycle Bin and prunes matching recent-mod entries.
pub fn delete_mods_to_trash(
    settings: &mut Settings,
    game_id: &str,
    character_folder: &str,
    mod_folders: &[String],
) -> Result<(), String> {
    if mod_folders.is_empty() {
        return Ok(());
    }
    let mods_path = settings
        .games
        .get(game_id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return Err("Mods directory is not configured".to_string());
    }
    let char_dir = resolve_character_dir(Path::new(mods_path), character_folder)?;

    let mut targets = Vec::with_capacity(mod_folders.len());
    let mut base_names = HashSet::with_capacity(mod_folders.len());
    for folder in mod_folders {
        let (target, base) = resolve_existing_mod_target(&char_dir, folder)?;
        targets.push(target);
        base_names.insert(base);
    }

    trash::delete_all(&targets)
        .map_err(|e| format!("Failed to move mod(s) to Recycle Bin: {e}"))?;

    settings.recent_mods.retain(|item| {
        !(item.game_id == game_id
            && item.character_folder == character_folder
            && base_names.contains(&item.name))
    });
    Ok(())
}

/// Moves a Mod folder into the OS Recycle Bin and prunes matching recent-mod entries.
#[allow(dead_code)]
pub fn delete_mod_to_trash(
    settings: &mut Settings,
    game_id: &str,
    character_folder: &str,
    mod_folder: &str,
) -> Result<(), String> {
    delete_mods_to_trash(
        settings,
        game_id,
        character_folder,
        &[mod_folder.to_string()],
    )
}

fn strip_disabled_prefix(name: &str) -> &str {
    if name.len() >= 9 && name.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_") {
        &name[9..]
    } else {
        name
    }
}

pub fn get_storage_overview(base_dir: &Path, settings: &Settings) -> StorageOverview {
    let config_files = ["settings.json", METADATA_FILE, "roster-presets.json", "roster-cache.json"];
    let mut config_count = 0usize;
    let mut config_bytes = 0u64;
    for f in config_files {
        let (fc, tb) = measure_path_stats(&base_dir.join(f));
        config_count += fc;
        config_bytes = config_bytes.saturating_add(tb);
    }
    for dir in ["presets", "languages"] {
        let (fc, tb) = measure_path_stats(&base_dir.join(dir));
        config_count += fc;
        config_bytes = config_bytes.saturating_add(tb);
    }

    let (cover_fc, cover_tb) = measure_path_stats(&base_dir.join("covers"));
    let mut cat_cover_fc = 0usize;
    let mut cat_cover_tb = 0u64;
    let mut seen_mods = HashSet::new();
    for gs in settings.games.values() {
        let mp = gs.mods_path.trim();
        if mp.is_empty() || !seen_mods.insert(mp.to_ascii_lowercase()) {
            continue;
        }
        for item in scan_game_category_covers(Path::new(mp)) {
            cat_cover_fc += 1;
            cat_cover_tb = cat_cover_tb.saturating_add(item.size);
        }
    }

    let backups_root = base_dir.join("backups");
    let (backup_fc, backup_tb) = measure_path_stats(&backups_root);
    let (logs_fc, logs_tb) = measure_path_stats(&base_dir.join("logs"));

    let categories = vec![
        StorageCategoryStat {
            key: "config".to_string(),
            file_count: config_count,
            total_bytes: config_bytes,
        },
        StorageCategoryStat {
            key: "covers".to_string(),
            file_count: cover_fc + cat_cover_fc,
            total_bytes: cover_tb + cat_cover_tb,
        },
        StorageCategoryStat {
            key: "backups".to_string(),
            file_count: backup_fc,
            total_bytes: backup_tb,
        },
        StorageCategoryStat {
            key: "logs".to_string(),
            file_count: logs_fc,
            total_bytes: logs_tb,
        },
    ];

    let mut backups = Vec::new();
    if backups_root.is_dir() {
        if let Ok(ts_entries) = fs::read_dir(&backups_root) {
            for ts_entry in ts_entries.flatten() {
                let ts_path = ts_entry.path();
                if !ts_path.is_dir() {
                    continue;
                }
                let Some(ts_name) = ts_entry.file_name().to_str().map(str::to_string) else {
                    continue;
                };
                if ts_name == "config-snapshots" {
                    continue;
                }
                let created_at = parse_timestamp_dir(&ts_name, dir_modified_ms(&ts_path));
                let Ok(game_entries) = fs::read_dir(&ts_path) else {
                    continue;
                };
                for game_entry in game_entries.flatten() {
                    let game_dir = game_entry.path();
                    if !game_dir.is_dir() {
                        continue;
                    }
                    let Some(game_id) = game_entry.file_name().to_str().map(str::to_string) else {
                        continue;
                    };
                    for leaf in collect_mod_backup_leaf_dirs(&game_dir) {
                        let Ok(rel_from_game) = leaf.strip_prefix(&game_dir) else {
                            continue;
                        };
                        let parts: Vec<String> = rel_from_game
                            .components()
                            .filter_map(|c| c.as_os_str().to_str().map(str::to_string))
                            .filter(|s| !s.is_empty())
                            .collect();
                        if parts.is_empty() {
                            continue;
                        }
                        let mod_name = parts[parts.length_or_last_idx()].clone();
                        let character_folder = if parts.len() >= 2 {
                            parts[parts.len() - 2].clone()
                        } else {
                            String::new()
                        };
                        let (file_count, total_bytes) = measure_path_stats(&leaf);
                        let id = leaf
                            .strip_prefix(&backups_root)
                            .ok()
                            .map(|p| {
                                p.components()
                                    .filter_map(|c| c.as_os_str().to_str())
                                    .collect::<Vec<_>>()
                                    .join("/")
                            })
                            .unwrap_or_default();
                        if id.is_empty() {
                            continue;
                        }
                        let mods_path = settings
                            .games
                            .get(&game_id)
                            .map(|g| g.mods_path.trim())
                            .unwrap_or("");
                        let target_exists = if mods_path.is_empty() {
                            false
                        } else if !character_folder.is_empty() {
                            Path::new(mods_path)
                                .join(&character_folder)
                                .join(&mod_name)
                                .exists()
                        } else {
                            Path::new(mods_path).join(&mod_name).exists()
                        };

                        backups.push(ModBackupEntry {
                            id,
                            timestamp_dir: ts_name.clone(),
                            created_at,
                            game_id: game_id.clone(),
                            character_folder,
                            mod_name,
                            total_bytes,
                            file_count,
                            backup_path: leaf.to_string_lossy().to_string(),
                            target_exists,
                        });
                    }
                }
            }
        }
    }

    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let total_bytes = categories.iter().fold(0u64, |acc, c| acc.saturating_add(c.total_bytes));

    StorageOverview {
        data_dir: base_dir.to_string_lossy().to_string(),
        total_bytes,
        categories,
        backups,
    }
}

trait LastIndexHelper {
    fn length_or_last_idx(&self) -> usize;
}
impl<T> LastIndexHelper for Vec<T> {
    fn length_or_last_idx(&self) -> usize {
        self.len().saturating_sub(1)
    }
}

pub fn restore_mod_backup(
    base_dir: &Path,
    backup_id: &str,
    settings: &Settings,
) -> ToggleResult {
    let backups_root = base_dir.join("backups");
    let segments: Vec<&str> = backup_id.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 3 || segments.iter().any(|s| *s == "." || *s == "..") {
        return ToggleResult::err("Invalid backup ID");
    }
    let mut backup_path = backups_root.clone();
    for seg in &segments {
        backup_path.push(seg);
    }
    if !is_inside(&backups_root, &backup_path) || !backup_path.is_dir() {
        return ToggleResult::err("Backup folder does not exist or path is invalid");
    }

    let game_id = segments[1];
    let rest = &segments[2..];
    let Some(mods_path) = settings
        .games
        .get(game_id)
        .map(|g| g.mods_path.trim())
        .filter(|s| !s.is_empty())
    else {
        return ToggleResult::err(format!("Mods directory is not configured for game '{game_id}'"));
    };
    let mods_root = Path::new(mods_path);
    if !mods_root.is_dir() {
        return ToggleResult::err(format!("Mods directory does not exist: {mods_path}"));
    }

    let mod_name = rest[rest.len() - 1];
    let character_folder = if rest.len() >= 2 { rest[rest.len() - 2] } else { "" };
    let target_parent = if character_folder.is_empty() {
        mods_root.to_path_buf()
    } else {
        mods_root.join(character_folder)
    };
    let target_dir = target_parent.join(mod_name);
    if !is_inside(mods_root, &target_dir) {
        return ToggleResult::err("Restore target escapes mods directory");
    }
    if let Err(err) = fs::create_dir_all(&target_parent) {
        return ToggleResult::err(format!("Failed to create target folder: {err}"));
    }

    if target_dir.exists() {
        let fallback_char = mods_root
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Mods");
        let safe_backup = backups_root
            .join(format_timestamp_dir_utc())
            .join(game_id)
            .join(if character_folder.is_empty() {
                fallback_char
            } else {
                character_folder
            })
            .join(mod_name);
        if let Err(err) = move_dir_or_copy(&target_dir, &safe_backup) {
            return ToggleResult::err(err);
        }
    }

    if let Err(err) = move_dir_or_copy(&backup_path, &target_dir) {
        return ToggleResult::err(err);
    }
    if let Some(parent) = backup_path.parent() {
        cleanup_empty_parents(parent, &backups_root);
    }
    ToggleResult::ok()
}

pub fn delete_mod_backup(base_dir: &Path, backup_id: &str) -> ToggleResult {
    let backups_root = base_dir.join("backups");
    let segments: Vec<&str> = backup_id.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() || segments.iter().any(|s| *s == "." || *s == "..") {
        return ToggleResult::err("Invalid backup ID");
    }
    let mut backup_path = backups_root.clone();
    for seg in &segments {
        backup_path.push(seg);
    }
    if !is_inside(&backups_root, &backup_path) || !backup_path.exists() {
        return ToggleResult::err("Backup folder does not exist");
    }
    let res = if backup_path.is_dir() {
        fs::remove_dir_all(&backup_path)
    } else {
        fs::remove_file(&backup_path)
    };
    if let Err(err) = res {
        return ToggleResult::err(format!("Failed to delete backup: {err}"));
    }
    if let Some(parent) = backup_path.parent() {
        cleanup_empty_parents(parent, &backups_root);
    }
    ToggleResult::ok()
}

pub fn prune_mod_backups(base_dir: &Path, older_than_days: i64) -> PruneBackupsResult {
    let backups_root = base_dir.join("backups");
    if !backups_root.is_dir() {
        return PruneBackupsResult {
            ok: true,
            deleted_count: Some(0),
            freed_bytes: Some(0),
            error: None,
        };
    }
    let now = now_epoch_ms();
    let cutoff = if older_than_days <= 0 {
        u64::MAX
    } else {
        now.saturating_sub((older_than_days as u64).saturating_mul(86_400_000))
    };

    let mut deleted_count = 0usize;
    let mut freed_bytes = 0u64;
    if let Ok(entries) = fs::read_dir(&backups_root) {
        for entry in entries.flatten() {
            let ts_path = entry.path();
            if !ts_path.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name == "config-snapshots" {
                continue;
            }
            let created_at = parse_timestamp_dir(&name, dir_modified_ms(&ts_path));
            if created_at < cutoff {
                let (_, bytes) = measure_path_stats(&ts_path);
                if fs::remove_dir_all(&ts_path).is_ok() {
                    deleted_count += 1;
                    freed_bytes = freed_bytes.saturating_add(bytes);
                }
            }
        }
    }

    PruneBackupsResult {
        ok: true,
        deleted_count: Some(deleted_count),
        freed_bytes: Some(freed_bytes),
        error: None,
    }
}

fn add_dir_to_zip<W: Write + io_seek::Seek>(
    zip: &mut ZipWriter<W>,
    base_dir: &Path,
    sub_dir: &str,
    options: SimpleFileOptions,
) -> Result<usize, String> {
    let root = base_dir.join(sub_dir);
    if !root.is_dir() {
        return Ok(0);
    }
    let mut count = 0usize;
    for entry in WalkDir::new(&root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(base_dir) else {
            continue;
        };
        let rel_posix = rel
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join("/");
        let bytes = fs::read(entry.path())
            .map_err(|e| format!("Failed to read {}: {e}", entry.path().display()))?;
        zip.start_file(&rel_posix, options)
            .map_err(|e| format!("Zip write error: {e}"))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("Zip write error: {e}"))?;
        count += 1;
    }
    Ok(count)
}

mod io_seek {
    pub use std::io::Seek;
}

pub fn export_config_bundle(
    base_dir: &Path,
    app_version: &str,
    output_path: &Path,
    settings: &Settings,
) -> Result<ConfigBundleManifest, String> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create bundle dir {}: {e}", parent.display()))?;
    }
    let file = fs::File::create(output_path)
        .map_err(|e| format!("Failed to create bundle {}: {e}", output_path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for name in ["settings.json", METADATA_FILE, "roster-presets.json"] {
        let src = base_dir.join(name);
        if src.is_file() {
            let data = fs::read(&src).map_err(|e| format!("Failed to read {name}: {e}"))?;
            zip.start_file(name, options)
                .map_err(|e| format!("Zip write error: {e}"))?;
            zip.write_all(&data)
                .map_err(|e| format!("Zip write error: {e}"))?;
        }
    }

    let cover_files_count = add_dir_to_zip(&mut zip, base_dir, "covers", options)?;
    let mod_preset_files = add_dir_to_zip(&mut zip, base_dir, "presets", options)?;
    let language_files = add_dir_to_zip(&mut zip, base_dir, "languages", options)?;

    let mut cat_cover_count = 0usize;
    for (g_id, gs) in &settings.games {
        let mp = gs.mods_path.trim();
        if mp.is_empty() {
            continue;
        }
        for item in scan_game_category_covers(Path::new(mp)) {
            if let Ok(bytes) = fs::read(&item.file_path) {
                let entry_name = format!("category-covers/{g_id}/{}/{}", item.folder, item.file_name);
                zip.start_file(&entry_name, options)
                    .map_err(|e| format!("Zip write error: {e}"))?;
                zip.write_all(&bytes)
                    .map_err(|e| format!("Zip write error: {e}"))?;
                cat_cover_count += 1;
            }
        }
    }

    let meta = load_metadata(base_dir);
    let character_meta: usize = meta.games.values().map(|m| m.len()).sum();

    let roster_presets = fs::read_to_string(base_dir.join("roster-presets.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("presets").and_then(|p| p.as_object()).cloned())
        .map(|obj| {
            obj.values()
                .filter_map(|arr| arr.as_array().map(|a| a.len()))
                .sum::<usize>()
        })
        .unwrap_or(0);

    let manifest = ConfigBundleManifest {
        moddeck_file_type: "config-bundle".to_string(),
        version: 1,
        app_version: app_version.to_string(),
        exported_at: now_epoch_ms(),
        stats: ConfigBundleStats {
            custom_games: settings.custom_games.len(),
            character_meta,
            cover_files: cover_files_count + cat_cover_count,
            mod_preset_files,
            roster_presets,
            language_files,
        },
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("Zip write error: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("Zip write error: {e}"))?;
    zip.finish().map_err(|e| format!("Zip finish error: {e}"))?;

    Ok(manifest)
}

pub fn inspect_config_bundle(archive_path: &Path) -> ConfigBundleInspection {
    let file = match fs::File::open(archive_path) {
        Ok(f) => f,
        Err(err) => {
            return ConfigBundleInspection {
                ok: false,
                error: Some(format!("Failed to open archive: {err}")),
                file_path: None,
                manifest: None,
            };
        }
    };
    let mut zip = match ZipArchive::new(file) {
        Ok(z) => z,
        Err(err) => {
            return ConfigBundleInspection {
                ok: false,
                error: Some(format!("Invalid zip / config bundle archive: {err}")),
                file_path: None,
                manifest: None,
            };
        }
    };
    let Ok(mut entry) = zip.by_name("manifest.json") else {
        return ConfigBundleInspection {
            ok: false,
            error: Some("Invalid ModDeck config bundle (missing manifest.json)".to_string()),
            file_path: None,
            manifest: None,
        };
    };
    let mut buf = String::new();
    if entry.read_to_string(&mut buf).is_err() {
        return ConfigBundleInspection {
            ok: false,
            error: Some("Failed to read manifest.json".to_string()),
            file_path: None,
            manifest: None,
        };
    }
    let Ok(manifest) = serde_json::from_str::<ConfigBundleManifest>(&buf) else {
        return ConfigBundleInspection {
            ok: false,
            error: Some("Invalid manifest.json format".to_string()),
            file_path: None,
            manifest: None,
        };
    };
    if manifest.moddeck_file_type != "config-bundle" || manifest.version != 1 {
        return ConfigBundleInspection {
            ok: false,
            error: Some("Unsupported ModDeck config bundle version".to_string()),
            file_path: None,
            manifest: None,
        };
    }
    ConfigBundleInspection {
        ok: true,
        error: None,
        file_path: Some(archive_path.to_string_lossy().to_string()),
        manifest: Some(manifest),
    }
}

fn create_config_snapshot(base_dir: &Path) -> Result<PathBuf, String> {
    let snapshot_dir = base_dir
        .join("backups")
        .join("config-snapshots")
        .join(format_timestamp_dir_utc());
    fs::create_dir_all(&snapshot_dir)
        .map_err(|e| format!("Failed to create config snapshot: {e}"))?;
    for file in ["settings.json", METADATA_FILE, "roster-presets.json"] {
        let src = base_dir.join(file);
        if src.is_file() {
            let _ = fs::copy(&src, snapshot_dir.join(file));
        }
    }
    for dir in ["covers", "presets", "languages"] {
        let src = base_dir.join(dir);
        if src.is_dir() {
            let _ = crate::library::copy_dir_recursive(&src, &snapshot_dir.join(dir));
        }
    }
    Ok(snapshot_dir)
}

fn write_json_atomic_value(target: &Path, val: &Value) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }
    let tmp = target.with_extension(format!("json.tmp-{}", std::process::id()));
    let content =
        serde_json::to_string_pretty(val).map_err(|e| format!("Serialize JSON failed: {e}"))?;
    fs::write(&tmp, content).map_err(|e| format!("Write temp failed: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(target);
    }
    fs::rename(&tmp, target).map_err(|e| format!("Rename failed: {e}"))?;
    Ok(())
}

fn is_category_cover_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem_ok = lower.starts_with(".preview.") || lower.starts_with("_cover.");
    let ext_ok = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    stem_ok && ext_ok
}

pub fn import_config_bundle(
    base_dir: &Path,
    archive_path: &Path,
    current_settings: &Settings,
    options: &ImportConfigBundleOptions,
) -> (ImportConfigBundleResult, Option<Settings>, Option<MetadataStore>) {
    let file = match fs::File::open(archive_path) {
        Ok(f) => f,
        Err(err) => {
            return (
                ImportConfigBundleResult {
                    ok: false,
                    error: Some(format!("Failed to open config bundle: {err}")),
                    snapshot_dir: None,
                    restored: None,
                },
                None,
                None,
            );
        }
    };
    let mut zip = match ZipArchive::new(file) {
        Ok(z) => z,
        Err(err) => {
            return (
                ImportConfigBundleResult {
                    ok: false,
                    error: Some(format!("Invalid config bundle archive: {err}")),
                    snapshot_dir: None,
                    restored: None,
                },
                None,
                None,
            );
        }
    };

    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let Ok(mut entry) = zip.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/").trim_start_matches('/').to_string();
        let mut data = Vec::new();
        if entry.read_to_end(&mut data).is_ok() {
            entries.push((name, data));
        }
    }

    let manifest = entries
        .iter()
        .find(|(n, _)| n == "manifest.json")
        .and_then(|(_, d)| serde_json::from_slice::<ConfigBundleManifest>(d).ok());
    if !manifest
        .as_ref()
        .map(|m| m.moddeck_file_type == "config-bundle" && m.version == 1)
        .unwrap_or(false)
    {
        return (
            ImportConfigBundleResult {
                ok: false,
                error: Some("Invalid config bundle manifest".to_string()),
                snapshot_dir: None,
                restored: None,
            },
            None,
            None,
        );
    }

    let snapshot_dir = match create_config_snapshot(base_dir) {
        Ok(p) => p,
        Err(err) => {
            return (
                ImportConfigBundleResult {
                    ok: false,
                    error: Some(err),
                    snapshot_dir: None,
                    restored: None,
                },
                None,
                None,
            );
        }
    };

    let mut custom_games_restored = 0usize;
    let mut character_meta_restored = 0usize;
    let mut cover_files_restored = 0usize;
    let mut mod_preset_files_restored = 0usize;
    let mut roster_presets_restored = 0usize;
    let mut language_files_restored = 0usize;

    let mut merged_settings = current_settings.clone();
    let mut updated_settings_opt: Option<Settings> = None;

    if let Some((_, bytes)) = entries.iter().find(|(n, _)| n == "settings.json") {
        if let Ok(incoming) = serde_json::from_slice::<Settings>(bytes) {
            let mut merged_games: HashMap<String, GameSettings> = merged_settings.games.clone();
            for (g_id, inc_game) in &incoming.games {
                if options.preserve_existing_paths {
                    let local_game = merged_games.get(g_id).cloned().unwrap_or_default();
                    let keep_str = |local_val: &str, inc_val: &str| -> String {
                        if !local_val.trim().is_empty() {
                            local_val.to_string()
                        } else if !inc_val.trim().is_empty() && Path::new(inc_val.trim()).exists() {
                            inc_val.to_string()
                        } else {
                            String::new()
                        }
                    };
                    let keep_opt = |local_opt: Option<&str>, inc_opt: Option<&str>| -> Option<String> {
                        let local_v = local_opt.unwrap_or("").trim();
                        if !local_v.is_empty() {
                            return Some(local_v.to_string());
                        }
                        let inc_v = inc_opt.unwrap_or("").trim();
                        if !inc_v.is_empty() && Path::new(inc_v).exists() {
                            return Some(inc_v.to_string());
                        }
                        None
                    };
                    merged_games.insert(
                        g_id.clone(),
                        GameSettings {
                            mods_path: keep_str(&local_game.mods_path, &inc_game.mods_path),
                            game_path: keep_opt(
                                local_game.game_path.as_deref(),
                                inc_game.game_path.as_deref(),
                            ),
                            loader_path: keep_opt(
                                local_game.loader_path.as_deref(),
                                inc_game.loader_path.as_deref(),
                            ),
                            launch_args: inc_game
                                .launch_args
                                .clone()
                                .or(local_game.launch_args.clone()),
                        },
                    );
                } else {
                    merged_games.insert(g_id.clone(), inc_game.clone());
                }
            }

            let mut custom_map: Vec<crate::models::GameDef> = merged_settings.custom_games.clone();
            for cg in &incoming.custom_games {
                if let Some(pos) = custom_map.iter().position(|x| x.id == cg.id) {
                    custom_map[pos] = cg.clone();
                } else {
                    custom_map.push(cg.clone());
                }
                custom_games_restored += 1;
            }

            let next_xxmi = if options.preserve_existing_paths {
                merged_settings.xxmi_root.clone().or(incoming.xxmi_root.clone())
            } else {
                incoming.xxmi_root.clone()
            };

            let mut next = incoming;
            next.xxmi_root = next_xxmi;
            next.games = merged_games;
            next.custom_games = custom_map;
            let normalized = normalize_settings(next);
            if save_settings_atomic(base_dir, &normalized).is_ok() {
                merged_settings = normalized.clone();
                updated_settings_opt = Some(normalized);
            }
        }
    }

    let mut next_meta = load_metadata(base_dir);
    let mut meta_dirty = false;
    if let Some((_, bytes)) = entries.iter().find(|(n, _)| n == METADATA_FILE) {
        if let Ok(incoming_meta) = serde_json::from_slice::<MetadataStore>(bytes) {
            for (g_id, inc_chars) in incoming_meta.games {
                let entry_map = next_meta.games.entry(g_id).or_default();
                for (ch_folder, ch_meta) in inc_chars {
                    entry_map.insert(ch_folder, ch_meta);
                    character_meta_restored += 1;
                }
            }
            for (g_id, ts) in incoming_meta.roster_initialized {
                next_meta.roster_initialized.entry(g_id).or_insert(ts);
            }
            meta_dirty = true;
        }
    }

    if let Some((_, bytes)) = entries.iter().find(|(n, _)| n == "roster-presets.json") {
        if let Ok(incoming_roster) = serde_json::from_slice::<Value>(bytes) {
            if let Some(inc_presets) = incoming_roster.get("presets").and_then(|v| v.as_object()) {
                let target_path = base_dir.join("roster-presets.json");
                let mut current_val = fs::read_to_string(&target_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or_else(|| serde_json::json!({ "schemaVersion": 1, "presets": {} }));
                let presets_obj = current_val
                    .as_object_mut()
                    .and_then(|o| o.entry("presets").or_insert_with(|| serde_json::json!({})).as_object_mut());
                if let Some(merged_presets) = presets_obj {
                    for (g_id, inc_arr_val) in inc_presets {
                        let Some(inc_arr) = inc_arr_val.as_array() else {
                            continue;
                        };
                        let mut existing_items = merged_presets
                            .get(g_id)
                            .and_then(|v| v.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for item in inc_arr {
                            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            if !id.is_empty() {
                                if let Some(pos) = existing_items
                                    .iter()
                                    .position(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))
                                {
                                    existing_items[pos] = item.clone();
                                } else {
                                    existing_items.push(item.clone());
                                }
                            } else {
                                existing_items.push(item.clone());
                            }
                            roster_presets_restored += 1;
                        }
                        merged_presets.insert(g_id.clone(), Value::Array(existing_items));
                    }
                    let _ = write_json_atomic_value(&target_path, &current_val);
                }
            }
        }
    }

    for (clean_posix, data) in &entries {
        let parts: Vec<&str> = clean_posix.split('/').filter(|s| !s.is_empty()).collect();
        if parts.is_empty() || parts.iter().any(|s| *s == "." || *s == "..") {
            continue;
        }
        let prefix = parts[0];

        if prefix == "category-covers" && parts.len() == 4 {
            let (g_id, char_folder, file_name) = (parts[1], parts[2], parts[3]);
            if !is_safe_segment(g_id) || !is_safe_segment(char_folder) || !is_category_cover_filename(file_name) {
                continue;
            }
            let mut wrote_directly = false;
            if let Some(mp) = merged_settings
                .games
                .get(g_id)
                .map(|g| g.mods_path.trim())
                .filter(|s| !s.is_empty())
            {
                let mods_dir = Path::new(mp);
                if mods_dir.is_dir() {
                    let char_base = resolve_character_base(mods_dir);
                    let target_char = char_base.join(char_folder);
                    if is_inside(&char_base, &target_char) && target_char.is_dir() {
                        let dest = target_char.join(file_name);
                        if is_inside(&target_char, &dest) && fs::write(&dest, data).is_ok() {
                            wrote_directly = true;
                        }
                    }
                }
            }
            if !wrote_directly {
                let ext = Path::new(file_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| format!(".{}", e.to_ascii_lowercase()))
                    .unwrap_or_else(|| ".png".to_string());
                let mut hasher = Sha1::new();
                hasher.update(format!("{g_id}/{char_folder}").as_bytes());
                let digest = hasher.finalize();
                let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
                let rel_cover = format!("{g_id}/{hex}{ext}");
                let abs_cover = base_dir.join("covers").join(g_id).join(format!("{hex}{ext}"));
                if let Some(parent) = abs_cover.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if fs::write(&abs_cover, data).is_ok() {
                    let char_meta = next_meta
                        .games
                        .entry(g_id.to_string())
                        .or_default()
                        .entry(char_folder.to_string())
                        .or_default();
                    char_meta.cover_file = Some(rel_cover);
                    meta_dirty = true;
                }
            }
            cover_files_restored += 1;
            continue;
        }

        if !matches!(prefix, "covers" | "presets" | "languages") {
            continue;
        }
        let allowed_root = base_dir.join(prefix);
        let mut dest = base_dir.to_path_buf();
        for seg in &parts {
            if seg.contains(':') || seg.contains('\0') {
                dest = PathBuf::new();
                break;
            }
            dest.push(seg);
        }
        if dest.as_os_str().is_empty() || !is_inside(&allowed_root, &dest) {
            continue;
        }
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&dest, data).is_ok() {
            match prefix {
                "covers" => cover_files_restored += 1,
                "presets" => mod_preset_files_restored += 1,
                "languages" => language_files_restored += 1,
                _ => {}
            }
        }
    }

    let updated_meta_opt = if meta_dirty {
        let _ = save_metadata(base_dir, &next_meta);
        Some(next_meta)
    } else {
        None
    };

    (
        ImportConfigBundleResult {
            ok: true,
            error: None,
            snapshot_dir: Some(snapshot_dir.to_string_lossy().to_string()),
            restored: Some(ConfigBundleRestoredCounts {
                custom_games: custom_games_restored,
                character_meta: character_meta_restored,
                cover_files: cover_files_restored,
                mod_preset_files: mod_preset_files_restored,
                roster_presets: roster_presets_restored,
                language_files: language_files_restored,
            }),
        },
        updated_settings_opt,
        updated_meta_opt,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_settings;

    #[test]
    fn storage_overview_restore_delete_prune_and_bundle_roundtrip() {
        let root = std::env::temp_dir().join(format!("moddeck-storage-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        let char_dir = mods_dir.join("Anke");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&char_dir).unwrap();

        let mut settings = default_settings();
        settings.games.get_mut("wuthering-waves").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        save_settings_atomic(&base_dir, &settings).unwrap();

        let backup_mod = base_dir
            .join("backups")
            .join("2020-01-01T00-00-00-000Z")
            .join("wuthering-waves")
            .join("Anke")
            .join("TestSkin");
        fs::create_dir_all(&backup_mod).unwrap();
        fs::write(backup_mod.join("mod.ini"), b"[Constants]").unwrap();

        let overview = get_storage_overview(&base_dir, &settings);
        assert_eq!(overview.backups.len(), 1);
        assert_eq!(overview.backups[0].mod_name, "TestSkin");
        assert!(!overview.backups[0].target_exists);

        let restore_res = restore_mod_backup(&base_dir, &overview.backups[0].id, &settings);
        assert!(restore_res.ok, "{:?}", restore_res.error);
        assert!(char_dir.join("TestSkin").join("mod.ini").is_file());

        let bundle_path = root.join("export.moddeck-bundle");
        let manifest = export_config_bundle(&base_dir, "3.0.0-alpha.3", &bundle_path, &settings).unwrap();
        assert_eq!(manifest.moddeck_file_type, "config-bundle");
        let inspected = inspect_config_bundle(&bundle_path);
        assert!(inspected.ok);

        let (imp_res, _, _) = import_config_bundle(
            &base_dir,
            &bundle_path,
            &settings,
            &ImportConfigBundleOptions {
                preserve_existing_paths: true,
            },
        );
        assert!(imp_res.ok, "{:?}", imp_res.error);

        let old_backup = base_dir
            .join("backups")
            .join("2020-01-02T00-00-00-000Z")
            .join("wuthering-waves")
            .join("Anke")
            .join("OldSkin");
        fs::create_dir_all(&old_backup).unwrap();
        fs::write(old_backup.join("a.txt"), b"hello").unwrap();
        let pruned = prune_mod_backups(&base_dir, 30);
        assert!(pruned.ok);
        assert_eq!(pruned.deleted_count, Some(1));
        assert_eq!(pruned.freed_bytes, Some(5));

        let _ = fs::remove_dir_all(&root);
    }
}
