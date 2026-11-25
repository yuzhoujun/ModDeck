use crate::games::get_game;
use crate::library::{
    build_snapshot, copy_dir_recursive, is_inside, move_dir_or_copy, sanitize_segment,
    strip_disabled_prefix, unique_dir_name,
};
use crate::models::{
    ImportCandidate, ImportCommitRequest, ImportParseError, ImportParseRequest,
    ImportParseResult, ImportRequest, ImportResult, ImportResultItem, MetadataStore, Settings,
};
use crate::roster::{load_roster_cache, match_character_for_mod};
use crate::settings::is_non_zh_effective_locale;
use crate::storage::format_timestamp_dir_utc;
use encoding_rs::{Encoding, BIG5, EUC_KR, GB18030, SHIFT_JIS};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::ZipArchive;

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

const LEGACY_ENCODINGS: [&'static Encoding; 4] = [GB18030, BIG5, SHIFT_JIS, EUC_KR];

const CP437_HIGH_CHARS: [char; 128] = [
    '\u{00c7}', '\u{00fc}', '\u{00e9}', '\u{00e2}', '\u{00e4}', '\u{00e0}', '\u{00e5}', '\u{00e7}',
    '\u{00ea}', '\u{00eb}', '\u{00e8}', '\u{00ef}', '\u{00ee}', '\u{00ec}', '\u{00c4}', '\u{00c5}',
    '\u{00c9}', '\u{00e6}', '\u{00c6}', '\u{00f4}', '\u{00f6}', '\u{00f2}', '\u{00fb}', '\u{00f9}',
    '\u{00ff}', '\u{00d6}', '\u{00dc}', '\u{00a2}', '\u{00a3}', '\u{00a5}', '\u{20a7}', '\u{0192}',
    '\u{00e1}', '\u{00ed}', '\u{00f3}', '\u{00fa}', '\u{00f1}', '\u{00d1}', '\u{00aa}', '\u{00ba}',
    '\u{00bf}', '\u{2310}', '\u{00ac}', '\u{00bd}', '\u{00bc}', '\u{00a1}', '\u{00ab}', '\u{00bb}',
    '\u{2591}', '\u{2592}', '\u{2593}', '\u{2502}', '\u{2524}', '\u{2561}', '\u{2562}', '\u{2556}',
    '\u{2555}', '\u{2563}', '\u{2551}', '\u{2557}', '\u{255d}', '\u{255c}', '\u{255b}', '\u{2510}',
    '\u{2514}', '\u{2534}', '\u{252c}', '\u{251c}', '\u{2500}', '\u{253c}', '\u{255e}', '\u{255f}',
    '\u{255a}', '\u{2554}', '\u{2569}', '\u{2566}', '\u{2560}', '\u{2550}', '\u{256c}', '\u{2567}',
    '\u{2568}', '\u{2564}', '\u{2565}', '\u{2559}', '\u{2558}', '\u{2552}', '\u{2553}', '\u{256b}',
    '\u{256a}', '\u{2518}', '\u{250c}', '\u{2588}', '\u{2584}', '\u{258c}', '\u{2590}', '\u{2580}',
    '\u{03b1}', '\u{00df}', '\u{0393}', '\u{03c0}', '\u{03a3}', '\u{03c3}', '\u{00b5}', '\u{03c4}',
    '\u{03a6}', '\u{0398}', '\u{03a9}', '\u{03b4}', '\u{221e}', '\u{03c6}', '\u{03b5}', '\u{2229}',
    '\u{2261}', '\u{00b1}', '\u{2265}', '\u{2264}', '\u{2320}', '\u{2321}', '\u{00f7}', '\u{2248}',
    '\u{00b0}', '\u{2219}', '\u{00b7}', '\u{221a}', '\u{207f}', '\u{00b2}', '\u{25a0}', '\u{00a0}',
];

fn cp437_char_to_byte(ch: char) -> Option<u8> {
    if (ch as u32) < 0x80 {
        return Some(ch as u8);
    }
    CP437_HIGH_CHARS
        .iter()
        .position(|&c| c == ch)
        .map(|idx| (0x80 + idx) as u8)
}

fn contains_cjk_or_kana(s: &str) -> bool {
    s.chars().any(|c| {
        ('\u{3000}'..='\u{303f}').contains(&c)
            || ('\u{3040}'..='\u{30ff}').contains(&c)
            || ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{ac00}'..='\u{d7af}').contains(&c)
            || ('\u{ff00}'..='\u{ffef}').contains(&c)
    })
}

fn score_decoded_text(text: &str, had_errors: bool) -> i64 {
    if had_errors {
        return i64::MIN / 4;
    }
    let mut score: i64 = 0;
    for ch in text.chars() {
        let cp = ch as u32;
        if ch == '\u{fffd}' {
            return i64::MIN / 4;
        } else if (0xE000..=0xF8FF).contains(&cp) || cp >= 0xF0000 {
            // Private Use Area (e.g. Big5 bytes misdecoded into GB18030 UDA zone)
            score -= 2_000;
        } else if cp < 0x20 && ch != '\t' && ch != '\n' && ch != '\r' {
            score -= 5_000;
        } else if (0x3200..=0x33FF).contains(&cp) || (0xFF61..=0xFF9F).contains(&cp) {
            // CJK compatibility symbols / halfwidth katakana are rare in real mod names
            score -= 150;
        } else if (0x2100..=0x27BF).contains(&cp) {
            score -= 40;
        } else if (0x4E00..=0x9FFF).contains(&cp) || (0xAC00..=0xD7AF).contains(&cp) {
            score += 20;
        } else if (0x3040..=0x30FF).contains(&cp) {
            score += 12;
        } else if (0x20..=0x7E).contains(&cp) {
            score += 1;
        } else {
            score += 2;
        }
    }
    score
}

fn detect_legacy_encoding_for_slices<'a>(slices: &[&'a [u8]]) -> &'static Encoding {
    let mut best_encoding = GB18030;
    let mut best_score = i64::MIN;

    for (priority_idx, &enc) in LEGACY_ENCODINGS.iter().enumerate() {
        let mut total_score: i64 = 0;
        let mut invalid = false;
        for bytes in slices {
            if std::str::from_utf8(bytes).is_ok() {
                continue;
            }
            let (decoded, _, had_errors) = enc.decode(bytes);
            let s = score_decoded_text(&decoded, had_errors);
            if s <= i64::MIN / 8 {
                invalid = true;
                break;
            }
            total_score = total_score.saturating_add(s);
        }
        if invalid {
            continue;
        }
        // Slight tie-breaker preferring earlier encodings in LEGACY_ENCODINGS (GB18030 > BIG5 > SHIFT_JIS > EUC_KR)
        let adjusted = total_score.saturating_mul(10) - (priority_idx as i64);
        if adjusted > best_score {
            best_score = adjusted;
            best_encoding = enc;
        }
    }
    best_encoding
}

fn decode_legacy_bytes_best(bytes: &[u8]) -> Option<String> {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Some(s.to_string());
    }
    let mut best: Option<(i64, String)> = None;
    for (priority_idx, &enc) in LEGACY_ENCODINGS.iter().enumerate() {
        let (decoded, _, had_errors) = enc.decode(bytes);
        let base_score = score_decoded_text(&decoded, had_errors);
        if base_score <= i64::MIN / 8 {
            continue;
        }
        let adjusted = base_score.saturating_mul(10) - (priority_idx as i64);
        if best
            .as_ref()
            .map(|(curr, _)| adjusted > *curr)
            .unwrap_or(true)
        {
            best = Some((adjusted, decoded.into_owned()));
        }
    }
    best.map(|(_, s)| s)
}

