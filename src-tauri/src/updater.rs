use crate::models::{InstallModeInfo, UpdateCheckResult, UpdateInstallResult};
use serde::Deserialize;
use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use zip::ZipArchive;

const GITHUB_RELEASE_LATEST_API: &str =
    "https://api.github.com/repos/yuzhoujun/ModDeck/releases/latest";
const GITHUB_RELEASES_LIST_API: &str =
    "https://api.github.com/repos/yuzhoujun/ModDeck/releases?per_page=10";
const GITHUB_RELEASE_LATEST_WEB: &str =
    "https://github.com/yuzhoujun/ModDeck/releases/latest";
const GITHUB_RELEASES_ATOM: &str =
    "https://github.com/yuzhoujun/ModDeck/releases.atom";
const RAW_PACKAGE_URL: &str =
    "https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/package.json";
const JSDELIVR_PACKAGE_URL: &str =
    "https://cdn.jsdelivr.net/gh/yuzhoujun/ModDeck@main/package.json";
const GITHUB_RELEASE_DOWNLOAD_BASE: &str = "https://github.com/yuzhoujun/ModDeck/releases/download";
const GITHUB_RELEASE_TAG_BASE: &str = "https://github.com/yuzhoujun/ModDeck/releases/tag";

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct PackageJsonVersion {
    version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemVer {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Option<String>,
}

fn parse_semver(raw: &str) -> Option<ParsedSemVer> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    if trimmed.is_empty() {
        return None;
    }
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core, pre) = match without_build.split_once('-') {
        Some((c, p)) => (
            c,
            if p.trim().is_empty() {
                None
            } else {
                Some(p.trim().to_string())
            },
        ),
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedSemVer {
        major,
        minor,
        patch,
        pre,
    })
}

fn compare_prerelease(a: &str, b: &str) -> Ordering {
    let mut a_parts = a.split('.');
    let mut b_parts = b.split('.');
    loop {
        match (a_parts.next(), b_parts.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ap), Some(bp)) => {
                let ord = match (ap.parse::<u64>(), bp.parse::<u64>()) {
                    (Ok(an), Ok(bn)) => an.cmp(&bn),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => ap.cmp(bp),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

fn compare_semver(a: &ParsedSemVer, b: &ParsedSemVer) -> Ordering {
    match a
        .major
        .cmp(&b.major)
        .then_with(|| a.minor.cmp(&b.minor))
        .then_with(|| a.patch.cmp(&b.patch))
    {
        Ordering::Equal => match (&a.pre, &b.pre) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(ap), Some(bp)) => compare_prerelease(ap, bp),
        },
        other => other,
    }
}

pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    match (parse_semver(current), parse_semver(candidate)) {
        (Some(cur), Some(cand)) => compare_semver(&cand, &cur) == Ordering::Greater,
        _ => false,
    }
}

pub fn normalize_version_tag(raw: &str) -> String {
    raw.trim().trim_start_matches(['v', 'V']).to_string()
}

pub fn apply_mirror_url(raw_url: &str, mirror_mode: &str, custom_mirror: &str) -> String {
    let url = raw_url.trim();
    if url.is_empty() {
        return String::new();
    }
    let is_github_url = url.starts_with("https://github.com/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://raw.githubusercontent.com/");
    if !is_github_url {
        return url.to_string();
    }

    match mirror_mode.trim().to_ascii_lowercase().as_str() {
        "ghfast" => format!("https://ghfast.top/{url}"),
        "ghproxy" => format!("https://gh-proxy.org/{url}"),
        "custom" => {
            let custom = custom_mirror.trim();
            if custom.is_empty() {
                url.to_string()
            } else if custom.contains("{url}") {
                custom.replace("{url}", url)
            } else {
                let prefix = custom.trim_end_matches('/');
                format!("{prefix}/{url}")
            }
        }
        _ => url.to_string(),
    }
}

