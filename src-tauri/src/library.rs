// Bibliothèque des captures : même format de dossier que la version Electron (src/library.js), si bien que les
// captures existantes restent lisibles et modifiables.
//
//   <dossier>\Capture 2026-09-29 à 14.03.22.png   image annotée, telle qu'exportée
//   <dossier>\.snapit\<id>.json                   nom, dates et annotations
//   <dossier>\.snapit\<id>.png                    image d'origine, sans annotations
//   <dossier>\.snapit\<id>.jpg                    miniature de la galerie
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const DATA_DIR: &str = ".snapit";
pub const THUMB_WIDTH: u32 = 320;
pub const THUMB_HEIGHT: u32 = 200;

#[derive(Clone)]
struct Entry {
    id: String,
    folder: PathBuf,
    file: String,
    name: String,
    created: f64,
    modified: f64,
    width: f64,
    height: f64,
    unit: f64,
    rev: f64, // dernière modification enregistrée pendant la session d'édition en cours
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

// Identifiant triable : date, heure et suffixe aléatoire (20260929-140322-a1b2c3).
fn new_id() -> String {
    let random: [u8; 3] = rand::random();
    format!("{}-{:02x}{:02x}{:02x}", chrono::Local::now().format("%Y%m%d-%H%M%S"), random[0], random[1], random[2])
}

fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 22
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'-'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'-'
        && b[16..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

fn parse_entry(data: &Value, file_name: &str, folder: &Path) -> Option<Entry> {
    let id = data.get("id")?.as_str()?;
    if !valid_id(id) || file_name != format!("{id}.json") {
        return None;
    }
    let file = data.get("file")?.as_str()?;
    if Path::new(file).file_name()?.to_str()? != file || !file.to_lowercase().ends_with(".png") {
        return None;
    }
    let num = |k: &str, fallback: f64| data.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(fallback);
    let created = num("created", 0.0);
    Some(Entry {
        id: id.into(),
        folder: folder.to_path_buf(),
        file: file.into(),
        name: data.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| file.trim_end_matches(".png").into()),
        created,
        modified: num("modified", created),
        width: num("width", 0.0),
        height: num("height", 0.0),
        unit: num("unit", 1.0),
        rev: 0.0,
    })
}

// Écrit via un fichier temporaire pour ne jamais laisser de fichier à moitié écrit.
fn write_atomic(file: &Path, data: &[u8], tmp_dir: &Path) -> std::io::Result<()> {
    let tmp = tmp_dir.join(format!("~{}.tmp", file.file_name().unwrap_or_default().to_string_lossy()));
    fs::write(&tmp, data)?;
    if fs::rename(&tmp, file).is_err() {
        // fichier ouvert dans une autre application (visionneuse…) : on le réécrit directement
        let _ = fs::remove_file(&tmp);
        fs::write(file, data)?;
    }
    Ok(())
}

// Crée le dossier des données d'édition, masqué dans l'Explorateur.
fn ensure_data_dir(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    crate::win::hide_file(dir);
    Ok(())
}

/// Encodage des chemins comme `encodeURIComponent`, pour les URL du protocole asset de Tauri.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn asset_url(path: &Path) -> String {
    format!("http://asset.localhost/{}", encode_uri_component(&path.to_string_lossy()))
}

