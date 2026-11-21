// Paramètres de l'application : même fichier et même format que la version Electron (src/settings.js),
// %APPDATA%\snapit\settings.json.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Shortcuts {
    pub region: String,
    pub fullscreen: String,
    pub delay: String,
}

impl Shortcuts {
    pub fn defaults() -> Self {
        Shortcuts { region: "PrintScreen".into(), fullscreen: "Shift+PrintScreen".into(), delay: "Ctrl+PrintScreen".into() }
    }

    pub fn entries(&self) -> [(&'static str, &str); 3] {
        [("region", &self.region), ("fullscreen", &self.fullscreen), ("delay", &self.delay)]
    }

    pub fn get(&self, action: &str) -> &str {
        match action {
            "region" => &self.region,
            "fullscreen" => &self.fullscreen,
            _ => &self.delay,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub language: String,
    pub theme: String,
    pub shortcuts: Shortcuts,
    pub override_snipping_tool: bool,
    pub capture_delay: u32,
    pub detect_regions: bool,
    pub copy_after_capture: bool,
    pub auto_save: bool,
    pub library_folder: String,
    pub show_gallery: bool,
    pub save_folder: String,
    pub save_format: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: 2,
            language: "auto".into(),
            theme: "dark".into(),
            shortcuts: Shortcuts::defaults(),
            override_snipping_tool: true,
            capture_delay: 3,
            detect_regions: true,
            copy_after_capture: true,
            auto_save: true,
            library_folder: String::new(),
            show_gallery: true,
            save_folder: String::new(),
            save_format: "png".into(),
        }
    }
}

/// Valeurs reconnues seulement ; tout le reste reprend sa valeur par défaut (comme `sanitize` de settings.js).
pub fn sanitize(input: &Value) -> Settings {
    let mut s = Settings::default();
    let Some(o) = input.as_object() else { return s };
    let text = |k: &str| o.get(k).and_then(Value::as_str);
    let flag = |k: &str| o.get(k).and_then(Value::as_bool);
    if let Some(v) = text("language").filter(|v| ["auto", "fr", "en"].contains(v)) {
        s.language = v.into();
    }
    if let Some(v) = text("theme").filter(|v| ["system", "dark", "light"].contains(v)) {
        s.theme = v.into();
    }
    if let Some(sc) = o.get("shortcuts").and_then(Value::as_object) {
        for (key, slot) in [("region", &mut s.shortcuts.region), ("fullscreen", &mut s.shortcuts.fullscreen), ("delay", &mut s.shortcuts.delay)] {
            if let Some(v) = sc.get(key).and_then(Value::as_str) {
                *slot = v.into();
            }
        }
    }
    if let Some(v) = flag("overrideSnippingTool") {
        s.override_snipping_tool = v;
    }
    if let Some(v) = o.get("captureDelay").and_then(Value::as_f64).filter(|v| v.is_finite()) {
        s.capture_delay = v.round().clamp(1.0, 60.0) as u32;
    }
    if let Some(v) = flag("detectRegions") {
        s.detect_regions = v;
    }
    // Avant la version 2, la copie automatique était désactivée par défaut : le nouveau défaut s'applique une fois.
    let version = o.get("version").and_then(Value::as_f64).unwrap_or(0.0);
    if let (Some(v), true) = (flag("copyAfterCapture"), version >= 2.0) {
        s.copy_after_capture = v;
    }
    if let Some(v) = flag("autoSave") {
        s.auto_save = v;
    }
    if let Some(v) = text("libraryFolder") {
        s.library_folder = v.into();
    }
    if let Some(v) = flag("showGallery") {
        s.show_gallery = v;
    }
    if let Some(v) = text("saveFolder") {
        s.save_folder = v.into();
    }
    if let Some(v) = text("saveFormat").filter(|v| ["png", "jpeg"].contains(v)) {
        s.save_format = v.into();
    }
    s
}

pub struct SettingsStore {
    file: PathBuf,
    values: Mutex<Settings>,
}

impl SettingsStore {
    pub fn new(file: PathBuf) -> Self {
        let values = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|v| sanitize(&v))
            .unwrap_or_default();
        SettingsStore { file, values: Mutex::new(values) }
    }

    pub fn get(&self) -> Settings {
        self.values.lock().unwrap().clone()
    }

    /// Applique une modification partielle ; renvoie (nouveaux, anciens).
    pub fn set(&self, patch: &Value) -> (Settings, Settings) {
        let mut values = self.values.lock().unwrap();
        let previous = values.clone();
        let mut merged = serde_json::to_value(&*values).unwrap_or_else(|_| json!({}));
        if let (Some(target), Some(patch)) = (merged.as_object_mut(), patch.as_object()) {
            for (key, value) in patch {
                if key == "shortcuts" {
                    if let (Some(sc), Some(p)) = (target.get_mut("shortcuts").and_then(Value::as_object_mut), value.as_object()) {
                        for (k, v) in p {
                            sc.insert(k.clone(), v.clone());
                        }
                    }
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        let next = sanitize(&merged);
        *values = next.clone();
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // l'enregistrement peut échouer : les réglages restent valables pour la session
        let _ = std::fs::write(&self.file, serde_json::to_string_pretty(&next).unwrap_or_default());
        (next, previous)
    }
}
