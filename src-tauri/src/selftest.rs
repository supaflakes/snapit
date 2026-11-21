// Autotest de bout en bout de la version Tauri (l'équivalent de `npm run smoke` pour la version Electron) :
// lancer Snapit avec `--selftest`. Profil et bibliothèque à part, dans %TEMP%\snapit-selftest ; des captures
// d'écran de contrôle y sont enregistrées.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::{app, capture, editors, images, win};

static REPORT: Mutex<Vec<String>> = Mutex::new(Vec::new());
static FAILURES: Mutex<u32> = Mutex::new(0);

pub fn enabled() -> bool {
    std::env::args().any(|a| a == "--selftest")
}

pub fn out_dir() -> PathBuf {
    std::env::temp_dir().join("snapit-selftest")
}

fn library_dir() -> PathBuf {
    out_dir().join("bibliotheque")
}

/// Profil propre à l'autotest.
pub fn profile_dir() -> Option<PathBuf> {
    if !enabled() {
        return None;
    }
    let profile = out_dir().join("profil");
    let _ = std::fs::remove_dir_all(library_dir());
    let _ = std::fs::create_dir_all(&profile);
    let _ = std::fs::write(profile.join("settings.json"), json!({ "version": 2, "libraryFolder": library_dir() }).to_string());
    Some(profile)
}

fn check(label: &str, ok: bool, detail: impl AsRef<str>) {
    let line = format!("{} {label}{}", if ok { "OK  " } else { "FAIL" }, if detail.as_ref().is_empty() { String::new() } else { format!(" — {}", detail.as_ref()) });
    eprintln!("{line}");
    REPORT.lock().unwrap().push(line);
    if !ok {
        *FAILURES.lock().unwrap() += 1;
    }
}