/// Restores CP437-mojibake filenames back into East Asian text (GB18030/Big5/Shift-JIS/EUC-KR) when applicable.
pub fn decode_cp437_mojibake(name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let mut bytes = Vec::with_capacity(name.len());
    let mut high_count = 0usize;
    for ch in name.chars() {
        let Some(b) = cp437_char_to_byte(ch) else {
            return name.to_string();
        };
        if b >= 0x80 {
            high_count += 1;
        }
        bytes.push(b);
    }
    if high_count < 2 {
        return name.to_string();
    }
    let Some(decoded) = decode_legacy_bytes_best(&bytes) else {
        return name.to_string();
    };
    if decoded.is_empty() || decoded == name || !contains_cjk_or_kana(&decoded) {
        return name.to_string();
    }
    decoded
}

pub fn fix_mojibake_tree(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let items: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    for item in items {
        let mut current = item;
        if current.is_dir() {
            fix_mojibake_tree(&current);
        }
        if let Some(name) = current.file_name().and_then(|n| n.to_str()) {
            let fixed = decode_cp437_mojibake(name);
            if fixed != name {
                if let Some(parent) = current.parent() {
                    let target = parent.join(&fixed);
                    if !target.exists() && fs::rename(&current, &target).is_ok() {
                        current = target;
                    }
                }
            }
        }
        let _ = current;
    }
}

pub fn is_archive_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("zip" | "7z" | "rar")
    )
}

#[derive(Debug, Clone)]
pub enum ExtractError {
    PasswordRequired(String),
    WrongPassword(String),
    Other(String),
}

impl ExtractError {
    pub fn into_message(self) -> String {
        match self {
            Self::PasswordRequired(m) | Self::WrongPassword(m) | Self::Other(m) => m,
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::PasswordRequired(_) => Some("PASSWORD_REQUIRED"),
            Self::WrongPassword(_) => Some("WRONG_PASSWORD"),
            Self::Other(_) => None,
        }
    }
}

fn is_password_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("encrypted")
        || lower.contains("missingpassword")
        || lower.contains("badpassword")
        || lower.contains("maybebadpassword")
}

fn sanitize_archive_rel_path(
    raw_bytes: &[u8],
    legacy_encoding: Option<&'static Encoding>,
) -> Result<Option<PathBuf>, String> {
    let raw_str = match std::str::from_utf8(raw_bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            if let Some(enc) = legacy_encoding {
                let (decoded, _, _) = enc.decode(raw_bytes);
                decoded.into_owned()
            } else if let Some(best) = decode_legacy_bytes_best(raw_bytes) {
                best
            } else {
                let (decoded, _, _) = GB18030.decode(raw_bytes);
                decoded.into_owned()
            }
        }
    };

    let normalized = raw_str.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    if trimmed.is_empty() {
        return Ok(None);
    }
    let rel = Path::new(trimmed);
    let mut out = PathBuf::new();
    for comp in rel.components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.contains(':') || s.contains('\0') {
                    return Err("Archive contains unsafe path characters".to_string());
                }
                out.push(s.as_ref());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Archive contains path-traversal entry".to_string());
            }
        }
    }
    if out.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn assert_tree_inside(root: &Path) -> Result<(), String> {
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| format!("Archive inspection failed: {e}"))?;
        if entry.file_type().is_symlink() {
            return Err("Archive contains symbolic link; extraction aborted".to_string());
        }
        if !is_inside(root, entry.path()) {
            return Err("Archive contains out-of-bounds path; extraction aborted".to_string());
        }
    }
    Ok(())
}

fn extract_zip_archive(
    archive_path: &Path,
    destination: &Path,
    password: Option<&str>,
) -> Result<(), ExtractError> {
    let file = fs::File::open(archive_path)
        .map_err(|e| ExtractError::Other(format!("Failed to open archive: {e}")))?;
    let mut archive = ZipArchive::new(BufReader::with_capacity(262_144, file))
        .map_err(|e| ExtractError::Other(format!("Failed to read zip archive: {e}")))?;

    let mut raw_slices: Vec<Vec<u8>> = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        if let Ok(raw_entry) = archive.by_index_raw(i) {
            raw_slices.push(raw_entry.name_raw().to_vec());
        }
    }
    let refs: Vec<&[u8]> = raw_slices.iter().map(Vec::as_slice).collect();
    let legacy_enc = detect_legacy_encoding_for_slices(&refs);

    let mut copy_buf = vec![0u8; 262_144];
    for i in 0..archive.len() {
        let res = match password {
            Some(pwd) => archive.by_index_decrypt(i, pwd.as_bytes()),
            None => archive.by_index(i),
        };
        let mut entry = match res {
            Ok(e) => e,
            Err(err) => {
                let msg = err.to_string();
                if is_password_error(&msg) {
                    return if password.is_some() {
                        Err(ExtractError::WrongPassword(
                            "Incorrect archive password".to_string(),
                        ))
                    } else {
                        Err(ExtractError::PasswordRequired(
                            "This archive requires a password".to_string(),
                        ))
                    };
                }
                return Err(ExtractError::Other(format!("Failed to read zip entry: {msg}")));
            }
        };
        let was_encrypted = entry.encrypted();
        if entry.is_symlink() {
            return Err(ExtractError::Other(
                "Archive contains symbolic link; extraction aborted".to_string(),
            ));
        }
        let Some(rel_path) =
            sanitize_archive_rel_path(entry.name_raw(), Some(legacy_enc))
                .map_err(ExtractError::Other)?
        else {
            continue;
        };
        let out_path = destination.join(&rel_path);
        if !is_inside(destination, &out_path) {
            return Err(ExtractError::Other(
                "Archive entry escapes destination".to_string(),
            ));
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| {
                ExtractError::Other(format!("Failed to create dir {}: {e}", out_path.display()))
            })?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    ExtractError::Other(format!("Failed to create dir {}: {e}", parent.display()))
                })?;
            }
            let out_file = fs::File::create(&out_path).map_err(|e| {
                ExtractError::Other(format!("Failed to create file {}: {e}", out_path.display()))
            })?;
            let mut writer = BufWriter::with_capacity(262_144, out_file);
            loop {
                let n = match entry.read(&mut copy_buf) {
                    Ok(n) => n,
                    Err(e) => {
                        let msg = e.to_string();
                        if was_encrypted && password.is_some() {
                            return Err(ExtractError::WrongPassword(
                                "Incorrect archive password or corrupted encrypted stream"
                                    .to_string(),
                            ));
                        }
                        if is_password_error(&msg) {
                            return Err(ExtractError::PasswordRequired(
                                "This archive requires a password".to_string(),
                            ));
                        }
                        return Err(ExtractError::Other(format!(
                            "Failed to extract {}: {e}",
                            rel_path.display()
                        )));
                    }
                };
                if n == 0 {
                    break;
                }
                writer.write_all(&copy_buf[..n]).map_err(|e| {
                    ExtractError::Other(format!("Failed to write {}: {e}", out_path.display()))
                })?;
            }
            writer.flush().map_err(|e| {
                ExtractError::Other(format!("Failed to flush {}: {e}", out_path.display()))
            })?;
        }
    }
    Ok(())
}

