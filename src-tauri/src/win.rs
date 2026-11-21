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

/// Fenêtre « outil » (WS_EX_TOOLWINDOW) : Chrome, Edge et les autres applications Chromium ne se croient pas
/// cachées par l'overlay, et continuent de décrire leur page pour la détection des zones.
pub fn make_tool_window(window: &tauri::WebviewWindow) {
    if let Some(h) = hwnd(window) {
        unsafe {
            let style = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let style = (style | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            SetWindowLongPtrW(h, GWL_EXSTYLE, style);
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
    memory_by_process().iter().map(|(_, bytes)| bytes).sum()
}

/// Mémoire de travail de ce processus et de chacun de ses descendants : (nom de l'exécutable, octets).
pub fn memory_by_process() -> Vec<(String, u64)> {
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
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
        let mut tree = vec![GetCurrentProcessId()];
        let mut i = 0;
        while i < tree.len() {
            let parent = tree[i];
            for (pid, ppid, _) in &parents {
                let (pid, ppid) = (*pid, *ppid);
                if ppid == parent && pid != parent && !tree.contains(&pid) {
                    tree.push(pid);
                }
            }
            i += 1;
        }
        let mut out = Vec::new();
        for pid in tree {
            let name = parents.iter().find(|(p, _, _)| *p == pid).map(|(_, _, n)| n.clone()).unwrap_or_default();
            if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut counters = PROCESS_MEMORY_COUNTERS::default();
                if GetProcessMemoryInfo(process, &mut counters, std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32).is_ok() {
                    out.push((name, counters.WorkingSetSize as u64));
                }
                let _ = windows::Win32::Foundation::CloseHandle(process);
            }
        }
        out
    }
}

/// JPEG par l'encodeur de Windows (WIC), depuis des pixels BGRA.
pub fn encode_jpeg_wic(bgra: &[u8], width: u32, height: u32, quality: f32) -> Result<Vec<u8>, String> {
    use windows::core::{GUID, PCWSTR};
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Shell::SHCreateMemStream;
    let err = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let stream = SHCreateMemStream(None).ok_or("flux")?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null()).map_err(err)?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache).map_err(err)?;
        let mut frame = None;
        let mut props: Option<IPropertyBag2> = None;
        encoder.CreateNewFrame(&mut frame, &mut props).map_err(err)?;
        let frame = frame.ok_or("image")?;
        if let Some(props) = &props {
            let name: Vec<u16> = "ImageQuality ".encode_utf16().collect();
            let bag = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_ptr() as *mut u16), ..Default::default() };
            let value = VARIANT::from(quality);
            let _ = props.Write(1, &bag, &value);
        }
        frame.Initialize(props.as_ref()).map_err(err)?;
        frame.SetSize(width, height).map_err(err)?;
        // le JPEG n'a pas de canal alpha : WIC convertit l'image BGRA à la volée (WriteSource)
        let mut format: GUID = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format).map_err(err)?;
        let source = factory.CreateBitmapFromMemory(width, height, &GUID_WICPixelFormat32bppBGR, width * 4, bgra).map_err(err)?;
        frame.WriteSource(&source, std::ptr::null()).map_err(err)?;
        frame.Commit().map_err(err)?;
        encoder.Commit().map_err(err)?;
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).map_err(err)?;
        let size = stat.cbSize as usize;
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(err)?;
        let mut out = vec![0u8; size];
        let mut read = 0u32;
        stream.Read(out.as_mut_ptr() as _, size as u32, Some(&mut read)).ok().map_err(err)?;
        out.truncate(read as usize);
        let _ = PCWSTR::null();
        Ok(out)
    }
}

/// Demande à WebView2 de réduire la mémoire d'une page cachée (overlay en réserve), ou de revenir à la normale.
pub fn set_low_memory(window: &tauri::WebviewWindow, low: bool) {
    let _ = window.with_webview(move |webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core_webview::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}
