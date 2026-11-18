use crate::detect::{
    detect_xxmi_and_game_paths, effective_xxmi_root, find_exe_in_dir, find_xxmi_launcher_exe,
    launcher_exe_candidates,
};
use crate::games::{get_all_games, get_game};
use crate::models::{Settings, SimpleResult};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Splits a shell-style argument string while respecting single and double quotes.
pub fn parse_launch_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = raw.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == '\\' && q == '"' && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if !current.is_empty() {
                args.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(windows)]
fn quote_win_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".to_string();
    }
    if arg.chars().any(|c| c.is_whitespace() || c == '"') {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn shell_execute_open(exe_path: &Path, args: &[String], cwd: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op: Vec<u16> = "open\0".encode_utf16().collect();
    let file_w: Vec<u16> = exe_path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let args_joined = args
        .iter()
        .map(|a| quote_win_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let args_w: Vec<u16> = args_joined.encode_utf16().chain(Some(0)).collect();
    let cwd_w: Vec<u16> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();

    let hinst = unsafe {
        ShellExecuteW(
            HWND::default(),
            PCWSTR(op.as_ptr()),
            PCWSTR(file_w.as_ptr()),
            if args_joined.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(args_w.as_ptr())
            },
            PCWSTR(cwd_w.as_ptr()),
            SW_SHOWNORMAL,
        )
    };
    let code = hinst.0 as isize;
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code}"));
    }
    Ok(())
}

fn spawn_executable(exe_path: &Path, args: &[String], cwd: &Path) -> Result<(), String> {
    let ext = exe_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "cmd" || ext == "bat" {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        Command::new(comspec)
            .arg("/c")
            .arg(exe_path)
            .args(args)
            .current_dir(cwd)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to launch script: {e}"))?;
        return Ok(());
    }

    match Command::new(exe_path).args(args).current_dir(cwd).spawn() {
        Ok(_) => Ok(()),
        Err(err) => {
            #[cfg(windows)]
            {
                let _ = err;
                return shell_execute_open(exe_path, args, cwd);
            }
            #[cfg(not(windows))]
            {
                Err(format!("Failed to launch {}: {err}", exe_path.display()))
            }
        }
    }
}

fn is_xxmi_launcher_exe(path_str: &str) -> bool {
    Path::new(path_str)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|n| {
            let lower = n.to_ascii_lowercase();
            lower == "xxmi launcher.exe" || lower == "xxmilauncher.exe"
        })
        .unwrap_or(false)
}

/// Launches the configured mod loader (`XXMI Launcher.exe --nogui --xxmi <CODE>` or custom exe) or official game launcher.
pub fn launch_configured(settings: &Settings, game_id: &str, kind: &str) -> SimpleResult {
    let Some(game) = get_game(settings, game_id) else {
        return SimpleResult {
            ok: false,
            error: Some(format!("Unknown game: {game_id}")),
        };
    };
    let Some(gs) = settings.games.get(&game.id) else {
        return SimpleResult {
            ok: false,
            error: Some(format!("Game settings not found: {}", game.id)),
        };
    };

    if kind == "loader" {
        let custom_loader = gs.loader_path.as_deref().map(str::trim).unwrap_or("");
        if !custom_loader.is_empty() && !is_xxmi_launcher_exe(custom_loader) {
            let p = Path::new(custom_loader);
            if p.is_file() {
                let cwd = p.parent().unwrap_or_else(|| Path::new("."));
                return match spawn_executable(p, &[], cwd) {
                    Ok(()) => SimpleResult { ok: true, error: None },
                    Err(e) => SimpleResult { ok: false, error: Some(e) },
                };
            }
        }

        let mut xxmi_exe: Option<PathBuf> = None;
        if !custom_loader.is_empty() && is_xxmi_launcher_exe(custom_loader) {
            let p = PathBuf::from(custom_loader);
            if p.is_file() {
                xxmi_exe = Some(p);
            }
        }
        if xxmi_exe.is_none() {
            if let Some(root) = effective_xxmi_root(settings, Some(&game.id)) {
                xxmi_exe = find_xxmi_launcher_exe(Path::new(&root));
            }
        }
        if xxmi_exe.is_none() {
            let detected = detect_xxmi_and_game_paths(settings, None);
            if let Some(root) = detected.xxmi_root {
                xxmi_exe = find_xxmi_launcher_exe(Path::new(&root));
            }
        }

        let Some(exe) = xxmi_exe else {
            return SimpleResult {
                ok: false,
                error: Some("XXMI Launcher.exe not found; please configure Loader or XXMI Root in Settings".to_string()),
            };
        };

        let loader_code = game
            .loader
            .split_whitespace()
            .next()
            .unwrap_or(&game.loader)
            .to_string();
        let args = vec!["--nogui".to_string(), "--xxmi".to_string(), loader_code];
        let cwd = exe.parent().unwrap_or_else(|| Path::new("."));
        return match spawn_executable(&exe, &args, cwd) {
            Ok(()) => SimpleResult { ok: true, error: None },
            Err(e) => SimpleResult { ok: false, error: Some(e) },
        };
    }

    // kind == "game"
    let mut target = gs.game_path.as_deref().map(str::trim).unwrap_or("").to_string();
    if target.is_empty() || !Path::new(&target).exists() {
        let detected = detect_xxmi_and_game_paths(settings, None);
        if let Some(det_gs) = detected.settings.as_ref().and_then(|s| s.games.get(&game.id)) {
            if let Some(gp) = det_gs.game_path.as_deref().map(str::trim) {
                if !gp.is_empty() {
                    target = gp.to_string();
                }
            }
        }
    }
    if target.is_empty() {
        return SimpleResult {
            ok: false,
            error: Some("Official launcher or game executable is not configured".to_string()),
        };
    }
    let target_path = PathBuf::from(&target);
    if !target_path.exists() {
        return SimpleResult {
            ok: false,
            error: Some(format!("Launcher or game executable not found: {target}")),
        };
    }

    let resolved = if target_path.is_file() {
        target_path
    } else if target_path.is_dir() {
        let mut candidates = launcher_exe_candidates();
        if let Some(hint) = &game.exe_hint {
            for part in hint.split('|') {
                let p = part.trim();
                if !p.is_empty() && !candidates.iter().any(|x| x.eq_ignore_ascii_case(p)) {
                    candidates.push(p.to_string());
                }
            }
        }
        let Some(found) = find_exe_in_dir(&target_path, &candidates) else {
            return SimpleResult {
                ok: false,
                error: Some(format!("No executable found inside {target}")),
            };
        };
        found
    } else {
        return SimpleResult {
            ok: false,
            error: Some(format!("Invalid executable path: {target}")),
        };
    };

    let mut final_exe = resolved;
    if game.id == "endfield" {
        if let Some(name) = final_exe.file_name().and_then(|n| n.to_str()) {
            if name.eq_ignore_ascii_case("endfield.exe") {
                if let Some(official) = final_exe
                    .parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|p| p.join("Launcher.exe"))
                {
                    if official.is_file() {
                        final_exe = official;
                    }
                }
            }
        }
    }

    let args = parse_launch_args(gs.launch_args.as_deref().unwrap_or(""));
    let cwd = final_exe.parent().unwrap_or_else(|| Path::new("."));
    match spawn_executable(&final_exe, &args, cwd) {
        Ok(()) => SimpleResult { ok: true, error: None },
        Err(e) => SimpleResult { ok: false, error: Some(e) },
    }
}

