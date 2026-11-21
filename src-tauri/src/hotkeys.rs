// Raccourcis globaux de capture (comme src/hotkeys.js).
// Les combinaisons avec Impr. écran passent par l'assistant clavier (hook bas niveau, keyhook.cs) pour garder la
// priorité sur l'Outil Capture de Windows ; les autres par le plugin global-shortcut de Tauri.
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::helpers::{build_helper, LineProcess, KEYHOOK_SOURCE};
use crate::settings::Shortcuts;

const WIN: u32 = 8;
const VK_SNAPSHOT: u32 = 0x2c;
const RECORD_PREFIX: &str = "rec";
// Win+Maj+S : raccourci de l'Outil Capture, que beaucoup de claviers envoient pour Impr. écran.
const SNIPPING: (u32, u32) = (4 | WIN, 0x53);
pub const ESCAPE: &str = "escape";

fn modifier(name: &str) -> Option<u32> {
    match name {
        "Ctrl" | "Control" | "CommandOrControl" | "CmdOrCtrl" => Some(1),
        "Alt" => Some(2),
        "Shift" => Some(4),
        "Super" | "Meta" => Some(8),
        _ => None,
    }
}

// Code de touche virtuelle Windows d'une touche d'accélérateur.
fn virtual_key(key: &str) -> Option<u32> {
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(c as u32);
        }
    }
    if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(0x6f + n);
    }
    Some(match key {
        "PrintScreen" => VK_SNAPSHOT,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "Left" => 0x25,
        "Up" => 0x26,
        "Right" => 0x27,
        "Down" => 0x28,
        "Insert" => 0x2d,
        "Delete" => 0x2e,
        "Pause" => 0x13,
        "Scrolllock" => 0x91,
        _ => return None,
    })
}

fn parse_accelerator(accelerator: &str) -> Option<(u32, String)> {
    let mut parts: Vec<&str> = accelerator.split('+').collect();
    let key = parts.pop().filter(|k| !k.is_empty())?;
    let mut mods = 0;
    for part in parts {
        mods |= modifier(part)?;
    }
    Some((mods, key.to_string()))
}

fn accelerator_from(mods: u32, key: &str) -> String {
    let mut parts: Vec<String> = [(1, "Ctrl"), (2, "Alt"), (4, "Shift"), (8, "Super")]
        .iter()
        .filter(|(bit, _)| mods & bit != 0)
        .map(|(_, n)| n.to_string())
        .collect();
    parts.push(key.into());
    parts.join("+")
}

pub struct Hotkeys {
    app: AppHandle,
    helper: Option<Arc<LineProcess>>,
    pub hook_ready: bool,
    pub hook_failed: bool,
    recording: bool,
    config: (Shortcuts, bool),
    status: BTreeMap<String, String>,
    registered: HashMap<u32, (Shortcut, String)>, // id du raccourci du plugin -> (raccourci, action)
}

impl Hotkeys {
    pub fn new(app: AppHandle) -> Self {
        Hotkeys {
            app,
            helper: None,
            hook_ready: false,
            hook_failed: false,
            recording: false,
            config: (Shortcuts::defaults(), true),
            status: BTreeMap::new(),
            registered: HashMap::new(),
        }
    }

    pub fn helper_pid(&self) -> Option<u32> {
        self.helper.as_ref().map(|h| h.pid)
    }

    /// Action d'un raccourci du plugin (ou « escape » pendant une sélection).
    pub fn action_of(&self, shortcut: &Shortcut) -> Option<String> {
        self.registered.get(&shortcut.id()).map(|(_, action)| action.clone())
    }

    fn unregister_all(&mut self) {
        let gs = self.app.global_shortcut();
        for (id, (shortcut, action)) in std::mem::take(&mut self.registered) {
            if action == ESCAPE {
                self.registered.insert(id, (shortcut, action)); // Échap reste pendant la sélection en cours
                continue;
            }
            let _ = gs.unregister(shortcut);
        }
    }

    fn register(&mut self, accelerator: &str, action: &str) -> bool {
        let Ok(shortcut) = accelerator.parse::<Shortcut>() else { return false };
        if self.app.global_shortcut().register(shortcut).is_err() {
            return false;
        }
        self.registered.insert(shortcut.id(), (shortcut, action.into()));
        true
    }

    /// Échap global, pendant la sélection de zone.
    pub fn set_escape(&mut self, active: bool) {
        let escape: Shortcut = "Escape".parse().unwrap();
        if active {
            if self.app.global_shortcut().register(escape).is_ok() {
                self.registered.insert(escape.id(), (escape, ESCAPE.into()));
            }
        } else if self.registered.remove(&escape.id()).is_some() {
            let _ = self.app.global_shortcut().unregister(escape);
        }
    }