#[cfg(windows)]
fn read_nsis_install_dir_from_registry() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey("Software\\yuzhoujun\\ModDeck") {
        for value_name in ["", "InstallDir", "InstallLocation"] {
            if let Ok(val) = key.get_value::<String, _>(value_name) {
                let trimmed = val.trim();
                if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    if let Ok(key) =
        hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ModDeck")
    {
        if let Ok(val) = key.get_value::<String, _>("InstallLocation") {
            let trimmed = val.trim();
            if !trimmed.is_empty() && Path::new(trimmed).is_dir() {
                return Some(trimmed.to_string());
            }
        }
        if let Ok(uninst) = key.get_value::<String, _>("UninstallString") {
            let clean = uninst.trim().trim_matches('"');
            if let Some(parent) = Path::new(clean).parent() {
                if parent.is_dir() {
                    return Some(parent.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn read_nsis_install_dir_from_registry() -> Option<String> {
    None
}

fn paths_match_dir(a: &Path, b: &Path) -> bool {
    let ca = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca.to_string_lossy()
        .eq_ignore_ascii_case(&cb.to_string_lossy())
}

pub fn detect_install_mode() -> InstallModeInfo {
    let exe_dir_buf = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let exe_dir = exe_dir_buf.to_string_lossy().to_string();
    let reg_dir = read_nsis_install_dir_from_registry();
    let has_local_uninstaller = exe_dir_buf.join("uninstall.exe").is_file();
    let matches_registry_dir = reg_dir
        .as_deref()
        .map(|rd| paths_match_dir(&exe_dir_buf, Path::new(rd)))
        .unwrap_or(false);

    let mode = if has_local_uninstaller || matches_registry_dir {
        "installer"
    } else {
        "portable"
    };

    InstallModeInfo {
        mode: mode.to_string(),
        install_dir: if matches_registry_dir || has_local_uninstaller {
            Some(reg_dir.unwrap_or_else(|| exe_dir.clone()))
        } else {
            reg_dir
        },
        exe_dir,
        can_self_update: true,
    }
}

fn ureq_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .timeout(Duration::from_secs(12))
        .build()
}

fn no_redirect_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(8))
        .timeout(Duration::from_secs(10))
        .build()
}

fn pick_release_asset<'a>(assets: &'a [GitHubAsset], install_mode: &str) -> Option<&'a GitHubAsset> {
    let prefer_installer = install_mode == "installer";
    if prefer_installer {
        if let Some(a) = assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
        {
            return Some(a);
        }
    } else if let Some(a) = assets.iter().find(|a| {
        let lower = a.name.to_ascii_lowercase();
        lower.ends_with(".zip") && lower.contains("win")
    }) {
        return Some(a);
    }

    assets
        .iter()
        .find(|a| {
            let lower = a.name.to_ascii_lowercase();
            lower.ends_with("-setup.exe") || lower.ends_with(".zip")
        })
}

fn build_fallback_asset(version: &str, install_mode: &str) -> (String, String) {
    let clean_ver = normalize_version_tag(version);
    let asset_name = if install_mode == "installer" {
        format!("ModDeck-{clean_ver}-win-x64-setup.exe")
    } else {
        format!("ModDeck-{clean_ver}-win-x64.zip")
    };
    let raw_url = format!("{GITHUB_RELEASE_DOWNLOAD_BASE}/v{clean_ver}/{asset_name}");
    (asset_name, raw_url)
}

fn fetch_github_release(
    agent: &ureq::Agent,
    current_is_prerelease: bool,
) -> Result<GitHubRelease, String> {
    let url = if current_is_prerelease {
        GITHUB_RELEASES_LIST_API
    } else {
        GITHUB_RELEASE_LATEST_API
    };
    let resp = agent
        .get(url)
        .set("User-Agent", &format!("ModDeck/{}", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("GitHub Releases request failed: {e}"))?;

    if current_is_prerelease {
        let list: Vec<GitHubRelease> = resp
            .into_json()
            .map_err(|e| format!("Invalid GitHub Releases JSON: {e}"))?;
        let mut best: Option<GitHubRelease> = None;
        for rel in list.into_iter().filter(|r| !r.draft) {
            if rel.prerelease || best.is_none() {
                if let Some(cur_best) = &best {
                    let cand_ver = parse_semver(&rel.tag_name);
                    let best_ver = parse_semver(&cur_best.tag_name);
                    if let (Some(c), Some(b)) = (cand_ver, best_ver) {
                        if compare_semver(&c, &b) == Ordering::Greater {
                            best = Some(rel);
                        }
                    }
                } else {
                    best = Some(rel);
                }
            } else if let Some(cur_best) = &best {
                let cand_ver = parse_semver(&rel.tag_name);
                let best_ver = parse_semver(&cur_best.tag_name);
                if let (Some(c), Some(b)) = (cand_ver, best_ver) {
                    if compare_semver(&c, &b) == Ordering::Greater {
                        best = Some(rel);
                    }
                }
            }
        }
        best.ok_or_else(|| "No published GitHub releases found".to_string())
    } else {
        let rel: GitHubRelease = resp
            .into_json()
            .map_err(|e| format!("Invalid GitHub Release JSON: {e}"))?;
        if rel.draft {
            return Err("Latest release is marked draft".to_string());
        }
        Ok(rel)
    }
}

fn extract_tag_from_release_url(url_or_path: &str) -> Option<String> {
    let (_, tail) = url_or_path.rsplit_once("/releases/tag/")?;
    let clean = tail
        .split(['?', '#'])
        .next()
        .unwrap_or(tail)
        .trim()
        .trim_matches('/');
    if clean.is_empty() || parse_semver(clean).is_none() {
        return None;
    }
    Some(normalize_version_tag(clean))
}

fn parse_best_tag_from_releases_atom(xml: &str, include_prerelease: bool) -> Option<String> {
    let mut best: Option<(ParsedSemVer, String)> = None;
    let mut rest = xml;
    while let Some(id_start) = rest.find("<id>") {
        let after_start = &rest[id_start + 4..];
        let Some(id_end) = after_start.find("</id>") else {
            break;
        };
        let id_val = after_start[..id_end].trim();
        rest = &after_start[id_end + 5..];

        // Atom release entry IDs use "tag:github.com,2008:Repository/<repo_id>/<tag>";
        // reading <id> avoids picking up links mentioned inside escaped HTML release notes.
        if !id_val.starts_with("tag:github.com,") || !id_val.contains(":Repository/") {
            continue;
        }
        let Some((_, raw_tag)) = id_val.rsplit_once('/') else {
            continue;
        };
        let Some(ver) = parse_semver(raw_tag) else {
            continue;
        };
        if !include_prerelease && ver.pre.is_some() {
            continue;
        }
        let norm = normalize_version_tag(raw_tag);
        let is_better = best
            .as_ref()
            .map(|(cur_ver, _)| compare_semver(&ver, cur_ver) == Ordering::Greater)
            .unwrap_or(true);
        if is_better {
            best = Some((ver, norm));
        }
    }
    best.map(|(_, tag)| tag)
}

fn validate_package_json_candidate(raw_version: &str, allow_prerelease: bool) -> Result<String, String> {
    let ver = parse_semver(raw_version)
        .ok_or_else(|| format!("Invalid SemVer in package.json: {raw_version}"))?;
    if !allow_prerelease && ver.pre.is_some() {
        return Err(format!(
            "Skipping pre-release manifest version {} on stable channel",
            normalize_version_tag(raw_version)
        ));
    }
    Ok(normalize_version_tag(raw_version))
}

fn fetch_github_latest_web_tag() -> Result<String, String> {
    let agent = no_redirect_agent();
    let resp = agent
        .get(GITHUB_RELEASE_LATEST_WEB)
        .set("User-Agent", &format!("ModDeck/{}", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("GitHub web latest redirect check failed: {e}"))?;

    let location = resp
        .header("location")
        .or_else(|| resp.header("Location"))
        .unwrap_or_else(|| resp.get_url());
    let tag = extract_tag_from_release_url(location)
        .ok_or_else(|| format!("No release tag found in redirect target: {location}"))?;
    validate_package_json_candidate(&tag, false)
}

fn fetch_github_atom_best_tag(
    agent: &ureq::Agent,
    url: &str,
    include_prerelease: bool,
) -> Result<String, String> {
    let resp = agent
        .get(url)
        .set("User-Agent", &format!("ModDeck/{}", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/atom+xml, application/xml, text/xml")
        .call()
        .map_err(|e| format!("GitHub releases.atom request failed: {e}"))?;
    let body = resp
        .into_string()
        .map_err(|e| format!("Invalid releases.atom response body: {e}"))?;
    parse_best_tag_from_releases_atom(&body, include_prerelease)
        .ok_or_else(|| "No matching release tag found in releases.atom".to_string())
}

fn fetch_package_json_version(
    agent: &ureq::Agent,
    url: &str,
    allow_prerelease: bool,
) -> Result<String, String> {
    let resp = agent
        .get(url)
        .set("User-Agent", &format!("ModDeck/{}", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("Manifest check failed ({url}): {e}"))?;
    let pkg: PackageJsonVersion = resp
        .into_json()
        .map_err(|e| format!("Invalid package.json ({url}): {e}"))?;
    validate_package_json_candidate(&pkg.version, allow_prerelease)
}

fn build_tag_check_result(
    latest_ver: String,
    current_version: String,
    install_mode: String,
    mirror_mode: &str,
    custom_mirror: &str,
    source_used: &str,
) -> UpdateCheckResult {
    let has_update = is_newer_version(&current_version, &latest_ver);
    let (asset_name, raw_url) = build_fallback_asset(&latest_ver, &install_mode);
    let mirrored = apply_mirror_url(&raw_url, mirror_mode, custom_mirror);
    UpdateCheckResult {
        ok: true,
        current_version,
        latest_version: Some(latest_ver.clone()),
        has_update,
        release_url: Some(format!("{GITHUB_RELEASE_TAG_BASE}/v{latest_ver}")),
        release_notes: None,
        asset_name: Some(asset_name),
        asset_url: Some(raw_url),
        mirrored_asset_url: Some(mirrored),
        asset_size: None,
        published_at: None,
        install_mode,
        source_used: Some(source_used.to_string()),
        error: None,
    }
}

pub fn check_for_updates(
    mirror_mode: &str,
    custom_mirror: &str,
    is_en: bool,
) -> UpdateCheckResult {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let mode_info = detect_install_mode();
    let current_is_pre = parse_semver(&current_version)
        .and_then(|v| v.pre)
        .is_some();
    let agent = ureq_agent();
    let mut errors: Vec<String> = Vec::new();

    match fetch_github_release(&agent, current_is_pre) {
        Ok(rel) => {
            let latest_ver = normalize_version_tag(&rel.tag_name);
            let has_update = is_newer_version(&current_version, &latest_ver);
            let picked = pick_release_asset(&rel.assets, &mode_info.mode);
            let (asset_name, asset_url, asset_size) = if let Some(a) = picked {
                (
                    Some(a.name.clone()),
                    Some(a.browser_download_url.clone()),
                    if a.size > 0 { Some(a.size) } else { None },
                )
            } else {
                let (fallback_name, fallback_url) = build_fallback_asset(&latest_ver, &mode_info.mode);
                (Some(fallback_name), Some(fallback_url), None)
            };
            let mirrored_asset_url = asset_url
                .as_deref()
                .map(|u| apply_mirror_url(u, mirror_mode, custom_mirror));

            return UpdateCheckResult {
                ok: true,
                current_version,
                latest_version: Some(latest_ver.clone()),
                has_update,
                release_url: if rel.html_url.trim().is_empty() {
                    Some(format!("{GITHUB_RELEASE_TAG_BASE}/v{latest_ver}"))
                } else {
                    Some(rel.html_url)
                },
                release_notes: rel.body,
                asset_name,
                asset_url,
                mirrored_asset_url,
                asset_size,
                published_at: rel.published_at,
                install_mode: mode_info.mode,
                source_used: Some("github-api".to_string()),
                error: None,
            };
        }
        Err(err) => errors.push(err),
    }

    // Tier 2: GitHub web redirect (stable) and releases.atom (both channels) avoid REST API rate limits.
    if !current_is_pre {
        match fetch_github_latest_web_tag() {
            Ok(latest_ver) => {
                return build_tag_check_result(
                    latest_ver,
                    current_version,
                    mode_info.mode,
                    mirror_mode,
                    custom_mirror,
                    "github-web",
                );
            }
            Err(err) => errors.push(err),
        }
    }

    match fetch_github_atom_best_tag(&agent, GITHUB_RELEASES_ATOM, current_is_pre) {
        Ok(latest_ver) => {
            return build_tag_check_result(
                latest_ver,
                current_version,
                mode_info.mode,
                mirror_mode,
                custom_mirror,
                "github-atom",
            );
        }
        Err(err) => errors.push(err),
    }

    // Tier 3: Configured URL proxy mirror for releases.atom + raw.githubusercontent.com fallback.
    let normalized_mirror = mirror_mode.trim().to_ascii_lowercase();
    let supports_web_proxy = normalized_mirror == "ghproxy"
        || (normalized_mirror == "custom" && !custom_mirror.trim().is_empty());
    if supports_web_proxy {
        let mirrored_atom = apply_mirror_url(GITHUB_RELEASES_ATOM, mirror_mode, custom_mirror);
        match fetch_github_atom_best_tag(&agent, &mirrored_atom, current_is_pre) {
            Ok(latest_ver) => {
                return build_tag_check_result(
                    latest_ver,
                    current_version,
                    mode_info.mode,
                    mirror_mode,
                    custom_mirror,
                    "mirror-atom",
                );
            }
            Err(err) => errors.push(err),
        }
    }

    let raw_url = if supports_web_proxy {
        apply_mirror_url(RAW_PACKAGE_URL, mirror_mode, custom_mirror)
    } else {
        RAW_PACKAGE_URL.to_string()
    };
    match fetch_package_json_version(&agent, &raw_url, current_is_pre) {
        Ok(latest_ver) => {
            return build_tag_check_result(
                latest_ver,
                current_version,
                mode_info.mode,
                mirror_mode,
                custom_mirror,
                "raw-fallback",
            );
        }
        Err(err) => errors.push(err),
    }

    // Tier 4: jsDelivr CDN (works without VPN in CN, guarded against exposing unreleased pre-releases to stable builds).
    match fetch_package_json_version(&agent, JSDELIVR_PACKAGE_URL, current_is_pre) {
        Ok(latest_ver) => build_tag_check_result(
            latest_ver,
            current_version,
            mode_info.mode,
            mirror_mode,
            custom_mirror,
            "jsdelivr-fallback",
        ),
        Err(cdn_err) => {
            errors.push(cdn_err);
            let summary = errors.join("; ");
            UpdateCheckResult {
                ok: false,
                current_version,
                latest_version: None,
                has_update: false,
                release_url: None,
                release_notes: None,
                asset_name: None,
                asset_url: None,
                mirrored_asset_url: None,
                asset_size: None,
                published_at: None,
                install_mode: mode_info.mode,
                source_used: None,
                error: Some(if is_en {
                    format!("Update check failed: {summary}")
                } else {
                    format!("检查更新失败：{summary}")
                }),
            }
        }
    }
}

fn validate_update_asset_params(asset_url: &str, asset_name: &str) -> Result<(String, String), String> {
    let clean_url = asset_url.trim();
    if !clean_url.starts_with("https://") {
        return Err("Update download URL must use HTTPS".to_string());
    }
    let clean_name = asset_name.trim();
    if clean_name.is_empty()
        || clean_name.contains('/')
        || clean_name.contains('\\')
        || clean_name.contains("..")
    {
        return Err("Invalid update package filename".to_string());
    }
    let lower = clean_name.to_ascii_lowercase();
    if !lower.starts_with("moddeck-") || (!lower.ends_with(".exe") && !lower.ends_with(".zip")) {
        return Err("Unsupported update package filename".to_string());
    }
    Ok((clean_url.to_string(), clean_name.to_string()))
}

fn download_asset_to_temp(url: &str, file_name: &str, expected_size: Option<u64>) -> Result<PathBuf, String> {
    let temp_dir = std::env::temp_dir().join(format!("moddeck-update-{}", std::process::id()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let dest_path = temp_dir.join(file_name);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(45))
        .timeout(Duration::from_secs(300))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", &format!("ModDeck/{}", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("Download failed: {e}"))?;

    let mut reader = resp.into_reader();
    let mut out = fs::File::create(&dest_path).map_err(|e| format!("Create file failed: {e}"))?;
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Read stream failed: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("Write file failed: {e}"))?;
        total += n as u64;
        if total > 200 * 1024 * 1024 {
            let _ = fs::remove_file(&dest_path);
            return Err("Downloaded asset exceeded 200 MB safety limit".to_string());
        }
    }
    out.flush().map_err(|e| format!("Flush failed: {e}"))?;
    drop(out);

    if total < 64 * 1024 {
        let _ = fs::remove_file(&dest_path);
        return Err("Downloaded file is unexpectedly small (mirror may have returned an error page)".to_string());
    }
    if let Some(exp) = expected_size {
        if exp > 0 && total != exp {
            let _ = fs::remove_file(&dest_path);
            return Err(format!("Downloaded size mismatch: expected {exp} bytes, got {total}"));
        }
    }

    Ok(dest_path)
}

fn find_portable_payload_root(stage_dir: &Path) -> Option<PathBuf> {
    if stage_dir.join("ModDeck.exe").is_file() {
        return Some(stage_dir.to_path_buf());
    }
    let entries = fs::read_dir(stage_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && p.join("ModDeck.exe").is_file() {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
fn spawn_hidden_powershell(script_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            &script_path.to_string_lossy(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch portable updater helper: {e}"))
}

#[cfg(not(windows))]
fn spawn_hidden_powershell(_script_path: &Path) -> Result<(), String> {
    Err("Self-update helper is only supported on Windows".to_string())
}

pub fn download_and_launch_update(
    asset_url: &str,
    asset_name: &str,
    expected_size: Option<u64>,
    is_en: bool,
) -> UpdateInstallResult {
    let mode_info = detect_install_mode();
    let (clean_url, clean_name) = match validate_update_asset_params(asset_url, asset_name) {
        Ok(pair) => pair,
        Err(err) => {
            return UpdateInstallResult {
                ok: false,
                mode: mode_info.mode,
                launched: false,
                message: None,
                downloaded_path: None,
                error: Some(err),
            }
        }
    };

    let downloaded = match download_asset_to_temp(&clean_url, &clean_name, expected_size) {
        Ok(p) => p,
        Err(err) => {
            return UpdateInstallResult {
                ok: false,
                mode: mode_info.mode,
                launched: false,
                message: None,
                downloaded_path: None,
                error: Some(err),
            }
        }
    };

    let lower = clean_name.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        let header_ok = fs::read(&downloaded)
            .map(|b| b.len() >= 2 && b[0] == b'M' && b[1] == b'Z')
            .unwrap_or(false);
        if !header_ok {
            let _ = fs::remove_file(&downloaded);
            return UpdateInstallResult {
                ok: false,
                mode: mode_info.mode,
                launched: false,
                message: None,
                downloaded_path: None,
                error: Some(if is_en {
                    "Downloaded installer is not a valid Windows executable".to_string()
                } else {
                    "下载的安装包不是有效的 Windows 可执行文件".to_string()
                }),
            };
        }

        if let Err(err) = Command::new(&downloaded).spawn() {
            return UpdateInstallResult {
                ok: false,
                mode: mode_info.mode,
                launched: false,
                message: None,
                downloaded_path: Some(downloaded.to_string_lossy().to_string()),
                error: Some(format!("Failed to launch installer: {err}")),
            };
        }

        return UpdateInstallResult {
            ok: true,
            mode: "installer".to_string(),
            launched: true,
            message: Some(if is_en {
                "Installer wizard launched. ModDeck will close so you can complete the upgrade and choose launch options on the finish page."
                    .to_string()
            } else {
                "已启动安装向导，ModDeck 即将退出；请在完成向导后按需勾选启动应用或创建快捷方式。".to_string()
            }),
            downloaded_path: Some(downloaded.to_string_lossy().to_string()),
            error: None,
        };
    }

    // Portable ZIP update: extract to temp stage dir, validate ModDeck.exe, then launch detached swapper.
    let stage_dir = downloaded
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("stage");
    let _ = fs::remove_dir_all(&stage_dir);
    if let Err(err) = fs::create_dir_all(&stage_dir) {
        return UpdateInstallResult {
            ok: false,
            mode: mode_info.mode,
            launched: false,
            message: None,
            downloaded_path: Some(downloaded.to_string_lossy().to_string()),
            error: Some(format!("Failed to create staging dir: {err}")),
        };
    }

    let extract_res = (|| -> Result<(), String> {
        let file = fs::File::open(&downloaded).map_err(|e| format!("Open zip failed: {e}"))?;
        let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip archive: {e}"))?;
        for idx in 0..archive.len() {
            let mut entry = archive.by_index(idx).map_err(|e| format!("Zip entry error: {e}"))?;
            let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let target = stage_dir.join(rel);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|e| format!("Mkdir failed: {e}"))?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("Mkdir failed: {e}"))?;
                }
                let mut out = fs::File::create(&target).map_err(|e| format!("Extract file failed: {e}"))?;
                std::io::copy(&mut entry, &mut out).map_err(|e| format!("Extract copy failed: {e}"))?;
            }
        }
        Ok(())
    })();

    if let Err(err) = extract_res {
        let _ = fs::remove_dir_all(&stage_dir);
        return UpdateInstallResult {
            ok: false,
            mode: mode_info.mode,
            launched: false,
            message: None,
            downloaded_path: None,
            error: Some(err),
        };
    }

    let Some(payload_root) = find_portable_payload_root(&stage_dir) else {
        let _ = fs::remove_dir_all(&stage_dir);
        return UpdateInstallResult {
            ok: false,
            mode: mode_info.mode,
            launched: false,
            message: None,
            downloaded_path: None,
            error: Some(if is_en {
                "Portable archive does not contain ModDeck.exe".to_string()
            } else {
                "便携压缩包内未找到 ModDeck.exe".to_string()
            }),
        };
    };

    let target_dir = PathBuf::from(&mode_info.exe_dir);
    let temp_root = downloaded.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
    let script_path = temp_root.join("apply-portable-update.ps1");
    let pid = std::process::id();
    let esc = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let safe_from_ver = env!("CARGO_PKG_VERSION").replace('\'', "");
    let ps_script = format!(
        "$ErrorActionPreference = 'Stop'\r\n\
         $pidToWait = {pid}\r\n\
         $srcDir = '{src}'\r\n\
         $dstDir = '{dst}'\r\n\
         $cleanupDir = '{tmp}'\r\n\
         $updatedFrom = '{from_ver}'\r\n\
         for ($i = 0; $i -lt 40; $i++) {{\r\n\
           if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) {{ break }}\r\n\
           Start-Sleep -Milliseconds 300\r\n\
         }}\r\n\
         Start-Sleep -Milliseconds 350\r\n\
         for ($attempt = 0; $attempt -lt 6; $attempt++) {{\r\n\
           try {{\r\n\
             Copy-Item -Path (Join-Path $srcDir '*') -Destination $dstDir -Recurse -Force\r\n\
             break\r\n\
           }} catch {{\r\n\
             if ($attempt -ge 5) {{ throw }}\r\n\
             Start-Sleep -Milliseconds 400\r\n\
           }}\r\n\
         }}\r\n\
         $exePath = Join-Path $dstDir 'ModDeck.exe'\r\n\
         if (Test-Path $exePath) {{ Start-Process -FilePath $exePath -WorkingDirectory $dstDir -WindowStyle Normal -ArgumentList \"--updated-from=$updatedFrom\" }}\r\n\
         Start-Sleep -Seconds 2\r\n\
         Remove-Item -Path $cleanupDir -Recurse -Force -ErrorAction SilentlyContinue\r\n",
        src = esc(&payload_root),
        dst = esc(&target_dir),
        tmp = esc(&temp_root),
        from_ver = safe_from_ver
    );

    if let Err(err) = fs::write(&script_path, ps_script) {
        return UpdateInstallResult {
            ok: false,
            mode: mode_info.mode,
            launched: false,
            message: None,
            downloaded_path: Some(downloaded.to_string_lossy().to_string()),
            error: Some(format!("Failed to write update script: {err}")),
        };
    }

    if let Err(err) = spawn_hidden_powershell(&script_path) {
        return UpdateInstallResult {
            ok: false,
            mode: mode_info.mode,
            launched: false,
            message: None,
            downloaded_path: Some(downloaded.to_string_lossy().to_string()),
            error: Some(err),
        };
    }

    UpdateInstallResult {
        ok: true,
        mode: "portable".to_string(),
        launched: true,
        message: Some(if is_en {
            "Portable update prepared. ModDeck will restart automatically after replacing files."
                .to_string()
        } else {
            "便携版更新已就绪，ModDeck 即将重启并自动替换新版文件。".to_string()
        }),
        downloaded_path: Some(downloaded.to_string_lossy().to_string()),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_ordering_handles_prerelease_and_patch() {
        assert!(is_newer_version("3.1.0-alpha.1", "3.1.0-alpha.2"));
        assert!(is_newer_version("3.1.0-alpha.1", "3.1.0-beta.1"));
        assert!(is_newer_version("3.1.0-rc.1", "3.1.0"));
        assert!(is_newer_version("3.0.1", "v3.1.0"));
        assert!(!is_newer_version("3.1.0", "3.1.0-rc.2"));
        assert!(!is_newer_version("3.1.0", "3.1.0"));
    }

    #[test]
    fn mirror_url_rewriting_supports_presets_and_custom() {
        let raw = "https://github.com/yuzhoujun/ModDeck/releases/download/v3.1.0/ModDeck-3.1.0-win-x64.zip";
        assert_eq!(apply_mirror_url(raw, "direct", ""), raw);
        assert_eq!(
            apply_mirror_url(raw, "ghfast", ""),
            format!("https://ghfast.top/{raw}")
        );
        assert_eq!(
            apply_mirror_url(raw, "ghproxy", ""),
            format!("https://gh-proxy.org/{raw}")
        );
        assert_eq!(
            apply_mirror_url("https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/package.json", "ghproxy", ""),
            "https://gh-proxy.org/https://raw.githubusercontent.com/yuzhoujun/ModDeck/main/package.json"
        );
        assert_eq!(
            apply_mirror_url(raw, "custom", "https://mirror.example.com/"),
            format!("https://mirror.example.com/{raw}")
        );
        assert_eq!(
            apply_mirror_url(raw, "custom", "https://dl.example.com/?target={url}"),
            format!("https://dl.example.com/?target={raw}")
        );
    }

    #[test]
    fn parses_releases_atom_and_redirect_urls_safely() {
        let sample_atom = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/yuzhoujun/ModDeck/releases</id>
  <entry>
    <id>tag:github.com,2008:Repository/1425449614/v3.1.0-alpha.3</id>
    <content type="html">&lt;a href="https://github.com/yuzhoujun/ModDeck/releases/tag/v9.9.9"&gt;fake&lt;/a&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1425449614/v3.0.1</id>
  </entry>
</feed>"#;
        assert_eq!(
            parse_best_tag_from_releases_atom(sample_atom, true).as_deref(),
            Some("3.1.0-alpha.3")
        );
        assert_eq!(
            parse_best_tag_from_releases_atom(sample_atom, false).as_deref(),
            Some("3.0.1")
        );
        assert_eq!(
            extract_tag_from_release_url("https://github.com/yuzhoujun/ModDeck/releases/tag/v3.0.1?foo=1").as_deref(),
            Some("3.0.1")
        );
        assert_eq!(
            extract_tag_from_release_url("/yuzhoujun/ModDeck/releases/tag/v3.1.0-alpha.2").as_deref(),
            Some("3.1.0-alpha.2")
        );
        assert!(validate_package_json_candidate("3.2.0-alpha.1", false).is_err());
        assert_eq!(
            validate_package_json_candidate("3.2.0-alpha.1", true).unwrap(),
            "3.2.0-alpha.1"
        );
        assert_eq!(validate_package_json_candidate("3.1.0", false).unwrap(), "3.1.0");
    }

    #[test]
    fn validates_safe_asset_filenames() {
        assert!(validate_update_asset_params(
            "https://github.com/yuzhoujun/ModDeck/releases/download/v3.1.0/ModDeck-3.1.0-win-x64.zip",
            "ModDeck-3.1.0-win-x64.zip"
        )
        .is_ok());
        assert!(validate_update_asset_params(
            "http://github.com/foo.zip",
            "ModDeck-3.1.0-win-x64.zip"
        )
        .is_err());
        assert!(validate_update_asset_params(
            "https://github.com/foo.zip",
            "../evil.exe"
        )
        .is_err());
    }
}