fn game_process_names(settings: &Settings, game_id: Option<&str>) -> HashSet<String> {
    let mut names = HashSet::new();
    let target_id = game_id.unwrap_or(&settings.active_game_id);

    if let Some(gp) = settings
        .games
        .get(target_id)
        .and_then(|g| g.game_path.as_deref())
    {
        if let Some(fname) = Path::new(gp.trim()).file_name().and_then(|s| s.to_str()) {
            let lower = fname.trim().to_ascii_lowercase();
            if lower.ends_with(".exe") {
                names.insert(lower);
            }
        }
    }
    if let Some(active_def) = get_all_games(settings).into_iter().find(|g| g.id == target_id) {
        if let Some(hint) = active_def.exe_hint {
            for part in hint.split('|') {
                let p = part.trim().to_ascii_lowercase();
                if !p.is_empty() {
                    if p.ends_with(".exe") {
                        names.insert(p);
                    } else {
                        names.insert(format!("{p}.exe"));
                    }
                }
            }
        }
    }

    for builtin in [
        "endfield.exe",
        "client-win64-shipping.exe",
        "wuthering waves.exe",
        "starrail.exe",
        "zenlesszonezero.exe",
        "nte.exe",
        "genshinimpact.exe",
        "yuanshen.exe",
    ] {
        names.insert(builtin.to_string());
    }
    names
}

/// Checks whether a supported game process (for the given or active game) is currently running.
#[cfg(windows)]
pub fn is_game_process_running(settings: &Settings, game_id: Option<&str>) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let targets = game_process_names(settings, game_id);
    if targets.is_empty() {
        return false;
    }

    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return false;
    };

    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };

    let mut found = false;
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
            if targets.contains(&name) {
                found = true;
                break;
            }
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    found
}

#[cfg(not(windows))]
pub fn is_game_process_running(_settings: &Settings, _game_id: Option<&str>) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_settings;

    #[test]
    fn parses_quoted_and_unquoted_launch_args() {
        assert_eq!(
            parse_launch_args(r#"-popupwindow --profile "My Custom Profile" -dx11"#),
            vec!["-popupwindow", "--profile", "My Custom Profile", "-dx11"]
        );
        assert_eq!(parse_launch_args("   "), Vec::<String>::new());
    }

    #[test]
    fn collects_expected_game_process_hints() {
        let mut settings = default_settings();
        settings.games.get_mut("endfield").unwrap().game_path =
            Some(r"D:\Games\Arknights\Endfield.exe".to_string());
        let set = game_process_names(&settings, Some("endfield"));
        assert!(set.contains("endfield.exe"));
        assert!(set.contains("starrail.exe"));
    }
}