fn decode_b64(value: &Value) -> Option<Vec<u8>> {
    let text = value.as_str()?;
    let text = text.find(',').map_or(text, |i| &text[i + 1..]); // URL data: acceptée aussi
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

pub struct Library {
    entries: HashMap<String, Entry>, // pour tous les dossiers lus : une capture ouverte reste enregistrable
    scanned: HashSet<PathBuf>,
}

impl Library {
    pub fn new() -> Self {
        Library { entries: HashMap::new(), scanned: HashSet::new() }
    }

    fn scan(&mut self, folder: &Path) {
        if !self.scanned.insert(folder.to_path_buf()) {
            return;
        }
        let Ok(names) = fs::read_dir(folder.join(DATA_DIR)) else { return };
        for item in names.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            if !name.ends_with(".json") {
                continue;
            }
            let entry = fs::read_to_string(item.path())
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|data| parse_entry(&data, &name, folder));
            if let Some(entry) = entry {
                self.entries.entry(entry.id.clone()).or_insert(entry);
            }
        }
    }

    fn data_path(entry: &Entry, ext: &str) -> PathBuf {
        entry.folder.join(DATA_DIR).join(format!("{}{ext}", entry.id))
    }

    fn item(entry: &Entry) -> Value {
        let thumb = format!("{}?v={}", asset_url(&Self::data_path(entry, ".jpg")), entry.modified);
        json!({ "id": entry.id, "name": entry.name, "created": entry.created, "modified": entry.modified,
                "width": entry.width, "height": entry.height, "thumb": thumb })
    }

    /// Captures du dossier, de la plus récente à la plus ancienne.
    pub fn list(&mut self, folder: &Path) -> Vec<Value> {
        self.scan(folder);
        let mut list: Vec<&Entry> = self.entries.values().filter(|e| e.folder == folder).collect();
        list.sort_by(|a, b| b.created.total_cmp(&a.created));
        list.into_iter().map(Self::item).collect()
    }

    /// Image annotée d'une capture (celle que l'on voit dans le dossier).
    pub fn image_path(&self, id: &str) -> Option<PathBuf> {
        self.entries.get(id).map(|e| e.folder.join(&e.file))
    }

    // Nom de fichier libre : « Capture ….png », sinon « Capture … (2).png »…
    fn unique_file(&self, folder: &Path, name: &str) -> String {
        let cleaned: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '-' } else { c }).collect();
        let base = if cleaned.trim().is_empty() { "Capture".to_string() } else { cleaned.trim().to_string() };
        let taken: HashSet<String> = self.entries.values().filter(|e| e.folder == folder).map(|e| e.file.to_lowercase()).collect();
        for i in 1.. {
            let file = if i == 1 { format!("{base}.png") } else { format!("{base} ({i}).png") };
            if !taken.contains(&file.to_lowercase()) && !folder.join(&file).exists() {
                return file;
            }
        }
        unreachable!()
    }

    fn write_data(entry: &Entry, shapes: &Value) -> std::io::Result<()> {
        let data = json!({ "version": 1, "id": entry.id, "name": entry.name, "file": entry.file, "created": entry.created,
                           "modified": entry.modified, "width": entry.width, "height": entry.height, "unit": entry.unit,
                           "shapes": shapes });
        write_atomic(&Self::data_path(entry, ".json"), data.to_string().as_bytes(), &entry.folder.join(DATA_DIR))
    }

    /// Ajoute une nouvelle capture (PNG et miniature JPEG déjà encodés) ; renvoie sa description.
    pub fn create(&mut self, folder: &Path, png: &[u8], thumb: &[u8], name: &str, unit: f64, width: u32, height: u32) -> std::io::Result<Value> {
        self.scan(folder);
        let dir = folder.join(DATA_DIR);
        ensure_data_dir(&dir)?;
        let now = now_ms();
        let entry = Entry {
            id: new_id(),
            folder: folder.to_path_buf(),
            file: self.unique_file(folder, name),
            name: name.into(),
            created: now,
            modified: now,
            width: width as f64,
            height: height as f64,
            unit,
            rev: 0.0,
        };
        write_atomic(&Self::data_path(&entry, ".png"), png, &dir)?;
        write_atomic(&folder.join(&entry.file), png, &dir)?;
        write_atomic(&Self::data_path(&entry, ".jpg"), thumb, &dir)?;
        Self::write_data(&entry, &json!([]))?;
        let item = Self::item(&entry);
        self.entries.insert(entry.id.clone(), entry);
        Ok(item)
    }

    /// Enregistre les modifications faites dans l'éditeur. `rev` augmente à chaque modification : un envoi plus
    /// ancien que le dernier enregistré est ignoré. `base` (image d'origine) n'arrive qu'après un rognage.
    /// Renvoie la description mise à jour, ou None si rien n'a été enregistré.
    pub fn save(&mut self, data: &Value) -> Result<Option<Value>, String> {
        let id = data.get("id").and_then(Value::as_str).unwrap_or_default();
        let rev = data.get("rev").and_then(Value::as_f64).unwrap_or(0.0);
        let Some(entry) = self.entries.get_mut(id) else { return Ok(None) };
        if !(rev > entry.rev) {
            return Ok(None);
        }
        let image = data.get("image").and_then(decode_b64).ok_or("image manquante")?;
        let thumb = data.get("thumb").and_then(decode_b64).ok_or("miniature manquante")?;
        let dir = entry.folder.join(DATA_DIR);
        ensure_data_dir(&dir).map_err(|e| e.to_string())?;
        if let Some(base) = data.get("base").and_then(decode_b64) {
            write_atomic(&Self::data_path(entry, ".png"), &base, &dir).map_err(|e| e.to_string())?;
        }
        write_atomic(&entry.folder.join(&entry.file), &image, &dir).map_err(|e| e.to_string())?;
        write_atomic(&Self::data_path(entry, ".jpg"), &thumb, &dir).map_err(|e| e.to_string())?;
        let num = |k: &str, fallback: f64| data.get(k).and_then(Value::as_f64).unwrap_or(fallback);
        entry.rev = rev;
        entry.unit = num("unit", entry.unit);
        entry.width = num("width", entry.width);
        entry.height = num("height", entry.height);
        entry.modified = now_ms();
        let shapes = data.get("shapes").filter(|s| s.is_array()).cloned().unwrap_or_else(|| json!([]));
        Self::write_data(entry, &shapes).map_err(|e| e.to_string())?;
        Ok(Some(Self::item(entry)))
    }

    /// Données pour rouvrir une capture dans l'éditeur, annotations comprises.
    pub fn load(&mut self, id: &str) -> Result<Value, String> {
        let entry = self.entries.get_mut(id).ok_or("Capture introuvable")?;
        let mut shapes = fs::read_to_string(Self::data_path(entry, ".json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|data| data.get("shapes").filter(|s| s.is_array()).cloned())
            .unwrap_or_else(|| json!([]));
        let png = match fs::read(Self::data_path(entry, ".png")) {
            Ok(png) => png,
            Err(_) => {
                // image d'origine absente : l'image annotée devient la nouvelle image d'origine
                let png = fs::read(entry.folder.join(&entry.file)).map_err(|e| e.to_string())?;
                shapes = json!([]);
                let dir = entry.folder.join(DATA_DIR);
                if ensure_data_dir(&dir).is_ok() {
                    let _ = write_atomic(&Self::data_path(entry, ".png"), &png, &dir);
                }
                png
            }
        };
        entry.rev = 0.0; // nouvelle session d'édition : l'éditeur recompte ses modifications
        Ok(json!({
            "dataUrl": crate::capture::publish_image(png),
            "name": entry.name,
            "scaleFactor": entry.unit,
            "libraryId": id,
            "shapes": shapes,
        }))
    }

    /// L'image annotée part dans la corbeille ; les données d'édition sont effacées.
    pub fn remove(&mut self, id: &str) -> Result<bool, String> {
        let Some(entry) = self.entries.remove(id) else { return Ok(false) };
        let image = entry.folder.join(&entry.file);
        if image.exists() {
            if let Err(err) = trash::delete(&image) {
                self.entries.insert(id.into(), entry);
                return Err(err.to_string());
            }
        }
        for ext in [".json", ".png", ".jpg"] {
            let _ = fs::remove_file(Self::data_path(&entry, ext));
        }
        Ok(true)
    }
}