fn extract_7z_archive(
    archive_path: &Path,
    destination: &Path,
    password: Option<&str>,
) -> Result<(), ExtractError> {
    let res = match password {
        Some(pwd) => sevenz_rust::decompress_file_with_password(
            archive_path,
            destination,
            sevenz_rust::Password::from(pwd),
        ),
        None => sevenz_rust::decompress_file(archive_path, destination),
    };
    res.map_err(|err| {
        let msg = err.to_string();
        if matches!(err, sevenz_rust::Error::PasswordRequired) {
            return ExtractError::PasswordRequired(
                "This 7z archive requires a password".to_string(),
            );
        }
        if matches!(err, sevenz_rust::Error::MaybeBadPassword(_))
            || (password.is_some()
                && (is_password_error(&msg)
                    || matches!(err, sevenz_rust::Error::ChecksumVerificationFailed)))
        {
            return if password.is_some() {
                ExtractError::WrongPassword("Incorrect 7z archive password".to_string())
            } else {
                ExtractError::PasswordRequired("This 7z archive requires a password".to_string())
            };
        }
        if is_password_error(&msg) {
            return if password.is_some() {
                ExtractError::WrongPassword("Incorrect 7z archive password".to_string())
            } else {
                ExtractError::PasswordRequired("This 7z archive requires a password".to_string())
            };
        }
        ExtractError::Other(format!("7z extraction failed: {msg}"))
    })
}

fn extract_rar_archive(
    archive_path: &Path,
    destination: &Path,
    password: Option<&str>,
) -> Result<(), ExtractError> {
    let builder = match password {
        Some(pwd) => unrar::Archive::with_password(archive_path, pwd),
        None => unrar::Archive::new(archive_path),
    };
    let mut open_arc = builder.open_for_processing().map_err(|err| {
        let msg = format!("{err:?}");
        if err.code == unrar::error::Code::MissingPassword {
            return ExtractError::PasswordRequired(
                "This RAR archive requires a password".to_string(),
            );
        }
        if err.code == unrar::error::Code::BadPassword {
            return if password.is_some() {
                ExtractError::WrongPassword("Incorrect RAR archive password".to_string())
            } else {
                ExtractError::PasswordRequired(
                    "This RAR archive requires a password".to_string(),
                )
            };
        }
        if is_password_error(&msg) {
            return if password.is_some() {
                ExtractError::WrongPassword("Incorrect RAR archive password".to_string())
            } else {
                ExtractError::PasswordRequired(
                    "This RAR archive requires a password".to_string(),
                )
            };
        }
        ExtractError::Other(format!("Failed to open RAR archive: {msg}"))
    })?;

    loop {
        let header_opt = open_arc.read_header().map_err(|err| {
            let msg = format!("{err:?}");
            if err.code == unrar::error::Code::MissingPassword {
                return ExtractError::PasswordRequired(
                    "This RAR archive requires a password".to_string(),
                );
            }
            if err.code == unrar::error::Code::BadPassword || is_password_error(&msg) {
                return if password.is_some() {
                    ExtractError::WrongPassword("Incorrect RAR archive password".to_string())
                } else {
                    ExtractError::PasswordRequired(
                        "This RAR archive requires a password".to_string(),
                    )
                };
            }
            ExtractError::Other(format!("Failed to read RAR header: {msg}"))
        })?;
        let Some(before_file) = header_opt else {
            break;
        };
        if before_file.entry().is_encrypted() && password.is_none() {
            return Err(ExtractError::PasswordRequired(
                "This RAR archive requires a password".to_string(),
            ));
        }
        let rel = &before_file.entry().filename;
        for comp in rel.components() {
            if matches!(
                comp,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(ExtractError::Other(
                    "RAR archive contains path-traversal entry".to_string(),
                ));
            }
        }
        let was_encrypted = before_file.entry().is_encrypted();
        open_arc = before_file.extract_with_base(destination).map_err(|err| {
            let msg = format!("{err:?}");
            if err.code == unrar::error::Code::MissingPassword {
                return ExtractError::PasswordRequired(
                    "This RAR archive requires a password".to_string(),
                );
            }
            if err.code == unrar::error::Code::BadPassword
                || is_password_error(&msg)
                || (was_encrypted && password.is_some() && err.code == unrar::error::Code::BadData)
            {
                return if password.is_some() {
                    ExtractError::WrongPassword("Incorrect RAR archive password".to_string())
                } else {
                    ExtractError::PasswordRequired(
                        "This RAR archive requires a password".to_string(),
                    )
                };
            }
            ExtractError::Other(format!("RAR extraction failed: {msg}"))
        })?;
    }
    Ok(())
}

/// Extracts an archive with optional password, returning structured password errors when encrypted.
pub fn extract_archive_with_password(
    archive_path: &Path,
    destination: &Path,
    password: Option<&str>,
) -> Result<(), ExtractError> {
    if !archive_path.is_file() {
        return Err(ExtractError::Other(format!(
            "Not a file: {}",
            archive_path.display()
        )));
    }
    fs::create_dir_all(destination).map_err(|e| {
        ExtractError::Other(format!(
            "Failed to create extract dir {}: {e}",
            destination.display()
        ))
    })?;

    let ext = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    let res = match ext.as_str() {
        "zip" | "moddeck-bundle" => extract_zip_archive(archive_path, destination, password),
        "7z" => extract_7z_archive(archive_path, destination, password),
        "rar" => extract_rar_archive(archive_path, destination, password),
        other => Err(ExtractError::Other(format!(
            "Unsupported archive format: {}",
            if other.is_empty() { "(none)" } else { other }
        ))),
    };

    if let Err(err) = res {
        let _ = fs::remove_dir_all(destination);
        return Err(err);
    }

    if let Err(err) = assert_tree_inside(destination) {
        let _ = fs::remove_dir_all(destination);
        return Err(ExtractError::Other(err));
    }
    fix_mojibake_tree(destination);
    Ok(())
}

/// Safely extracts a `.zip`, `.7z`, `.rar`, or `.moddeck-bundle` archive into `destination`.
#[allow(dead_code)]
pub fn extract_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    extract_archive_with_password(archive_path, destination, None).map_err(ExtractError::into_message)
}

fn non_hidden_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !n.starts_with('.'))
                    .unwrap_or(false)
        })
        .collect();
    dirs.sort();
    dirs
}

fn has_ini(dir: &Path, depth: usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if p.is_file() && name.to_ascii_lowercase().ends_with(".ini") {
            return true;
        }
        if depth > 0 && p.is_dir() && !name.starts_with('.') && has_ini(&p, depth - 1) {
            return true;
        }
    }
    false
}

fn has_any_file(dir: &Path, depth: usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            return true;
        }
        let is_dot = entry
            .file_name()
            .to_str()
            .map(|n| n.starts_with('.'))
            .unwrap_or(true);
        if depth > 0 && p.is_dir() && !is_dot && has_any_file(&p, depth - 1) {
            return true;
        }
    }
    false
}

fn is_preview_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn unwrap_base(root: &Path) -> PathBuf {
    let mut current = root.to_path_buf();
    for _ in 0..4 {
        let Ok(entries) = fs::read_dir(&current) else {
            break;
        };
        let mut files_count = 0usize;
        let mut dirs = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if p.is_file() {
                let keep_file = !name.starts_with('.')
                    || (!name.starts_with("._") && is_preview_image_name(&name));
                if keep_file {
                    files_count += 1;
                }
            } else if p.is_dir() && !name.starts_with('.') {
                dirs.push((name, p));
            }
        }
        if dirs.is_empty() {
            break;
        }
        if let Some((_, mods_dir)) = dirs.iter().find(|(n, _)| n.eq_ignore_ascii_case("mods")) {
            current = mods_dir.clone();
            continue;
        }
        if dirs.len() == 1 && files_count == 0 {
            let only = &dirs[0].1;
            if has_ini(only, 0) {
                break;
            }
            current = only.clone();
            continue;
        }
        break;
    }
    current
}

#[derive(Debug, Clone)]
pub struct FoundMod {
    pub character: Option<String>,
    pub dir: PathBuf,
    pub name: String,
    pub has_ini: bool,
}

