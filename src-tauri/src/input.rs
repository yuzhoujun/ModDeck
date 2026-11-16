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

    fn parse_token_to_vk(token: &str) -> Option<u16> {
        let upper = token.trim().to_ascii_uppercase();
        if upper.is_empty() {
            return None;
        }
        match upper.as_str() {
            "ALT" | "MENU" | "LALT" => Some(0x12),
            "CTRL" | "CONTROL" | "LCTRL" => Some(0x11),
            "SHIFT" | "LSHIFT" => Some(0x10),
            "TAB" => Some(0x09),
            "ENTER" | "RETURN" => Some(0x0D),
            "ESC" | "ESCAPE" => Some(0x1B),
            "SPACE" => Some(0x20),
            "UP" => Some(0x26),
            "DOWN" => Some(0x28),
            "LEFT" => Some(0x25),
            "RIGHT" => Some(0x27),
            "BACKSPACE" | "BACK" => Some(0x08),
            "DELETE" | "DEL" => Some(0x2E),
            "INSERT" | "INS" => Some(0x2D),
            "HOME" => Some(0x24),
            "END" => Some(0x23),
            "PGUP" | "PAGEUP" => Some(0x21),
            "PGDN" | "PAGEDOWN" => Some(0x22),
            _ => {
                if let Some(rest) = upper.strip_prefix('F') {
                    if let Ok(n) = rest.parse::<u16>() {
                        if (1..=12).contains(&n) {
                            return Some(0x6F + n);
                        }
                    }
                }
                if upper.len() == 1 {
                    let b = upper.as_bytes()[0];
                    if b.is_ascii_alphanumeric() {
                        return Some(b as u16);
                    }
                }
                None
            }
        }
    }

    pub fn send_hotkey(hotkey: &str, exe_hints: &[String]) -> Result<(), String> {
        let mut modifiers = Vec::new();
        let mut keys = Vec::new();
        for part in hotkey.split(&['+', ' '][..]) {
            if let Some(vk) = parse_token_to_vk(part) {
                if matches!(vk, 0x10 | 0x11 | 0x12) {
                    modifiers.push(vk);
                } else {
                    keys.push(vk);
                }
            }
        }
        if keys.is_empty() {
            return Err(format!("Unsupported hotkey format: {hotkey}"));
        }

        focus_game_window(exe_hints);

        // Release potentially stuck modifiers (e.g. Shift/Alt held from overlay hotkey)
        for &vk in &[0x10u16, 0x11u16, 0x12u16] {
            if !modifiers.contains(&vk) {
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