async fn until(timeout: Duration, test: impl Fn() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if test() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

fn screenshot(name: &str) {
    let Ok(Some(m)) = app().handle.primary_monitor() else { return };
    let (p, s) = (m.position(), m.size());
    if let Ok(bgra) = win::grab_screen(p.x, p.y, s.width as i32, s.height as i32) {
        let mut rgba = bgra;
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        if let Some(img) = image::RgbaImage::from_raw(s.width, s.height, rgba) {
            let _ = std::fs::write(out_dir().join(name), images::encode_png(&img));
        }
    }
}

fn visible_overlay() -> Option<tauri::WebviewWindow> {
    app().handle.webview_windows().into_iter().find(|(l, w)| l.starts_with("overlay-") && w.is_visible().unwrap_or(false)).map(|(_, w)| w)
}

fn capturing() -> bool {
    app().capture.capturing.load(Ordering::SeqCst)
}

// Données d'édition (.json) de la capture la plus récente de la bibliothèque
fn latest_data() -> Option<Value> {
    let dir = library_dir().join(".snapit");
    let mut files: Vec<_> = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
    files.sort();
    serde_json::from_str(&std::fs::read_to_string(files.last()?).ok()?).ok()
}

fn editor_with_image() -> Option<(String, Option<String>)> {
    let list = app().editors.list.lock().unwrap();
    list.iter().find(|(_, e)| e.has_image).map(|(l, e)| (l.clone(), e.library_id.clone()))
}

const ADD_RECT: &str = "(() => { const before = snapshot(); state.shapes.push(Shapes.create('rect', { x: 10, y: 10 }, { ...state.styles.rect })); Object.assign(state.shapes.at(-1), { w: 40, h: 30 }); commit(before); })()";

pub fn start() {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async {
        let _ = std::fs::create_dir_all(out_dir());
        let shown = until(Duration::from_secs(15), || app().handle.webview_windows().iter().any(|(l, w)| l.starts_with("editor-") && w.is_visible().unwrap_or(false))).await;
        check("l'éditeur s'ouvre au démarrage", shown, "");
        until(Duration::from_secs(30), || app().regions.running()).await;
        let hook = until(Duration::from_secs(30), || {
            let h = app().hotkeys.lock().unwrap();
            h.hook_ready || h.hook_failed
        })
        .await;
        check("assistant clavier démarré", hook && app().hotkeys.lock().unwrap().hook_ready, app().hotkeys.lock().unwrap().status().to_string());
        check("assistant de détection des zones démarré", app().regions.running(), "");
        tokio::time::sleep(Duration::from_millis(800)).await;
        screenshot("0-editeur.png");

        // Aperçu JPEG de l'overlay : même taille et mêmes couleurs que la capture
        if let Ok(Some(m)) = app().handle.primary_monitor() {
            let (p, s) = (m.position(), m.size());
            let bgra = win::grab_screen(p.x, p.y, s.width as i32, s.height as i32).unwrap_or_default();
            let jpeg = win::encode_jpeg_wic(&bgra, s.width, s.height, 0.92).unwrap_or_default();
            let decoded = image::load_from_memory(&jpeg).map(|i| i.to_rgb8());
            let (same_size, diff) = match &decoded {
                Ok(img) => {
                    let mut total = 0u64;
                    let mut n = 0u64;
                    for y in (0..s.height).step_by(37) {
                        for x in (0..s.width).step_by(41) {
                            let o = ((y * s.width + x) * 4) as usize;
                            let px = img.get_pixel(x, y);
                            for (a, b) in [(px[0], bgra[o + 2]), (px[1], bgra[o + 1]), (px[2], bgra[o])] {
                                total += (a as i32 - b as i32).unsigned_abs() as u64;
                                n += 1;
                            }
                        }
                    }
                    (img.width() == s.width && img.height() == s.height, total as f64 / n.max(1) as f64)
                }
                Err(_) => (false, f64::MAX),
            };
            check("aperçu de l'overlay fidèle à la capture", same_size && diff < 6.0, format!("écart moyen {diff:.1} par canal, {} Ko", jpeg.len() / 1024));
        }

        // 1. Zone : sélection simulée dans l'overlay
        tauri::async_runtime::spawn(async { capture::start_capture("region", false).await });
        let overlay = until(Duration::from_secs(5), || visible_overlay().is_some()).await;
        check("l'overlay de sélection s'affiche", overlay, "");
        tokio::time::sleep(Duration::from_millis(600)).await;
        screenshot("1-overlay.png");
        if let Some(w) = visible_overlay() {
            let size = w.inner_size().unwrap_or_default();
            let m = w.current_monitor().ok().flatten().map(|m| *m.size()).unwrap_or_default();
            check("l'overlay couvre l'écran", size == m, format!("{}×{} pour un écran de {}×{}", size.width, size.height, m.width, m.height));
            capture::select(w.label(), &json!({ "x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3 }));
        }
        until(Duration::from_secs(5), || !capturing()).await;
        let opened = until(Duration::from_secs(5), || editor_with_image().is_some_and(|(_, id)| id.is_some())).await;
        check("la zone s'ouvre dans l'éditeur, enregistrée dans la bibliothèque", opened, "");
        let data = latest_data();
        let (w, h) = (data.as_ref().and_then(|d| d["width"].as_f64()).unwrap_or(0.0), data.as_ref().and_then(|d| d["height"].as_f64()).unwrap_or(0.0));
        let m = app().handle.primary_monitor().ok().flatten().map(|m| *m.size()).unwrap_or_default();
        check("taille de la zone capturée", (w - (m.width as f64 * 0.3).round()).abs() <= 1.0 && (h - (m.height as f64 * 0.3).round()).abs() <= 1.0, format!("{w}×{h}"));
        tokio::time::sleep(Duration::from_millis(800)).await;
        screenshot("2-zone-dans-editeur.png");

        // 2. Annotation enregistrée automatiquement, puis fermeture juste après une modification
        if let Some((label, _)) = editor_with_image() {
            let window = app().handle.get_webview_window(&label).unwrap();
            let _ = window.eval(ADD_RECT);
            let saved = until(Duration::from_secs(5), || latest_data().is_some_and(|d| d["shapes"].as_array().is_some_and(|s| s.len() == 1))).await;
            check("annotation enregistrée automatiquement", saved, "");
            let _ = window.eval(ADD_RECT);
            tokio::time::sleep(Duration::from_millis(50)).await;
            let closed = editors::close(&label).await;
            let shapes = latest_data().and_then(|d| d["shapes"].as_array().map(Vec::len)).unwrap_or(0);
            check("fermer la fenêtre enregistre la dernière modification", closed && shapes == 2, format!("{shapes} annotation(s)"));
        }

        // 3. Paramètres : fenêtre, changement de langue appliqué à toutes les fenêtres
        editors::open_settings();
        let settings = until(Duration::from_secs(5), || app().handle.get_webview_window("settings").is_some_and(|w| w.is_visible().unwrap_or(false))).await;
        check("la fenêtre Paramètres s'ouvre", settings, "");
        tokio::time::sleep(Duration::from_millis(800)).await;
        screenshot("3-parametres.png");
        let (next, previous) = app().settings.set(&json!({ "language": "en" }));
        crate::on_settings_changed(&next, &previous);
        check("changer de langue", crate::lang() == "en", crate::lang());
        tokio::time::sleep(Duration::from_millis(600)).await;
        screenshot("4-parametres-en.png");
        let (next, previous) = app().settings.set(&json!({ "language": "fr" }));
        crate::on_settings_changed(&next, &previous);
        if let Some(w) = app().handle.get_webview_window("settings") {
            let _ = w.destroy();
        }

        // 4. Plein écran : nouvel éditeur, copie dans le presse-papiers, galerie
        let before = app().library.lock().unwrap().list(&crate::library_folder()).len();
        capture::start_capture("fullscreen", false).await;
        let opened = until(Duration::from_secs(5), || editor_with_image().is_some()).await;
        check("capture plein écran ouverte dans l'éditeur", opened, "");
        let clip = images::read_clipboard();
        check("capture copiée dans le presse-papiers", clip.as_ref().is_some_and(|c| c.width() == m.width && c.height() == m.height), clip.map(|c| format!("{}×{}", c.width(), c.height())).unwrap_or_default());
        let after = app().library.lock().unwrap().list(&crate::library_folder()).len();
        check("la galerie contient les deux captures", after == before + 1 && after == 2, format!("{after} capture(s)"));
        tokio::time::sleep(Duration::from_millis(1500)).await;
        screenshot("5-plein-ecran-dans-editeur.png");

        let failures = *FAILURES.lock().unwrap();
        let mut report = REPORT.lock().unwrap().join("\n");
        report.push_str(&format!("\n{} échec(s)\n", failures));
        let _ = std::fs::write(out_dir().join("rapport.txt"), &report);
        eprintln!("{} échec(s) — {}", failures, out_dir().display());
        for label in editors::labels() {
            editors::close(&label).await;
        }
        app().handle.exit(if failures == 0 { 0 } else { 1 });
    });
}