/// Inspects an extracted archive or directory to locate candidate mod folders.
pub fn analyze_extracted(root: &Path) -> Vec<FoundMod> {
    let base = unwrap_base(root);
    if has_ini(&base, 0) {
        let name = base
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mod")
            .to_string();
        return vec![FoundMod {
            character: None,
            dir: base,
            name,
            has_ini: true,
        }];
    }

    let entries = non_hidden_dirs(&base);
    let mut results = Vec::new();

    for full in entries {
        let entry_name = full
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mod")
            .to_string();
        if has_ini(&full, 0) {
            results.push(FoundMod {
                character: None,
                dir: full,
                name: entry_name,
                has_ini: true,
            });
            continue;
        }
        let children = non_hidden_dirs(&full);
        let mod_children: Vec<PathBuf> = children
            .into_iter()
            .filter(|child| has_ini(child, 1))
            .collect();
        if !mod_children.is_empty() {
            for child in mod_children {
                let child_name = child
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("mod")
                    .to_string();
                results.push(FoundMod {
                    character: Some(entry_name.clone()),
                    dir: child,
                    name: child_name,
                    has_ini: true,
                });
            }
            continue;
        }
        if has_any_file(&full, 1) {
            let ini_flag = has_ini(&full, 2);
            results.push(FoundMod {
                character: None,
                dir: full,
                name: entry_name,
                has_ini: ini_flag,
            });
        }
    }

    if results.is_empty() && has_any_file(&base, 2) {
        let name = base
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("mod")
            .to_string();
        let ini_flag = has_ini(&base, 2);
        results.push(FoundMod {
            character: None,
            dir: base,
            name,
            has_ini: ini_flag,
        });
    }

    results
}

#[derive(Debug, Clone)]
struct ActiveCandidate {
    candidate: ImportCandidate,
    is_archive_source: bool,
    extracted_dir: PathBuf,
    source_path: PathBuf,
}

#[derive(Debug)]
pub struct ActiveImportSession {
    temp_root: PathBuf,
    candidates: Vec<ActiveCandidate>,
    drop_dirs: Vec<PathBuf>,
}

fn staged_drop_dir_for_source(base_dir: &Path, source_path: &Path) -> Option<PathBuf> {
    let tmp_root = base_dir.join("tmp");
    let parent = source_path.parent()?;
    let name = parent.file_name().and_then(|n| n.to_str())?;
    if !name.starts_with("drop-") {
        return None;
    }
    if parent.parent() == Some(tmp_root.as_path()) && is_inside(&tmp_root, parent) {
        Some(parent.to_path_buf())
    } else {
        None
    }
}

pub fn cleanup_staged_drops(base_dir: &Path, paths: &[String]) {
    let mut dirs = HashSet::new();
    for raw in paths {
        if let Some(dir) = staged_drop_dir_for_source(base_dir, Path::new(raw)) {
            dirs.insert(dir);
        }
    }
    for dir in dirs {
        let _ = fs::remove_dir_all(dir);
    }
}

