#[cfg(windows)]
mod win_impl {
    use std::path::Path;
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, BOOL, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM,
    };
    use windows::Win32::System::Threading::{
        CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
        ShowWindowAsync, SW_RESTORE,
    };

    struct SearchState {
        targets: Vec<String>,
        found: Option<HWND>,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let state = &mut *(lparam.0 as *mut SearchState);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = [0u16; 260];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            if ok.is_ok() && size > 0 {
                let exe_path = String::from_utf16_lossy(&buf[..size as usize]);
                if let Some(file_name) = Path::new(&exe_path).file_name().and_then(|s| s.to_str())
                {
                    let lower = file_name.to_ascii_lowercase();
                    if state.targets.iter().any(|t| t == &lower) {
                        state.found = Some(hwnd);
                        return BOOL(0);
                    }
                }
            }
        }
        BOOL(1)
    }

    fn focus_game_window(exe_hints: &[String]) {
        if exe_hints.is_empty() {
            return;
        }
        let mut state = SearchState {
            targets: exe_hints
                .iter()
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty())
                .collect(),
            found: None,
        };
        if state.targets.is_empty() {
            return;
        }
        unsafe {
            let _ = EnumWindows(Some(enum_cb), LPARAM(&mut state as *mut SearchState as isize));
            if let Some(hwnd) = state.found {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindowAsync(hwnd, SW_RESTORE);
                }
                let _ = SetForegroundWindow(hwnd);
                thread::sleep(Duration::from_millis(35));
            }
        }
    }

    fn is_extended_vk(vk: u16) -> bool {
        (0x21..=0x2E).contains(&vk)
            || vk == 0x5B
            || vk == 0x5C
            || vk == 0x6F
            || vk == 0xA3
            || vk == 0xA5
    }

    fn make_key_input(vk: u16, key_up: bool) -> INPUT {
        let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
        let mut flags = KEYEVENTF_SCANCODE;
        if key_up {
            flags |= KEYEVENTF_KEYUP;
        }
        if is_extended_vk(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: KEYBD_EVENT_FLAGS(flags.0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send_single(vk: u16, key_up: bool) {
        let input = [make_key_input(vk, key_up)];
        unsafe {
            let _ = SendInput(&input, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn vk_for_token(token: &str) -> Option<(u16, bool)> {
        let trimmed = token.trim();
        let no_vk = if trimmed.len() >= 3 && trimmed[..3].eq_ignore_ascii_case("vk_") {
            &trimmed[3..]
        } else {
            trimmed
        };
        let upper = no_vk.to_ascii_uppercase();
        if upper.is_empty()
            || matches!(
                upper.as_str(),
                "LBUTTON" | "RBUTTON" | "MBUTTON" | "XBUTTON1" | "XBUTTON2"
            )
        {
            return None;
        }
        if let Some(hex) = upper.strip_prefix("0X") {
            if !hex.is_empty() && hex.len() <= 2 {
                if let Ok(parsed) = u16::from_str_radix(hex, 16) {
                    if (1..=0xFF).contains(&parsed) {
                        return Some((parsed, false));
                    }
                }
            }
        }
        if upper.len() == 1 {
            let b = upper.as_bytes()[0];
            if b.is_ascii_alphanumeric() {
                return Some((b as u16, false));
            }
        }
        if let Some(rest) = upper.strip_prefix('F') {
            if let Ok(n) = rest.parse::<u16>() {
                if (1..=24).contains(&n) {
                    return Some((0x6F + n, false));
                }
            }
        }
        let punct = match no_vk {
            "/" => Some((0xBF, false)),
            "." => Some((0xBE, false)),
            "," => Some((0xBC, false)),
            ";" => Some((0xBA, false)),
            "'" => Some((0xDE, false)),
            "[" => Some((0xDB, false)),
            "]" => Some((0xDD, false)),
            "-" => Some((0xBD, false)),
            "=" => Some((0xBB, false)),
            "\\" => Some((0xDC, false)),
            "`" => Some((0xC0, false)),
            "<" => Some((0xBC, true)),
            ">" => Some((0xBE, true)),
            "?" => Some((0xBF, true)),
            ":" => Some((0xBA, true)),
            "\"" => Some((0xDE, true)),
            "{" => Some((0xDB, true)),
            "}" => Some((0xDD, true)),
            "|" => Some((0xDC, true)),
            "~" => Some((0xC0, true)),
            "_" => Some((0xBD, true)),
            "+" => Some((0xBB, true)),
            "!" => Some((0x31, true)),
            "@" => Some((0x32, true)),
            "#" => Some((0x33, true)),
            "$" => Some((0x34, true)),
            "%" => Some((0x35, true)),
            "^" => Some((0x36, true)),
            "&" => Some((0x37, true)),
            "*" => Some((0x38, true)),
            "(" => Some((0x39, true)),
            ")" => Some((0x30, true)),
            _ => None,
        };
        if punct.is_some() {
            return punct;
        }
        let named = match upper.as_str() {
            "BACK" | "BACKSPACE" => 0x08,
            "TAB" => 0x09,
            "RETURN" | "ENTER" => 0x0D,
            "SHIFT" | "LSHIFT" | "RSHIFT" => 0x10,
            "CONTROL" | "CTRL" | "LCONTROL" | "RCONTROL" | "LCTRL" | "RCTRL" => 0x11,
            "MENU" | "ALT" | "LMENU" | "RMENU" | "LALT" | "RALT" => 0x12,
            "PAUSE" => 0x13,
            "CAPITAL" | "CAPSLOCK" => 0x14,
            "ESCAPE" | "ESC" => 0x1B,
            "SPACE" | "SPACEBAR" => 0x20,
            "PRIOR" | "PAGEUP" | "PGUP" => 0x21,
            "NEXT" | "PAGEDOWN" | "PGDN" => 0x22,
            "END" => 0x23,
            "HOME" => 0x24,
            "LEFT" => 0x25,
            "UP" => 0x26,
            "RIGHT" => 0x27,
            "DOWN" => 0x28,
            "SNAPSHOT" | "PRINTSCREEN" => 0x2C,
            "INSERT" | "INS" => 0x2D,
            "DELETE" | "DEL" => 0x2E,
            "LWIN" | "WIN" => 0x5B,
            "RWIN" => 0x5C,
            "APPS" => 0x5D,
            "NUMPAD0" => 0x60,
            "NUMPAD1" => 0x61,
            "NUMPAD2" => 0x62,
            "NUMPAD3" => 0x63,
            "NUMPAD4" => 0x64,
            "NUMPAD5" => 0x65,
            "NUMPAD6" => 0x66,
            "NUMPAD7" => 0x67,
            "NUMPAD8" => 0x68,
            "NUMPAD9" => 0x69,
            "MULTIPLY" => 0x6A,
            "ADD" => 0x6B,
            "SEPARATOR" => 0x6C,
            "SUBTRACT" => 0x6D,
            "DECIMAL" => 0x6E,
            "DIVIDE" => 0x6F,
            "NUMLOCK" => 0x90,
            "SCROLL" => 0x91,
            "OEM_1" => 0xBA,
            "OEM_PLUS" | "PLUS" => 0xBB,
            "OEM_COMMA" | "COMMA" => 0xBC,
            "OEM_MINUS" | "MINUS" => 0xBD,
            "OEM_PERIOD" | "PERIOD" => 0xBE,
            "OEM_2" => 0xBF,
            "OEM_3" => 0xC0,
            "OEM_4" => 0xDB,
            "OEM_5" => 0xDC,
            "OEM_6" => 0xDD,
            "OEM_7" => 0xDE,
            "OEM_8" => 0xDF,
            "OEM_102" => 0xE2,
            _ => return None,
        };
        Some((named, false))
    }

    pub(crate) fn build_key_plan(hotkey: &str) -> Result<(Vec<u16>, Vec<u16>, Vec<u16>), String> {
        let cleaned = hotkey.split(';').next().unwrap_or("").trim();
        let mut raw_tokens = Vec::new();
        for chunk in cleaned.split_whitespace() {
            if chunk == "+" {
                raw_tokens.push("+");
            } else if chunk.contains('+') {
                for sub in chunk.split('+').filter(|s| !s.is_empty()) {
                    raw_tokens.push(sub);
                }
            } else {
                raw_tokens.push(chunk);
            }
        }
        if raw_tokens.is_empty() {
            return Err(format!("Unsupported hotkey format: {hotkey}"));
        }

        let mut modifiers = Vec::new();
        let mut released = Vec::new();
        let mut keys = Vec::new();
        let push_unique = |vec: &mut Vec<u16>, val: u16| {
            if !vec.contains(&val) {
                vec.push(val);
            }
        };

        for part in raw_tokens {
            let lower = part.to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" | "lctrl" | "rctrl" | "lcontrol" | "rcontrol" | "vk_ctrl"
                | "vk_control" => push_unique(&mut modifiers, 0x11),
                "alt" | "lalt" | "ralt" | "menu" | "lmenu" | "rmenu" | "vk_alt" | "vk_menu" => {
                    push_unique(&mut modifiers, 0x12)
                }
                "shift" | "lshift" | "rshift" | "vk_shift" => push_unique(&mut modifiers, 0x10),
                "win" | "lwin" | "rwin" => push_unique(&mut modifiers, 0x5B),
                "no_modifiers" => {
                    push_unique(&mut released, 0x10);
                    push_unique(&mut released, 0x11);
                    push_unique(&mut released, 0x12);
                }
                "no_ctrl" | "no_control" | "no_vk_ctrl" | "no_vk_control" => {
                    push_unique(&mut released, 0x11)
                }
                "no_alt" | "no_menu" | "no_vk_alt" | "no_vk_menu" => {
                    push_unique(&mut released, 0x12)
                }
                "no_shift" | "no_vk_shift" => push_unique(&mut released, 0x10),
                _ if lower.starts_with("no_") => {}
                _ => match vk_for_token(part) {
                    Some((vk, need_shift)) => {
                        if need_shift {
                            push_unique(&mut modifiers, 0x10);
                        }
                        keys.push(vk);
                    }
                    None => return Err(format!("Unsupported hotkey format: {hotkey}")),
                },
            }
        }
        released.retain(|vk| !modifiers.contains(vk));
        if keys.is_empty() {
            return Err(format!("Unsupported hotkey format: {hotkey}"));
        }
        Ok((modifiers, released, keys))
    }

    pub fn send_hotkey(hotkey: &str, exe_hints: &[String]) -> Result<(), String> {
        let (modifiers, released, keys) = build_key_plan(hotkey)?;

        focus_game_window(exe_hints);

        // Release potentially stuck modifiers (e.g. Shift/Alt held from overlay hotkey) or no_* exclusions
        for &vk in &[0x10u16, 0x11u16, 0x12u16] {
            if !modifiers.contains(&vk) {
                send_single(vk, true);
            }
        }
        for &vk in &released {
            if !matches!(vk, 0x10 | 0x11 | 0x12) && !modifiers.contains(&vk) {
                send_single(vk, true);
            }
        }
        thread::sleep(Duration::from_millis(12));

        for &m in &modifiers {
            send_single(m, false);
            thread::sleep(Duration::from_millis(15));
        }
        for &k in &keys {
            send_single(k, false);
            thread::sleep(Duration::from_millis(15));
        }

        thread::sleep(Duration::from_millis(60));

        for &k in keys.iter().rev() {
            send_single(k, true);
            thread::sleep(Duration::from_millis(15));
        }
        for &m in modifiers.iter().rev() {
            send_single(m, true);
            thread::sleep(Duration::from_millis(15));
        }

        Ok(())
    }

    static SINGLE_INSTANCE_HANDLE: std::sync::atomic::AtomicIsize =
        std::sync::atomic::AtomicIsize::new(0);

    pub fn acquire_single_instance_or_focus() -> bool {
        let name: Vec<u16> = "Local\\ModDeckTauriPOCInstance\0".encode_utf16().collect();
        unsafe {
            let handle: HANDLE =
                match CreateMutexW(None, true, windows::core::PCWSTR(name.as_ptr())) {
                    Ok(h) => h,
                    Err(_) => return true,
                };
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(handle);
                focus_game_window(&["moddeck.exe".into()]);
                return false;
            }
            SINGLE_INSTANCE_HANDLE.store(handle.0 as isize, std::sync::atomic::Ordering::Relaxed);
            true
        }
    }
}

pub fn acquire_single_instance_or_focus() -> bool {
    #[cfg(windows)]
    {
        win_impl::acquire_single_instance_or_focus()
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[allow(dead_code)]
pub fn send_f10(exe_hints: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_impl::send_hotkey("F10", exe_hints)
    }
    #[cfg(not(windows))]
    {
        let _ = exe_hints;
        Err("SendInput is only supported on Windows".into())
    }
}

pub fn send_hotkey(hotkey: &str, exe_hints: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_impl::send_hotkey(hotkey, exe_hints)
    }
    #[cfg(not(windows))]
    {
        let _ = (hotkey, exe_hints);
        Err("SendInput is only supported on Windows".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::win_impl::build_key_plan;

    #[test]
    fn parses_ini_punctuation_and_no_modifiers_hotkeys() {
        assert_eq!(build_key_plan(",").unwrap(), (vec![], vec![], vec![0xBC]));
        assert_eq!(build_key_plan(".").unwrap(), (vec![], vec![], vec![0xBE]));
        assert_eq!(build_key_plan("/").unwrap(), (vec![], vec![], vec![0xBF]));
        assert_eq!(
            build_key_plan("no_modifiers VK_F10").unwrap(),
            (vec![], vec![0x10, 0x11, 0x12], vec![0x79])
        );
        assert_eq!(
            build_key_plan("Alt+Shift+M").unwrap(),
            (vec![0x12, 0x10], vec![], vec![0x4D])
        );
        assert!(build_key_plan("VK_LBUTTON").is_err());
        assert!(build_key_plan("CTRL ALT").is_err());
    }
}
