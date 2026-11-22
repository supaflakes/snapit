// Appels Windows dont Tauri ne fournit pas l'équivalent.
use std::os::windows::process::CommandExt;
use std::path::Path;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// HWND d'une fenêtre Tauri (converti depuis la version du crate `windows` utilisée par Tauri).
pub fn hwnd(window: &tauri::WebviewWindow) -> Option<HWND> {
    window.hwnd().ok().map(|h| HWND(h.0 as _))
}

pub fn hwnd_value(window: &tauri::WebviewWindow) -> Option<i64> {
    hwnd(window).map(|h| h.0 as i64)
}

/// Retire la fenêtre des captures d'écran (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004 et suivants) ou l'y remet.
pub fn set_excluded_from_capture(window: &tauri::WebviewWindow, excluded: bool) {
    if let Some(h) = hwnd(window) {
        let affinity = if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        unsafe {
            let _ = SetWindowDisplayAffinity(h, affinity);
        }
    }
}

/// Affiche la fenêtre sans l'activer.
pub fn show_inactive(window: &tauri::WebviewWindow) {
    if let Some(h) = hwnd(window) {
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
    }
}

/// Windows 10 2004 (build 19041) et suivants savent retirer une fenêtre des captures.
pub fn can_exclude_from_capture() -> bool {
    windows_build() >= 19041
}

fn windows_build() -> u32 {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "/v", "CurrentBuildNumber"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    out.ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().last().and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

/// Thème clair de Windows pour les applications ?
pub fn system_uses_light_theme() -> bool {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "AppsUseLightTheme"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    out.ok().is_some_and(|o| String::from_utf8_lossy(&o.stdout).contains("0x1"))
}

/// Masque un fichier ou un dossier dans l'Explorateur.
pub fn hide_file(path: &Path) {
    let _ = std::process::Command::new("attrib").arg("+h").arg(path).creation_flags(CREATE_NO_WINDOW).spawn();
}

/// Capture de la zone [x, y, l, h] de l'écran (pixels physiques) : pixels BGRA opaques, ligne par ligne.
/// Les fenêtres retirées des captures (WDA_EXCLUDEFROMCAPTURE) n'y figurent pas.
pub fn grab_screen(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 {
        return Err("zone vide".into());
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC".into());
        }
        // copie directe dans une image en mémoire (DIB), sans passer par une image du pilote graphique
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // lignes de haut en bas
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let Ok(bitmap) = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
            ReleaseDC(None, screen);
            return Err("CreateDIBSection".into());
        };
        let memory = CreateCompatibleDC(Some(screen));
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY);
        let _ = GdiFlush();
        let size = (w as usize) * (h as usize) * 4;
        let pixels = if copied.is_ok() && !bits.is_null() { Some(std::slice::from_raw_parts(bits as *const u8, size).to_vec()) } else { None };
        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        let mut pixels = pixels.ok_or("capture impossible")?;
        for alpha in pixels.iter_mut().skip(3).step_by(4) {
            *alpha = 255;
        }
        Ok(pixels)
    }
}

/// Mémoire de travail (octets) de ce processus et de ses descendants (WebView2, assistants).
pub fn memory_of_process_tree() -> u64 {
    memory_by_process().iter().map(|(_, bytes, _)| bytes).sum()
}

/// Mémoire de ce processus et de chacun de ses descendants : (nom de l'exécutable, mémoire de travail, mémoire
/// privée), en octets.
pub fn memory_by_process() -> Vec<(String, u64, u64)> {
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return Vec::new() };
        let mut parents = Vec::new();
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        // heure de création : le numéro d'un parent disparu peut avoir été réattribué à un autre processus
        let created = |pid: u32| -> u64 {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return u64::MAX };
            let (mut c, mut e, mut k, mut u) = Default::default();
            let ok = windows::Win32::System::Threading::GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u).is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(process);
            if ok { ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64 } else { u64::MAX }
        };
        let mut tree = vec![GetCurrentProcessId()];
        let mut i = 0;
        while i < tree.len() {
            let parent = tree[i];
            let parent_created = created(parent);
            for (pid, ppid, _) in &parents {
                let (pid, ppid) = (*pid, *ppid);
                if ppid == parent && pid != parent && !tree.contains(&pid) && created(pid) >= parent_created {
                    tree.push(pid);
                }
            }
            i += 1;
        }
        let mut out = Vec::new();
        for pid in tree {
            let name = parents.iter().find(|(p, _, _)| *p == pid).map(|(_, _, n)| n.clone()).unwrap_or_default();
            if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
                let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
                if GetProcessMemoryInfo(process, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, size).is_ok() {
                    out.push((name, c.WorkingSetSize as u64, c.PrivateUsage as u64));
                }
                let _ = windows::Win32::Foundation::CloseHandle(process);
            }
        }
        out
    }
}

/// Mémoire privée réservée par ce processus (octets), qu'elle soit en mémoire vive ou non.
pub fn private_memory() -> u64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
    unsafe {
        let _ = GetProcessMemoryInfo(GetCurrentProcess(), &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32);
    }
    c.PrivateUsage as u64
}