pub fn cleanup_stale_tmp_dirs(base_dir: &Path) {
    let tmp_root = base_dir.join("tmp");
    let Ok(entries) = fs::read_dir(&tmp_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with("drop-") || name.starts_with("parse-") {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[derive(Debug, Default)]
pub struct ImportSessionManager {
    sessions: HashMap<String, ActiveImportSession>,
}

impl ImportSessionManager {
    pub fn insert(&mut self, id: String, session: ActiveImportSession) {
        self.sessions.insert(id, session);
    }

    pub fn take(&mut self, id: &str) -> Option<ActiveImportSession> {
        self.sessions.remove(id)
    }

    pub fn discard(&mut self, session_id: &str) {
        if let Some(session) = self.sessions.remove(session_id) {
            let _ = fs::remove_dir_all(&session.temp_root);
            for dir in session.drop_dirs {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }
}

fn next_session_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{ts}-{seq}")
}

pub fn stage_dropped_file(base_dir: &Path, file_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let clean_name = sanitize_segment(file_name, "dropped.zip");
    let dir = base_dir.join("tmp").join(format!("drop-{}", next_session_id()));
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create drop temp dir: {e}"))?;
    let dest = dir.join(clean_name);
    fs::write(&dest, bytes).map_err(|e| format!("Failed to stage dropped file: {e}"))?;
    Ok(dest)
}

/// Stages one file belonging to a dragged folder into `tmp/drop-<session>/<rel_path>`,
/// returning the staged root folder path so `importParse` / `cleanup_staged_drops` can manage it.
pub fn stage_dropped_folder_file(
    base_dir: &Path,
    session_id: &str,
    rel_path: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let clean_session: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if clean_session.is_empty() {
        return Err("Invalid drop session".to_string());
    }
    let session_dir = base_dir.join("tmp").join(format!("drop-{clean_session}"));
    let clean_rel = sanitize_archive_rel_path(rel_path.as_bytes(), None)?
        .ok_or_else(|| "Empty relative path".to_string())?;
    let mut comps = clean_rel.components();
    let Some(Component::Normal(root_seg)) = comps.next() else {
        return Err("Dropped folder path missing root folder".to_string());
    };
    if comps.next().is_none() {
        return Err("Dropped folder file path must include a nested file".to_string());
    }
    let root_folder_dir = session_dir.join(root_seg);
    let dest = session_dir.join(&clean_rel);
    if !is_inside(&session_dir, &dest) {
        return Err("Dropped path escapes drop session directory".to_string());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create drop folder dir: {e}"))?;
    }
    fs::write(&dest, bytes).map_err(|e| format!("Failed to stage dropped folder file: {e}"))?;
    Ok(root_folder_dir)
}

fn lookup_archive_password<'a>(
    passwords: &'a HashMap<String, String>,
    source_str: &str,
) -> Option<&'a str> {
    if let Some(p) = passwords.get(source_str).filter(|s| !s.is_empty()) {
        return Some(p.as_str());
    }
    let norm = source_str.replace('\\', "/");
    for (k, v) in passwords {
        if !v.is_empty() && k.replace('\\', "/").eq_ignore_ascii_case(&norm) {
            return Some(v.as_str());
        }
    }
    None
}

pub fn parse_import_sources_detached(
    base_dir: &Path,
    settings: &Settings,
    metadata: &MetadataStore,
    request: &ImportParseRequest,
) -> Result<(ImportParseResult, Option<(String, ActiveImportSession)>), String> {
    let game = get_game(settings, &request.game_id)
        .ok_or_else(|| format!("Unknown game: {}", request.game_id))?;
    let mods_path = settings
        .games
        .get(&game.id)
        .map(|g| g.mods_path.trim())
        .unwrap_or("");
    if mods_path.is_empty() {
        return Err("Please configure the Mods directory for this game first".to_string());
    }
    let mods_root = Path::new(mods_path);
    if !mods_root.is_dir() {
        return Err(format!("Mods directory does not exist: {mods_path}"));
    }

    let mut raw_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    for raw in &request.paths {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && seen_paths.insert(trimmed.to_string()) {
            raw_paths.push(trimmed.to_string());
        }
    }
    if raw_paths.is_empty() {
        return Err("No files or folders selected for import".to_string());
    }

    let session_id = next_session_id();
    let temp_root = base_dir.join("tmp").join(format!("parse-{session_id}"));
    fs::create_dir_all(&temp_root)
        .map_err(|e| format!("Failed to create temp directory: {e}"))?;

    let gs = settings.games.get(&game.id).cloned().unwrap_or_default();
    let snapshot = build_snapshot(base_dir, &game, &gs, metadata, settings);
    let existing_chars = snapshot.characters;
    let roster_cache = load_roster_cache(base_dir);
    let prefer_en = is_non_zh_effective_locale(&settings.ui.language);

    let mut candidates = Vec::new();
    let mut errors = Vec::new();
    let mut active_candidates = Vec::new();
    let mut cleanup_drop_dirs: Vec<PathBuf> = Vec::new();
    let mut has_password_retry = false;

    for (idx, source_str) in raw_paths.iter().enumerate() {
        let source_path = Path::new(source_str);
        let staged_drop = staged_drop_dir_for_source(base_dir, source_path);
        let source_name = source_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(source_str)
            .to_string();

        if !source_path.exists() {
            errors.push(ImportParseError {
                source: source_name,
                source_path: Some(source_str.clone()),
                code: None,
                message: "Path does not exist".to_string(),
            });
            continue;
        }

        let is_archive = is_archive_file(source_path);
        let source_root = if is_archive {
            let dest = temp_root.join(format!("src-{idx}"));
            let password = lookup_archive_password(&request.passwords, source_str);
            if let Err(err) = extract_archive_with_password(source_path, &dest, password) {
                let code = err.code().map(str::to_string);
                if code.is_some() {
                    has_password_retry = true;
                } else if let Some(d) = staged_drop {
                    cleanup_drop_dirs.push(d);
                }
                errors.push(ImportParseError {
                    source: source_name,
                    source_path: Some(source_str.clone()),
                    code,
                    message: err.into_message(),
                });
                continue;
            }
            if let Some(d) = staged_drop {
                cleanup_drop_dirs.push(d);
            }
            dest
        } else if source_path.is_dir() {
            if let Some(d) = staged_drop.clone() {
                cleanup_drop_dirs.push(d);
            }
            source_path.to_path_buf()
        } else {
            if let Some(d) = staged_drop {
                cleanup_drop_dirs.push(d);
            }
            errors.push(ImportParseError {
                source: source_name,
                source_path: Some(source_str.clone()),
                code: None,
                message: "Unsupported file format; only .zip / .7z / .rar archives or folders are supported".to_string(),
            });
            continue;
        };

        let found = analyze_extracted(&source_root);
        if found.is_empty() {
            errors.push(ImportParseError {
                source: source_name,
                source_path: Some(source_str.clone()),
                code: None,
                message: "No importable mod files found".to_string(),
            });
            continue;
        }

        let raw_base = if is_archive {
            source_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&source_name)
        } else {
            &source_name
        };
        let archive_base = decode_cp437_mojibake(raw_base);

        for (sub_idx, entry) in found.iter().enumerate() {
            let raw_mod_name = if found.len() == 1 && entry.dir == source_root {
                archive_base.as_str()
            } else {
                entry.name.as_str()
            };
            let mod_name = decode_cp437_mojibake(raw_mod_name);
            let entry_char = entry
                .character
                .as_deref()
                .map(decode_cp437_mojibake)
                .unwrap_or_default();

            let (suggested_character, match_reason) =
                if let Some(target) = request.target_character.as_deref().filter(|s| !s.trim().is_empty()) {
                    (
                        target.to_string(),
                        if prefer_en {
                            "Current character view"
                        } else {
                            "当前角色页"
                        }
                        .to_string(),
                    )
                } else {
                    let texts = [entry_char.as_str(), mod_name.as_str(), archive_base.as_str()];
                    match_character_for_mod(
                        &game.id,
                        roster_cache.as_ref(),
                        &existing_chars,
                        &texts,
                        prefer_en,
                    )
                };

            let id = format!("{idx}-{sub_idx}");
            let cand = ImportCandidate {
                id: id.clone(),
                source_path: source_str.clone(),
                source_name: source_name.clone(),
                mod_name,
                extracted_dir: entry.dir.to_string_lossy().to_string(),
                suggested_character,
                match_reason: Some(match_reason),
                has_ini: entry.has_ini,
            };
            candidates.push(cand.clone());
            active_candidates.push(ActiveCandidate {
                candidate: cand,
                is_archive_source: is_archive,
                extracted_dir: entry.dir.clone(),
                source_path: source_path.to_path_buf(),
            });
        }
    }

    let session_pair = if active_candidates.is_empty() {
        let _ = fs::remove_dir_all(&temp_root);
        if !has_password_retry {
            for d in cleanup_drop_dirs {
                let _ = fs::remove_dir_all(d);
            }
        }
        None
    } else if has_password_retry {
        // Password modal will discard this session and re-parse once unlocked; keep non-encrypted staging or clean on next parse
        Some((
            session_id.clone(),
            ActiveImportSession {
                temp_root,
                candidates: active_candidates,
                drop_dirs: Vec::new(),
            },
        ))
    } else {
        Some((
            session_id.clone(),
            ActiveImportSession {
                temp_root,
                candidates: active_candidates,
                drop_dirs: cleanup_drop_dirs,
            },
        ))
    };

    Ok((
        ImportParseResult {
            session_id,
            candidates,
            errors,
        },
        session_pair,
    ))
}

pub fn parse_import_sources(
    base_dir: &Path,
    settings: &Settings,
    metadata: &MetadataStore,
    sessions: &mut ImportSessionManager,
    request: &ImportParseRequest,
) -> Result<ImportParseResult, String> {
    let (result, session_opt) =
        parse_import_sources_detached(base_dir, settings, metadata, request)?;
    if let Some((id, session)) = session_opt {
        sessions.insert(id, session);
    }
    Ok(result)
}

fn has_disabled_prefix(name: &str) -> bool {
    name.len() != strip_disabled_prefix(name).len()
}

fn find_matching_mod_dir(char_dir: &Path, bare_name: &str) -> Option<PathBuf> {
    let exact = char_dir.join(bare_name);
    if exact.exists() {
        return Some(exact);
    }
    let disabled_exact = char_dir.join(format!("DISABLED_{bare_name}"));
    if disabled_exact.exists() {
        return Some(disabled_exact);
    }
    let entries = fs::read_dir(char_dir).ok()?;
    let mut fallback: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let Ok(fname) = entry.file_name().into_string() else {
            continue;
        };
        if strip_disabled_prefix(&fname).eq_ignore_ascii_case(bare_name) {
            let p = entry.path();
            if !has_disabled_prefix(&fname) {
                return Some(p);
            }
            if fallback.is_none() {
                fallback = Some(p);
            }
        }
    }
    fallback
}

fn backup_existing_mod(base_dir: &Path, game_id: &str, destination: &Path) -> Result<(), String> {
    let parts: Vec<String> = destination
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(str::to_string))
        .collect();
    let tail = if parts.len() > 3 {
        &parts[parts.len() - 3..]
    } else {
        &parts[..]
    };
    let mut ts_dir = format_timestamp_dir_utc();
    let backups_dir = base_dir.join("backups");
    for suffix in 0usize..1000 {
        let candidate_ts = if suffix == 0 {
            ts_dir.clone()
        } else {
            format!("{ts_dir}-{suffix}")
        };
        let mut target = backups_dir.join(&candidate_ts).join(game_id);
        for seg in tail {
            target.push(seg);
        }
        if !target.exists() {
            return move_dir_or_copy(destination, &target);
        }
        ts_dir = format_timestamp_dir_utc();
    }
    Err("Failed to allocate unique backup folder".to_string())
}