    pub fn apply(&mut self, shortcuts: &Shortcuts, override_tool: bool) {
        self.unregister_all();
        self.config = (shortcuts.clone(), override_tool);
        if self.recording {
            return;
        }
        let mut combos = Vec::new();
        let mut status = BTreeMap::new();
        for (action, accelerator) in shortcuts.entries() {
            if accelerator.is_empty() {
                status.insert(action.into(), "none".into());
                continue;
            }
            let Some((mods, key)) = parse_accelerator(accelerator) else {
                status.insert(action.into(), "conflict".into());
                continue;
            };
            // Impr. écran et les combinaisons avec Win (réservées par Windows) passent par l'assistant
            let vk = virtual_key(&key);
            let via_hook = key == "PrintScreen" || mods & WIN != 0;
            if let (true, Some(vk), true, true) = (via_hook, vk, override_tool, self.hook_ready) {
                combos.push(format!("{action}:{mods}:{vk}"));
                status.insert(action.into(), "hook".into());
                continue;
            }
            let ok = self.register(accelerator, action);
            status.insert(action.into(), if ok { "ok" } else { "conflict" }.into());
        }
        let snipping = format!(":{}:{}", SNIPPING.0, SNIPPING.1);
        if override_tool && self.hook_ready && !combos.iter().any(|c| c.ends_with(&snipping)) {
            combos.push(format!("region{snipping}"));
        }
        if let Some(helper) = &self.helper {
            helper.write(&format!("set {}\n", combos.join(" ")));
        }
        self.status = status;
    }

    // Pendant l'enregistrement d'un raccourci, les raccourcis sont suspendus pour que la fenêtre des paramètres
    // reçoive les touches ; Impr. écran est remonté par l'assistant.
    pub fn start_recording(&mut self) {
        self.recording = true;
        self.unregister_all();
        let mut combos: Vec<String> = (0..16).map(|mods| format!("{RECORD_PREFIX}{mods}-{VK_SNAPSHOT}:{mods}:{VK_SNAPSHOT}")).collect();
        let (mods, vk) = SNIPPING;
        combos.push(format!("{RECORD_PREFIX}{mods}-{vk}:{mods}:{vk}"));
        if let Some(helper) = &self.helper {
            helper.write(&format!("set {}\n", if self.hook_ready { combos.join(" ") } else { String::new() }));
        }
    }

    pub fn stop_recording(&mut self) {
        if !self.recording {
            return;
        }
        self.recording = false;
        let (shortcuts, override_tool) = self.config.clone();
        self.apply(&shortcuts, override_tool);
    }

    /// Ligne de l'assistant : une capture à lancer, ou une touche enregistrée.
    pub fn handle_line(&self, id: &str) -> HotkeyEvent {
        if let Some(rest) = id.strip_prefix(RECORD_PREFIX) {
            let mut parts = rest.split('-').filter_map(|p| p.parse::<u32>().ok());
            let (Some(mods), Some(vk)) = (parts.next(), parts.next()) else { return HotkeyEvent::None };
            let key = if vk == VK_SNAPSHOT { "PrintScreen".to_string() } else { char::from_u32(vk).unwrap_or('?').to_string() };
            return if self.recording { HotkeyEvent::Recorded(accelerator_from(mods, &key)) } else { HotkeyEvent::None };
        }
        HotkeyEvent::Trigger(id.to_string())
    }

    pub fn status(&self) -> Value {
        json!({ "shortcuts": self.status, "hookAvailable": self.hook_ready, "hookFailed": self.hook_failed })
    }

    pub fn dispose(&mut self) {
        let _ = self.app.global_shortcut().unregister_all();
        if let Some(helper) = self.helper.take() {
            helper.stop();
        }
    }
}

pub enum HotkeyEvent {
    None,
    Trigger(String),
    Recorded(String),
}

/// Démarre l'assistant clavier en arrière-plan, puis réapplique les raccourcis. Sans lui, tout passe par le plugin.
pub fn init(hotkeys: &'static Mutex<Hotkeys>, dir: PathBuf, on_line: fn(String), on_change: fn()) {
    std::thread::spawn(move || {
        let ready = (|| -> Result<Arc<LineProcess>, String> {
            let exe = build_helper(&dir, "keyhook", KEYHOOK_SOURCE, &[])?;
            let (tx, rx) = std::sync::mpsc::channel::<bool>();
            let tx_exit = tx.clone();
            let process = LineProcess::spawn(
                &exe,
                move |line| match line.as_str() {
                    "ready" => {
                        let _ = tx.send(true);
                    }
                    "error" => {
                        let _ = tx.send(false);
                    }
                    _ => on_line(line),
                },
                move || {
                    let _ = tx_exit.send(false);
                    // l'assistant s'est arrêté (antivirus, fin de session…) : repli sur le plugin
                    let mut h = hotkeys.lock().unwrap();
                    if h.helper.take().is_some() {
                        h.hook_ready = false;
                        h.hook_failed = true;
                        let (shortcuts, override_tool) = h.config.clone();
                        h.apply(&shortcuts, override_tool);
                        drop(h);
                        on_change();
                    }
                },
            )?;
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(true) => Ok(process),
                _ => {
                    process.stop();
                    Err("assistant clavier indisponible".into())
                }
            }
        })();
        let mut h = hotkeys.lock().unwrap();
        match ready {
            Ok(process) => {
                h.helper = Some(process);
                h.hook_ready = true;
                h.hook_failed = false;
            }
            Err(_) => {
                h.hook_ready = false;
                h.hook_failed = true;
            }
        }
        let (shortcuts, override_tool) = h.config.clone();
        h.apply(&shortcuts, override_tool);
        drop(h);
        on_change();
    });
}
