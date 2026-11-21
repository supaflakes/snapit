// Hook clavier bas niveau (remplace l'assistant C# src/native/keyhook.cs) : intercepte les raccourcis de capture
// (Impr. écran, Win+Maj+S…) avant l'Outil Capture de Windows. Il n'enregistre ni ne transmet aucune autre
// frappe : seules les combinaisons demandées sont reconnues, bloquées et signalées.
//
// Il tourne dans un petit processus à part : le même exécutable, lancé avec `--keyhook`. Windows ne transmet pas
// Impr. écran au hook d'un processus dont une fenêtre est au premier plan (l'éditeur, par exemple).
// Protocole, une ligne par message :
//   entrée : "set id:mods:vk id:mods:vk ..."  remplace les combinaisons surveillées
//            mods = 1 Ctrl | 2 Alt | 4 Maj | 8 Windows ; vk = code de touche virtuelle
//   sortie : "ready" au démarrage, puis l'id de chaque combinaison déclenchée
// Le processus se ferme dès que Snapit ferme son entrée standard.
use std::collections::HashSet;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, GetAsyncKeyState, KEYEVENTF_KEYUP, KEYBD_EVENT_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::*;

// Touche virtuelle non attribuée : envoyée après une combinaison bloquée avec Win ou Alt, pour que le relâchement
// de Win n'ouvre pas le menu Démarrer (ni Alt la barre de menus).
const VK_MASK: u8 = 0xE8;

/// Combinaison surveillée : (identifiant renvoyé, modificateurs 1 Ctrl | 2 Alt | 4 Maj | 8 Win, touche virtuelle).
pub type Combo = (String, u32, u32);

static COMBOS: RwLock<Vec<Combo>> = RwLock::new(Vec::new());
static SWALLOW_UP: Mutex<Option<HashSet<u32>>> = Mutex::new(None);
static EVENTS: OnceLock<Mutex<Sender<String>>> = OnceLock::new();
static THREAD: Mutex<Option<u32>> = Mutex::new(None);

/// Remplace les combinaisons surveillées.
pub fn set(combos: Vec<Combo>) {
    *COMBOS.write().unwrap() = combos;
}

fn is_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam.0 as u32;
        let vk = (*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode;
        if message == WM_KEYUP || message == WM_SYSKEYUP {
            if SWALLOW_UP.lock().unwrap().get_or_insert_with(HashSet::new).remove(&vk) {
                return LRESULT(1);
            }
        } else if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
            let mods = (is_down(0x11) as u32) | (is_down(0x12) as u32) << 1 | (is_down(0x10) as u32) << 2 | ((is_down(0x5B) || is_down(0x5C)) as u32) << 3;
            let found = COMBOS.read().unwrap().iter().find(|(_, m, v)| *v == vk && *m == mods).map(|(id, _, _)| id.clone());
            if let Some(id) = found {
                SWALLOW_UP.lock().unwrap().get_or_insert_with(HashSet::new).insert(vk);
                if mods & (2 | 8) != 0 {
                    keybd_event(VK_MASK, 0, KEYBD_EVENT_FLAGS(0), 0);
                    keybd_event(VK_MASK, 0, KEYEVENTF_KEYUP, 0);
                }
                // traité ailleurs : le hook doit répondre tout de suite à Windows
                if let Some(events) = EVENTS.get() {
                    let _ = events.lock().unwrap().send(id);
                }
                return LRESULT(1); // la touche n'atteint ni Windows ni l'Outil Capture
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Installe le hook sur un fil dédié ; `on_combo` reçoit l'identifiant de chaque combinaison (sur un autre fil).
/// Renvoie faux si Windows refuse le hook.
pub fn start(on_combo: fn(String)) -> bool {
    let (tx, rx) = channel::<String>();
    if EVENTS.set(Mutex::new(tx)).is_err() {
        return THREAD.lock().unwrap().is_some(); // déjà démarré
    }
    std::thread::Builder::new()
        .name("snapit-touches".into())
        .spawn(move || {
            for id in rx {
                on_combo(id);
            }
        })
        .ok();
    let (ready_tx, ready_rx) = channel::<bool>();
    let started = std::thread::Builder::new().name("snapit-hook".into()).spawn(move || unsafe {
        let module = GetModuleHandleW(None).ok();
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module.map(|m| m.into()), 0);
        let Ok(hook) = hook else {
            let _ = ready_tx.send(false);
            return;
        };
        *THREAD.lock().unwrap() = Some(GetCurrentThreadId());
        let _ = ready_tx.send(true);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hook);
        *THREAD.lock().unwrap() = None;
    });
    started.is_ok() && ready_rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false)
}

/// Retire le hook (à la fermeture de Snapit).
pub fn stop() {
    if let Some(thread) = *THREAD.lock().unwrap() {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

pub const ARG: &str = "--keyhook";

/// Processus du hook (`snapit.exe --keyhook`) : renvoie le code de sortie.
pub fn run_helper() -> i32 {
    use std::io::{BufRead, Write};
    fn send(line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
    if !start(|id| send(&id)) {
        send("error");
        return 1;
    }
    send("ready");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Some(rest) = line.strip_prefix("set") else { continue };
        let combos = rest
            .split_whitespace()
            .filter_map(|item| {
                let mut p = item.split(':');
                let (Some(id), Some(mods), Some(vk), None) = (p.next(), p.next(), p.next(), p.next()) else { return None };
                Some((id.to_string(), mods.parse().ok()?, vk.parse().ok()?))
            })
            .collect();
        set(combos);
    }
    stop();
    0 // Snapit est fermé
}
