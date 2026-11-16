use crate::models::{GameDef, RosterCacheFile, RosterEntry, RosterSyncResult, RosterSyncStatus};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BUILTIN_ROSTER_JSON: &str = include_str!("../../roster.json");
const ROSTER_CACHE_FILE: &str = "roster-cache.json";

static BUILTIN_ROSTER: OnceLock<RosterCacheFile> = OnceLock::new();

/// Parses and caches the embedded `roster.json` once for the process lifetime.
pub fn builtin_roster() -> &'static RosterCacheFile {
    BUILTIN_ROSTER.get_or_init(|| {
        serde_json::from_str::<RosterCacheFile>(BUILTIN_ROSTER_JSON).unwrap_or_default()
    })
}

/// Normalizes a character/folder identifier for fuzzy dictionary matching.
pub fn normalize_match_text(text: &str) -> String {
    let trimmed = text.trim();
    let without_disabled = if trimmed.len() >= 9 && trimmed.as_bytes()[..9].eq_ignore_ascii_case(b"disabled_")
    {
        &trimmed[9..]
    } else {
        trimmed
    };

    without_disabled
        .chars()
        .filter(|c| {
            !c.is_whitespace()
                && !matches!(
                    c,
                    '_' | '-' | '·' | '・' | '&' | '(' | ')' | '（' | '）' | '【' | '】' | '[' | ']' | '「' | '」'
                )
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Returns a sanitized roster entry, dropping blank `zh` rows.
pub fn sanitize_roster_entry(entry: &RosterEntry) -> Option<RosterEntry> {
    let zh = entry.zh.trim().to_string();
    if zh.is_empty() {
        return None;
    }
    let en = entry.en.trim().to_string();
    let pinyin = entry.pinyin.trim().to_lowercase();
    let mut seen_aliases = HashSet::new();
    let mut aliases = Vec::new();
    for a in &entry.aliases {
        let cleaned = a.trim().to_string();
        if !cleaned.is_empty() && seen_aliases.insert(cleaned.clone()) {
            aliases.push(cleaned);
        }
    }
    let kind = match entry.kind.as_deref() {
        Some("utility") => Some("utility".to_string()),
        Some("character") => Some("character".to_string()),
        _ => None,
    };
    Some(RosterEntry {
        zh,
        en,
        pinyin,
        aliases,
        kind,
    })
}

pub fn roster_cache_path(base_dir: &Path) -> PathBuf {
    base_dir.join(ROSTER_CACHE_FILE)
}

pub fn load_roster_cache(base_dir: &Path) -> Option<RosterCacheFile> {
    let path = roster_cache_path(base_dir);
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<RosterCacheFile>(&raw).ok()
}

fn save_roster_cache(base_dir: &Path, cache: &RosterCacheFile) -> Result<(), String> {
    fs::create_dir_all(base_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    let target = roster_cache_path(base_dir);
    let temp = base_dir.join(format!("{ROSTER_CACHE_FILE}.tmp-{}", std::process::id()));
    let content =
        serde_json::to_string_pretty(cache).map_err(|e| format!("Serialize roster failed: {e}"))?;
    fs::write(&temp, content).map_err(|e| format!("Write roster temp failed: {e}"))?;
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    fs::rename(&temp, &target).map_err(|e| format!("Rename roster cache failed: {e}"))?;
    Ok(())
}

/// Merges built-in roster entries with remote cached entries by normalized `zh`.
pub fn get_merged_roster(game_id: &str, cache: Option<&RosterCacheFile>) -> Vec<RosterEntry> {
    let builtin = builtin_roster()
        .games
        .get(game_id)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let remote = cache
        .and_then(|c| c.games.get(game_id))
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    if remote.is_empty() {
        return builtin.to_vec();
    }

    let mut merged: Vec<RosterEntry> = Vec::with_capacity(builtin.len() + remote.len());
    let mut index_by_key: HashMap<String, usize> = HashMap::new();

    for item in builtin {
        let key = normalize_match_text(&item.zh);
        if key.is_empty() || index_by_key.contains_key(&key) {
            continue;
        }
        index_by_key.insert(key, merged.len());
        merged.push(item.clone());
    }

    for raw_remote in remote {
        let Some(entry) = sanitize_roster_entry(raw_remote) else {
            continue;
        };
        let key = normalize_match_text(&entry.zh);
        if key.is_empty() {
            continue;
        }
        if let Some(&idx) = index_by_key.get(&key) {
            let existing = &mut merged[idx];
            if !entry.en.is_empty() {
                existing.en = entry.en;
            }
            if !entry.pinyin.is_empty() {
                existing.pinyin = entry.pinyin;
            }
            if entry.kind.is_some() {
                existing.kind = entry.kind;
            }
            let mut seen: HashSet<String> = existing.aliases.iter().cloned().collect();
            for alias in entry.aliases {
                if seen.insert(alias.clone()) {
                    existing.aliases.push(alias);
                }
            }
        } else {
            index_by_key.insert(key, merged.len());
            merged.push(entry);
        }
    }

    merged
}

/// Builds the localized roster name list map exposed to the renderer on bootstrap.
pub fn get_roster_map(
    games: &[GameDef],
    cache: Option<&RosterCacheFile>,
    prefer_en: bool,
) -> HashMap<String, Vec<String>> {
    let mut map = HashMap::new();
    for game in games {
        let merged = get_merged_roster(&game.id, cache);
        let mut names = Vec::with_capacity(merged.len() + 1);
        let mut seen = HashSet::new();
        let others = if prefer_en { "Others" } else { "其他" }.to_string();
        seen.insert(others.clone());
        names.push(others);

        for item in merged {
            if item.zh == "其他" {
                continue;
            }
            let label = if prefer_en && !item.en.is_empty() {
                item.en
            } else {
                item.zh
            };
            if seen.insert(label.clone()) {
                names.push(label);
            }
        }
        map.insert(game.id.clone(), names);
    }
    map
}

fn entry_matches(entry: &RosterEntry, normalized_needle: &str) -> bool {
    if normalized_needle.is_empty() {
        return false;
    }
    if normalize_match_text(&entry.zh) == normalized_needle
        || (!entry.en.is_empty() && normalize_match_text(&entry.en) == normalized_needle)
        || (!entry.pinyin.is_empty() && normalize_match_text(&entry.pinyin) == normalized_needle)
    {
        return true;
    }
    entry
        .aliases
        .iter()
        .any(|alias| normalize_match_text(alias) == normalized_needle)
}

pub fn find_roster_entry(
    game_id: &str,
    folder_or_name: &str,
    cache: Option<&RosterCacheFile>,
) -> Option<RosterEntry> {
    let needle = normalize_match_text(folder_or_name);
    if needle.is_empty() {
        return None;
    }
    get_merged_roster(game_id, cache)
        .into_iter()
        .find(|entry| entry_matches(entry, &needle))
}

pub fn find_canonical_en(
    game_id: &str,
    folder_or_name: &str,
    cache: Option<&RosterCacheFile>,
) -> Option<String> {
    find_roster_entry(game_id, folder_or_name, cache)
        .map(|entry| entry.en)
        .filter(|en| !en.is_empty())
}

#[allow(dead_code)]
pub fn find_canonical_zh(
    game_id: &str,
    folder_or_name: &str,
    cache: Option<&RosterCacheFile>,
) -> Option<String> {
    find_roster_entry(game_id, folder_or_name, cache)
        .map(|entry| entry.zh)
        .filter(|zh| !zh.is_empty())
}

/// Determines whether a character folder represents a regular character or a utility category.
pub fn infer_character_kind(
    game_id: &str,
    folder: &str,
    meta_kind: Option<&str>,
    cache: Option<&RosterCacheFile>,
) -> String {
    if meta_kind == Some("utility") {
        return "utility".to_string();
    }
    if meta_kind == Some("character") {
        return "character".to_string();
    }
    if let Some(entry) = find_roster_entry(game_id, folder, cache) {
        if entry.kind.as_deref() == Some("utility") {
            return "utility".to_string();
        }
    }
    let lower = folder.to_lowercase();
    if [
        "ui",
        "interface",
        "界面",
        "功能",
        "工具",
        "其他",
        "其它",
        "大世界",
        "世界",
        "npc",
        "武器",
        "weapon",
        "glider",
        "vehicle",
        "载具",
        "other",
        "others",
        "tool",
        "tools",
        "function",
        "functions",
        "openworld",
    ]
    .iter()
    .any(|kw| lower == *kw || lower.contains(kw))
    {
        return "utility".to_string();
    }
    "character".to_string()
}

pub fn get_roster_status(
    remote_url: &str,
    games: &[GameDef],
    cache: Option<&RosterCacheFile>,
) -> RosterSyncStatus {
    let mut game_counts = HashMap::new();
    for game in games {
        game_counts.insert(game.id.clone(), get_merged_roster(&game.id, cache).len());
    }
    let has_remote_cache = cache.map(|c| !c.games.is_empty()).unwrap_or(false);
    let updated_at = cache
        .map(|c| c.updated_at.trim().to_string())
        .filter(|s| !s.is_empty());

    RosterSyncStatus {
        remote_url: remote_url.to_string(),
        updated_at,
        game_counts,
        has_remote_cache,
    }
}

fn parse_remote_roster_payload(raw_json: Value) -> Result<RosterCacheFile, String> {
    let obj = raw_json
        .as_object()
        .ok_or_else(|| "Remote roster payload must be a JSON object".to_string())?;

    let games_value = if let Some(games) = obj.get("games") {
        games.clone()
    } else {
        raw_json.clone()
    };

    let games_map = games_value
        .as_object()
        .ok_or_else(|| "Remote roster payload missing valid games map".to_string())?;

    let mut sanitized_games: HashMap<String, Vec<RosterEntry>> = HashMap::new();
    for (game_id, list_val) in games_map {
        let Some(arr) = list_val.as_array() else {
            continue;
        };
        let mut entries = Vec::new();
        for item in arr {
            if let Ok(parsed) = serde_json::from_value::<RosterEntry>(item.clone()) {
                if let Some(clean) = sanitize_roster_entry(&parsed) {
                    entries.push(clean);
                }
            }
        }
        if !entries.is_empty() {
            sanitized_games.insert(game_id.clone(), entries);
        }
    }

    if sanitized_games.is_empty() {
        return Err("Remote roster contained zero valid entries".to_string());
    }

    let updated_at = obj
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(today_iso_date);

    Ok(RosterCacheFile {
        schema_version: 1,
        updated_at,
        games: sanitized_games,
    })
}

fn today_iso_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Howard Hinnant's civil-from-days algorithm in pure std.
    let days = (secs / 86_400) as i64 + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{year:04}-{m:02}-{d:02}")
}

/// Fetches a remote roster JSON document, persists `roster-cache.json`, and returns delta counts.
pub fn sync_remote_roster(
    base_dir: &Path,
    target_url: &str,
    games: &[GameDef],
) -> RosterSyncResult {
    let url = target_url.trim();
    if url.is_empty() || (!url.starts_with("http://") && !url.starts_with("https://")) {
        return RosterSyncResult {
            ok: false,
            updated_at: None,
            added_or_updated: None,
            created_folders_count: None,
            error: Some("Invalid remote roster URL".to_string()),
            status: Some(get_roster_status(
                url,
                games,
                load_roster_cache(base_dir).as_ref(),
            )),
        };
    }

    let response = match ureq::get(url).timeout(Duration::from_secs(15)).call() {
        Ok(resp) => resp,
        Err(err) => {
            return RosterSyncResult {
                ok: false,
                updated_at: None,
                added_or_updated: None,
                created_folders_count: None,
                error: Some(format!("Network request failed: {err}")),
                status: Some(get_roster_status(
                    url,
                    games,
                    load_roster_cache(base_dir).as_ref(),
                )),
            };
        }
    };

    let payload: Value = match response.into_json() {
        Ok(val) => val,
        Err(err) => {
            return RosterSyncResult {
                ok: false,
                updated_at: None,
                added_or_updated: None,
                created_folders_count: None,
                error: Some(format!("Invalid remote roster JSON: {err}")),
                status: Some(get_roster_status(
                    url,
                    games,
                    load_roster_cache(base_dir).as_ref(),
                )),
            };
        }
    };

    let new_cache = match parse_remote_roster_payload(payload) {
        Ok(parsed) => parsed,
        Err(err) => {
            return RosterSyncResult {
                ok: false,
                updated_at: None,
                added_or_updated: None,
                created_folders_count: None,
                error: Some(err),
                status: Some(get_roster_status(
                    url,
                    games,
                    load_roster_cache(base_dir).as_ref(),
                )),
            };
        }
    };

    let prev_cache = load_roster_cache(base_dir);
    let mut added_or_updated = 0usize;
    for (game_id, entries) in &new_cache.games {
        let previous = get_merged_roster(game_id, prev_cache.as_ref());
        let prev_by_key: HashMap<String, &RosterEntry> = previous
            .iter()
            .map(|e| (normalize_match_text(&e.zh), e))
            .collect();
        for entry in entries {
            let key = normalize_match_text(&entry.zh);
            match prev_by_key.get(&key) {
                None => added_or_updated += 1,
                Some(old) => {
                    let changed = (!entry.en.is_empty() && entry.en != old.en)
                        || entry.aliases.iter().any(|a| !old.aliases.contains(a))
                        || (entry.kind.is_some() && entry.kind != old.kind);
                    if changed {
                        added_or_updated += 1;
                    }
                }
            }
        }
    }

    if let Err(err) = save_roster_cache(base_dir, &new_cache) {
        return RosterSyncResult {
            ok: false,
            updated_at: None,
            added_or_updated: None,
            created_folders_count: None,
            error: Some(err),
            status: Some(get_roster_status(url, games, prev_cache.as_ref())),
        };
    }

    let status = get_roster_status(url, games, Some(&new_cache));
    RosterSyncResult {
        ok: true,
        updated_at: Some(new_cache.updated_at.clone()),
        added_or_updated: Some(added_or_updated),
        created_folders_count: None,
        error: None,
        status: Some(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::builtin_games;

    #[test]
    fn embeds_builtin_roster_with_utility_entries() {
        let roster = builtin_roster();
        assert!(!roster.games.is_empty());
        assert_eq!(
            find_canonical_en("wuthering-waves", "Jinxi", None).as_deref(),
            Some("Jinhsi")
        );
        assert_eq!(
            find_canonical_zh("endfield", "Open World", None).as_deref(),
            Some("大世界")
        );
        assert_eq!(
            infer_character_kind("endfield", "OpenWorld", None, None),
            "utility"
        );
        assert_eq!(
            infer_character_kind("endfield", "Perlica", None, None),
            "character"
        );
    }

    #[test]
    fn merges_remote_roster_preserving_builtin_defaults() {
        let mut remote_games = HashMap::new();
        remote_games.insert(
            "endfield".to_string(),
            vec![
                RosterEntry {
                    zh: "佩丽卡".to_string(),
                    en: "".to_string(),
                    pinyin: "".to_string(),
                    aliases: vec!["PerlicaAlias".to_string()],
                    kind: None,
                },
                RosterEntry {
                    zh: "测试新角色".to_string(),
                    en: "TestHero".to_string(),
                    pinyin: "ceshixinjuese".to_string(),
                    aliases: vec![],
                    kind: None,
                },
            ],
        );
        let cache = RosterCacheFile {
            schema_version: 1,
            updated_at: "2026-11-14".to_string(),
            games: remote_games,
        };
        assert_eq!(
            find_canonical_en("endfield", "PerlicaAlias", Some(&cache)).as_deref(),
            Some("Perlica")
        );
        assert_eq!(
            find_canonical_zh("endfield", "TestHero", Some(&cache)).as_deref(),
            Some("测试新角色")
        );
        let map = get_roster_map(&builtin_games(), Some(&cache), false);
        assert!(map["endfield"].iter().any(|n| n == "测试新角色"));
    }
}