fn place_mod(
    base_dir: &Path,
    settings: &Settings,
    game_id: &str,
    mods_root: &Path,
    character_folder: &str,
    mod_name: &str,
    overwrite_target: Option<&str>,
    source_dir: &Path,
    can_move_direct: bool,
) -> Result<String, String> {
    let char_dir = mods_root.join(character_folder);
    if !is_inside(mods_root, &char_dir) {
        return Err("Target character directory escapes mods root".to_string());
    }
    fs::create_dir_all(&char_dir)
        .map_err(|e| format!("Failed to create character folder: {e}"))?;

    let mut replaced_disabled = false;
    let explicit_trimmed = overwrite_target.map(str::trim).filter(|s| !s.is_empty());
    if let Some(explicit_raw) = explicit_trimmed {
        if explicit_raw == "." || explicit_raw == ".." || explicit_raw.contains(['/', '\\']) {
            return Err("Invalid overwrite target folder name".to_string());
        }
        if has_disabled_prefix(explicit_raw) {
            replaced_disabled = true;
        }
        let old_path = char_dir.join(explicit_raw);
        if !is_inside(mods_root, &old_path) {
            return Err("Overwrite target escapes mods root".to_string());
        }
        if old_path.exists() {
            backup_existing_mod(base_dir, game_id, &old_path)?;
        }
    }

    let mut name = sanitize_segment(mod_name, "mod");
    if explicit_trimmed.is_none() {
        let bare = strip_disabled_prefix(&name);
        if settings.import.overwrite_existing {
            if let Some(existing_match) = find_matching_mod_dir(&char_dir, bare) {
                if existing_match
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(has_disabled_prefix)
                {
                    replaced_disabled = true;
                }
                backup_existing_mod(base_dir, game_id, &existing_match)?;
            }
        } else if find_matching_mod_dir(&char_dir, bare).is_some() {
            name = unique_dir_name(&char_dir, &name);
        }
    }

    if replaced_disabled && !has_disabled_prefix(&name) {
        name = format!("DISABLED_{}", strip_disabled_prefix(&name));
    }

    let mut destination = char_dir.join(&name);
    if destination.exists() {
        if settings.import.overwrite_existing || explicit_trimmed.is_some() {
            backup_existing_mod(base_dir, game_id, &destination)?;
        } else {
            name = unique_dir_name(&char_dir, &name);
            destination = char_dir.join(&name);
        }
    }

    if can_move_direct {
        move_dir_or_copy(source_dir, &destination)?;
    } else {
        copy_dir_recursive(source_dir, &destination)?;
    }
    fix_mojibake_tree(&destination);
    Ok(name)
}

pub fn commit_import_session_detached(
    base_dir: &Path,
    settings: &Settings,
    session: ActiveImportSession,
    request: &ImportCommitRequest,
) -> Result<ImportResult, String> {

    let res = (|| {
        let game = get_game(settings, &request.game_id)
            .ok_or_else(|| format!("Unknown game: {}", request.game_id))?;
        let mods_path = settings
            .games
            .get(&game.id)
            .map(|g| g.mods_path.trim())
            .unwrap_or("");
        if mods_path.is_empty() {
            return Err("Please configure the Mods directory for this game first".to_string());
        }
        let mods_root = Path::new(mods_path);
        if !mods_root.is_dir() {
            return Err(format!("Mods directory does not exist: {mods_path}"));
        }

        let is_move_mode = settings
            .import
            .mode
            .as_deref()
            .map(|m| m.eq_ignore_ascii_case("move"))
            .unwrap_or(false)
            || settings.import.delete_archive_after;

        let mut items = Vec::new();
        let mut created_characters = HashSet::new();
        let mut imported_mods = 0usize;
        let mut succeeded_by_source: HashMap<String, usize> = HashMap::new();

        for commit_item in &request.items {
            let Some(active) = session
                .candidates
                .iter()
                .find(|c| c.candidate.id == commit_item.id)
            else {
                continue;
            };

            let mut item_result = ImportResultItem {
                source: active.candidate.source_path.clone(),
                ok: false,
                message: None,
                characters: None,
                mods: None,
            };

            let raw_char = if commit_item.character_folder.trim().is_empty() {
                active.candidate.suggested_character.as_str()
            } else {
                commit_item.character_folder.as_str()
            };
            let char_folder = sanitize_segment(raw_char, "其他");
            let char_dir = mods_root.join(&char_folder);
            if !char_dir.exists() {
                created_characters.insert(char_folder.clone());
            }

            let final_mod_name = commit_item
                .mod_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(active.candidate.mod_name.as_str());

            let is_staged_drop_dir = !active.is_archive_source
                && staged_drop_dir_for_source(base_dir, &active.source_path).is_some();
            let can_move_direct = ((active.is_archive_source || is_staged_drop_dir)
                && active.extracted_dir != session.temp_root
                && session
                    .candidates
                    .iter()
                    .filter(|c| c.extracted_dir == active.extracted_dir)
                    .count()
                    == 1)
                || (is_move_mode
                    && !active.is_archive_source
                    && active.extracted_dir == active.source_path);

            match place_mod(
                base_dir,
                settings,
                &game.id,
                mods_root,
                &char_folder,
                final_mod_name,
                commit_item.overwrite_target.as_deref(),
                &active.extracted_dir,
                can_move_direct,
            ) {
                Ok(placed_name) => {
                    imported_mods += 1;
                    item_result.ok = true;
                    item_result.characters = Some(vec![char_folder]);
                    item_result.mods = Some(vec![placed_name]);
                    *succeeded_by_source
                        .entry(active.candidate.source_path.clone())
                        .or_insert(0) += 1;
                }
                Err(err) => {
                    item_result.ok = false;
                    item_result.message = Some(err);
                }
            }
            items.push(item_result);
        }

        if is_move_mode {
            for (src_str, ok_count) in succeeded_by_source {
                let total_for_source = session
                    .candidates
                    .iter()
                    .filter(|c| c.candidate.source_path == src_str)
                    .count();
                if ok_count > 0 && ok_count == total_for_source {
                    let src_path = Path::new(&src_str);
                    if src_path.is_file() {
                        let _ = fs::remove_file(src_path);
                    } else if src_path.is_dir() {
                        let _ = fs::remove_dir_all(src_path);
                    }
                }
            }
        }

        let mut created_vec: Vec<String> = created_characters.into_iter().collect();
        created_vec.sort();

        Ok(ImportResult {
            items,
            imported_mods,
            created_characters: created_vec,
        })
    })();

    let _ = fs::remove_dir_all(&session.temp_root);
    for dir in session.drop_dirs {
        let _ = fs::remove_dir_all(dir);
    }
    res
}

pub fn commit_import_session(
    base_dir: &Path,
    settings: &Settings,
    sessions: &mut ImportSessionManager,
    request: &ImportCommitRequest,
) -> Result<ImportResult, String> {
    let session = sessions
        .take(&request.session_id)
        .ok_or_else(|| "Import session expired; please select files again".to_string())?;
    commit_import_session_detached(base_dir, settings, session, request)
}

pub fn run_import(
    base_dir: &Path,
    settings: &Settings,
    metadata: &MetadataStore,
    sessions: &mut ImportSessionManager,
    request: &ImportRequest,
) -> Result<ImportResult, String> {
    let mut paths = Vec::new();
    if let Some(archives) = &request.archive_paths {
        paths.extend(archives.iter().cloned());
    }
    if let Some(folders) = &request.folder_paths {
        paths.extend(folders.iter().cloned());
    }
    let parsed = parse_import_sources(
        base_dir,
        settings,
        metadata,
        sessions,
        &ImportParseRequest {
            game_id: request.game_id.clone(),
            paths,
            target_character: request.target_character.clone(),
            passwords: request.passwords.clone(),
        },
    )?;

    if parsed.candidates.is_empty() {
        sessions.discard(&parsed.session_id);
        return Ok(ImportResult {
            items: parsed
                .errors
                .into_iter()
                .map(|e| ImportResultItem {
                    source: e.source,
                    ok: false,
                    message: Some(e.message),
                    characters: None,
                    mods: None,
                })
                .collect(),
            imported_mods: 0,
            created_characters: Vec::new(),
        });
    }

    let items = parsed
        .candidates
        .iter()
        .map(|c| crate::models::ImportCommitItem {
            id: c.id.clone(),
            character_folder: request
                .target_character
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| c.suggested_character.clone()),
            mod_name: Some(c.mod_name.clone()),
            overwrite_target: None,
        })
        .collect();

    commit_import_session(
        base_dir,
        settings,
        sessions,
        &ImportCommitRequest {
            session_id: parsed.session_id,
            game_id: request.game_id.clone(),
            items,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_settings;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    #[test]
    fn decodes_cp437_mojibake_to_chinese() {
        // Encode "长离" in GB18030, then map bytes >= 0x80 via CP437 table.
        let (gbk_bytes, _, _) = GB18030.encode("长离");
        let mojibake: String = gbk_bytes
            .iter()
            .map(|&b| {
                if b < 0x80 {
                    b as char
                } else {
                    CP437_HIGH_CHARS[(b - 0x80) as usize]
                }
            })
            .collect();
        assert_eq!(decode_cp437_mojibake(&mojibake), "长离");
        assert_eq!(decode_cp437_mojibake("ChangliSkin"), "ChangliSkin");
    }

    #[test]
    fn parses_and_commits_zip_archive_with_character_matching() {
        let root = std::env::temp_dir().join(format!("moddeck-import-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&mods_dir).unwrap();

        let archive_path = root.join("Changli_Summer.zip");
        {
            let f = fs::File::create(&archive_path).unwrap();
            let mut zw = ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("Changli_Summer/mod.ini", opts).unwrap();
            zw.write_all(b"[TextureOverrideBody]\nhash = deadbeef\n")
                .unwrap();
            zw.finish().unwrap();
        }

        let mut settings = default_settings();
        settings.games.get_mut("wuthering-waves").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        let metadata = MetadataStore::default();
        let mut sessions = ImportSessionManager::default();

        let parsed = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "wuthering-waves".to_string(),
                paths: vec![archive_path.to_string_lossy().to_string()],
                target_character: None,
                passwords: HashMap::new(),
            },
        )
        .unwrap();

        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].suggested_character, "长离");
        assert!(parsed.candidates[0].has_ini);

        let committed = commit_import_session(
            &base_dir,
            &settings,
            &mut sessions,
            &ImportCommitRequest {
                session_id: parsed.session_id,
                game_id: "wuthering-waves".to_string(),
                items: vec![crate::models::ImportCommitItem {
                    id: parsed.candidates[0].id.clone(),
                    character_folder: parsed.candidates[0].suggested_character.clone(),
                    mod_name: Some(parsed.candidates[0].mod_name.clone()),
                    overwrite_target: None,
                }],
            },
        )
        .unwrap();

        assert_eq!(committed.imported_mods, 1);
        assert!(mods_dir.join("长离").join("Changli_Summer").join("mod.ini").is_file());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_big5_bytes_without_pua_corruption() {
        let big5_bytes: &[u8] = b"\xa4k\xa5D-\xaf\xc1\xa9R\xb3z\xaf\xbd";
        let decoded = decode_legacy_bytes_best(big5_bytes).unwrap();
        assert_eq!(decoded, "女主-索命透紗");

        // Simplified GBK stays GB18030
        let (gbk_bytes, _, _) = GB18030.encode("陈千语-JK");
        let decoded_gbk = decode_legacy_bytes_best(&gbk_bytes).unwrap();
        assert_eq!(decoded_gbk, "陈千语-JK");
    }

    #[test]
    fn prompts_and_decrypts_password_protected_zip() {
        use zip::unstable::write::FileOptionsExt;

        let root =
            std::env::temp_dir().join(format!("moddeck-pwd-zip-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&mods_dir).unwrap();

        let archive_path = root.join("Changli_Secret.zip");
        {
            let f = fs::File::create(&archive_path).unwrap();
            let mut zw = ZipWriter::new(f);
            let opts = SimpleFileOptions::default().with_deprecated_encryption(b"mod123");
            zw.start_file("Changli_Secret/mod.ini", opts).unwrap();
            zw.write_all(b"[TextureOverrideBody]\nhash = deadbeef\n")
                .unwrap();
            zw.finish().unwrap();
        }

        let mut settings = default_settings();
        settings.games.get_mut("wuthering-waves").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        let metadata = MetadataStore::default();
        let mut sessions = ImportSessionManager::default();
        let src = archive_path.to_string_lossy().to_string();

        // Missing password -> PASSWORD_REQUIRED
        let missing = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "wuthering-waves".to_string(),
                paths: vec![src.clone()],
                target_character: None,
                passwords: HashMap::new(),
            },
        )
        .unwrap();
        assert!(missing.candidates.is_empty());
        assert_eq!(missing.errors[0].code.as_deref(), Some("PASSWORD_REQUIRED"));

        // Correct password -> succeeds
        let mut passwords = HashMap::new();
        passwords.insert(src.clone(), "mod123".to_string());
        let ok = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "wuthering-waves".to_string(),
                paths: vec![src],
                target_character: None,
                passwords,
            },
        )
        .unwrap();
        assert_eq!(ok.candidates.len(), 1);
        assert_eq!(ok.candidates[0].suggested_character, "长离");
        sessions.discard(&ok.session_id);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cleans_up_staged_drop_and_stale_tmp_dirs() {
        let root = std::env::temp_dir().join(format!("moddeck-drop-clean-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(&mods_dir).unwrap();

        let mut zip_bytes = Vec::new();
        {
            let cur = std::io::Cursor::new(&mut zip_bytes);
            let mut zw = ZipWriter::new(cur);
            let opts = SimpleFileOptions::default();
            zw.start_file("Changli_Drop/mod.ini", opts).unwrap();
            zw.write_all(b"[Constants]\nx = 1\n").unwrap();
            zw.finish().unwrap();
        }
        let staged_file = stage_dropped_file(&base_dir, "Changli_Drop.zip", &zip_bytes).unwrap();
        let drop_parent = staged_file.parent().unwrap().to_path_buf();
        assert!(staged_file.is_file());

        let mut settings = default_settings();
        settings.games.get_mut("wuthering-waves").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        let metadata = MetadataStore::default();
        let mut sessions = ImportSessionManager::default();

        let parsed = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "wuthering-waves".to_string(),
                paths: vec![staged_file.to_string_lossy().to_string()],
                target_character: None,
                passwords: HashMap::new(),
            },
        )
        .unwrap();
        assert!(drop_parent.exists());
        sessions.discard(&parsed.session_id);
        assert!(!drop_parent.exists());

        // Also test stale tmp cleanup
        let _ = stage_dropped_file(&base_dir, "leftover.zip", b"abc").unwrap();
        let parse_stale = base_dir.join("tmp").join("parse-stale-1");
        fs::create_dir_all(&parse_stale).unwrap();
        cleanup_stale_tmp_dirs(&base_dir);
        assert!(!parse_stale.exists());
        let remaining_entries: Vec<_> = fs::read_dir(base_dir.join("tmp"))
            .unwrap()
            .flatten()
            .collect();
        assert!(remaining_entries.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn explicit_overwrite_target_and_disabled_sibling_backup_work() {
        let root = std::env::temp_dir().join(format!("moddeck-overwrite-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        let char_dir = mods_dir.join("伊冯");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(char_dir.join("DISABLED_Skin-Same")).unwrap();
        fs::write(char_dir.join("DISABLED_Skin-Same").join("mod.ini"), "old-same").unwrap();
        fs::create_dir_all(char_dir.join("DISABLED_Skin-v1.0")).unwrap();
        fs::write(char_dir.join("DISABLED_Skin-v1.0").join("mod.ini"), "old-v1").unwrap();

        let archive_path = root.join("Skin-v1.2-efmittl.zip");
        {
            let f = fs::File::create(&archive_path).unwrap();
            let mut zw = ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            zw.start_file("Skin-Same/mod.ini", opts).unwrap();
            zw.write_all(b"[Constants]\nx = 2\n").unwrap();
            zw.start_file("Skin-v1.2-efmittl/mod.ini", opts).unwrap();
            zw.write_all(b"[Constants]\ny = 3\n").unwrap();
            zw.finish().unwrap();
        }

        let mut settings = default_settings();
        settings.games.get_mut("endfield").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        settings.import.overwrite_existing = true;
        let metadata = MetadataStore::default();
        let mut sessions = ImportSessionManager::default();
        let parsed = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "endfield".to_string(),
                paths: vec![archive_path.to_string_lossy().to_string()],
                target_character: Some("伊冯".to_string()),
                passwords: HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(parsed.candidates.len(), 2);

        let same_item = parsed
            .candidates
            .iter()
            .find(|c| c.mod_name == "Skin-Same")
            .unwrap();
        let v12_item = parsed
            .candidates
            .iter()
            .find(|c| c.mod_name == "Skin-v1.2-efmittl")
            .unwrap();

        let res = commit_import_session(
            &base_dir,
            &settings,
            &mut sessions,
            &ImportCommitRequest {
                session_id: parsed.session_id.clone(),
                game_id: "endfield".to_string(),
                items: vec![
                    crate::models::ImportCommitItem {
                        id: same_item.id.clone(),
                        character_folder: "伊冯".to_string(),
                        mod_name: Some("Skin-Same".to_string()),
                        overwrite_target: None,
                    },
                    crate::models::ImportCommitItem {
                        id: v12_item.id.clone(),
                        character_folder: "伊冯".to_string(),
                        mod_name: Some("Skin-v1.2-Custom".to_string()),
                        overwrite_target: Some("DISABLED_Skin-v1.0".to_string()),
                    },
                ],
            },
        )
        .unwrap();
        assert_eq!(res.imported_mods, 2);
        // Old DISABLED_* dirs were replaced and backed up while preserving disabled state
        assert!(!char_dir.join("Skin-Same").exists());
        assert!(!char_dir.join("DISABLED_Skin-v1.0").exists());
        assert!(char_dir.join("DISABLED_Skin-Same").join("mod.ini").is_file());
        assert!(char_dir.join("DISABLED_Skin-v1.2-Custom").join("mod.ini").is_file());

        let backups: Vec<_> = WalkDir::new(base_dir.join("backups"))
            .into_iter()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("DISABLED_Skin-"))
            .collect();
        assert_eq!(backups.len(), 2);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stage_dropped_folder_file_stages_nested_tree_and_rejects_traversal() {
        let root = std::env::temp_dir().join("moddeck_test_stage_drop_folder");
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        fs::create_dir_all(&base_dir).unwrap();

        let err = stage_dropped_folder_file(&base_dir, "sess-1", "../escape.ini", b"bad");
        assert!(err.is_err());
        let err_single = stage_dropped_folder_file(&base_dir, "sess-1", "rootonly.ini", b"bad");
        assert!(err_single.is_err());

        let staged_root = stage_dropped_folder_file(
            &base_dir,
            "sess-1",
            "MyMod/textures/diffuse.ini",
            b"[TextureOverride]\n",
        )
        .unwrap();
        assert!(staged_root.ends_with("MyMod"));
        assert!(staged_root
            .join("textures")
            .join("diffuse.ini")
            .is_file());

        cleanup_staged_drops(&base_dir, &[staged_root.to_string_lossy().to_string()]);
        assert!(!staged_root.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_import_conflict_and_disabled_unique_naming_work() {
        let root = std::env::temp_dir().join("moddeck_test_folder_conflict");
        let _ = fs::remove_dir_all(&root);
        let base_dir = root.join("app_data");
        let mods_dir = root.join("Mods");
        let char_dir = mods_dir.join("伊冯");
        fs::create_dir_all(&base_dir).unwrap();
        fs::create_dir_all(char_dir.join("DISABLED_FolderSkin")).unwrap();
        fs::write(char_dir.join("DISABLED_FolderSkin").join("mod.ini"), "old-v1").unwrap();

        let src_folder = root.join("incoming").join("FolderSkin");
        fs::create_dir_all(&src_folder).unwrap();
        fs::write(src_folder.join("mod.ini"), "[Constants]\nv = 2\n").unwrap();

        // (a) No explicit target and overwrite_existing=false: must pick unique bare-safe name without creating FolderSkin beside DISABLED_FolderSkin
        let mut settings = default_settings();
        settings.games.get_mut("endfield").unwrap().mods_path =
            mods_dir.to_string_lossy().to_string();
        settings.import.overwrite_existing = false;
        let metadata = MetadataStore::default();
        let mut sessions = ImportSessionManager::default();

        let parsed_keep = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "endfield".to_string(),
                paths: vec![src_folder.to_string_lossy().to_string()],
                target_character: Some("伊冯".to_string()),
                passwords: HashMap::new(),
            },
        )
        .unwrap();
        assert_eq!(parsed_keep.candidates.len(), 1);
        let cand_a = &parsed_keep.candidates[0];
        let res_a = commit_import_session(
            &base_dir,
            &settings,
            &mut sessions,
            &ImportCommitRequest {
                session_id: parsed_keep.session_id.clone(),
                game_id: "endfield".to_string(),
                items: vec![crate::models::ImportCommitItem {
                    id: cand_a.id.clone(),
                    character_folder: "伊冯".to_string(),
                    mod_name: Some("FolderSkin".to_string()),
                    overwrite_target: None,
                }],
            },
        )
        .unwrap();
        assert_eq!(res_a.imported_mods, 1);
        assert!(!char_dir.join("FolderSkin").exists());
        assert!(char_dir.join("DISABLED_FolderSkin").join("mod.ini").is_file());
        assert!(char_dir.join("FolderSkin (2)").join("mod.ini").is_file());

        // (b) Explicit overwrite target DISABLED_FolderSkin: backs up to backups/ and preserves DISABLED_FolderSkin
        let parsed_replace = parse_import_sources(
            &base_dir,
            &settings,
            &metadata,
            &mut sessions,
            &ImportParseRequest {
                game_id: "endfield".to_string(),
                paths: vec![src_folder.to_string_lossy().to_string()],
                target_character: Some("伊冯".to_string()),
                passwords: HashMap::new(),
            },
        )
        .unwrap();
        let cand_b = &parsed_replace.candidates[0];
        let res_b = commit_import_session(
            &base_dir,
            &settings,
            &mut sessions,
            &ImportCommitRequest {
                session_id: parsed_replace.session_id.clone(),
                game_id: "endfield".to_string(),
                items: vec![crate::models::ImportCommitItem {
                    id: cand_b.id.clone(),
                    character_folder: "伊冯".to_string(),
                    mod_name: Some("FolderSkin".to_string()),
                    overwrite_target: Some("DISABLED_FolderSkin".to_string()),
                }],
            },
        )
        .unwrap();
        assert_eq!(res_b.imported_mods, 1);
        assert!(!char_dir.join("FolderSkin").exists());
        assert_eq!(
            fs::read_to_string(char_dir.join("DISABLED_FolderSkin").join("mod.ini")).unwrap(),
            "[Constants]\nv = 2\n"
        );
        let backups: Vec<_> = WalkDir::new(base_dir.join("backups"))
            .into_iter()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy() == "DISABLED_FolderSkin")
            .collect();
        assert_eq!(backups.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }
}
