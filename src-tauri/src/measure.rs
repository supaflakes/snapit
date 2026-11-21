// Mesures de performance de la version Tauri, comparables à `npm run measure` (scripts/measure.js) :
// lancer Snapit avec `--measure`. Profil et bibliothèque à part, dans %TEMP%\snapit-measure-tauri.
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::{app, capture, editors, win};

const RUNS: usize = 5;

struct Marks {
    start: Instant,
    editor_shown: Option<Duration>,
    last_library_id: Option<String>,
    library_id_at: Option<Instant>,
}

static MARKS: OnceLock<Mutex<Marks>> = OnceLock::new();

fn enabled() -> bool {
    std::env::args().any(|a| a == "--measure")
}

fn out_dir() -> PathBuf {
    std::env::temp_dir().join("snapit-measure-tauri")
}

/// Étape d'une capture, affichée pendant les mesures (millisecondes depuis la demande de capture).
pub fn trace(step: &str) {
    if !enabled() {
        return;
    }
    static CAPTURE_START: Mutex<Option<Instant>> = Mutex::new(None);
    let mut start = CAPTURE_START.lock().unwrap();
    if step == "demande" {
        *start = Some(Instant::now());
    }
    if let Some(t) = *start {
        eprintln!("  {:>6.1} ms  {step}", t.elapsed().as_secs_f64() * 1000.0);
    }
}

pub fn mark_start() {
    let _ = MARKS.set(Mutex::new(Marks { start: Instant::now(), editor_shown: None, last_library_id: None, library_id_at: None }));
}

/// Profil propre aux mesures : les paramètres et les captures de l'utilisateur restent intacts.
pub fn profile_dir() -> Option<PathBuf> {
    if !enabled() {
        return None;
    }
    let profile = out_dir().join("profil");
    let library = out_dir().join("bibliotheque");
    let _ = std::fs::remove_dir_all(&library);
    let _ = std::fs::create_dir_all(&profile);
    let _ = std::fs::write(profile.join("settings.json"), json!({ "version": 2, "libraryFolder": library }).to_string());
    Some(profile)
}

pub fn editor_shown() {
    if let Some(m) = MARKS.get() {
        let mut m = m.lock().unwrap();
        if m.editor_shown.is_none() {
            m.editor_shown = Some(m.start.elapsed());
        }
    }
}

pub fn editor_state(library_id: Option<&str>) {
    if let (Some(m), Some(id)) = (MARKS.get(), library_id) {
        let mut m = m.lock().unwrap();
        if m.last_library_id.as_deref() != Some(id) {
            m.last_library_id = Some(id.into());
            m.library_id_at = Some(Instant::now());
        }
    }
}

fn median(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    v.get(v.len() / 2).copied().unwrap_or(f64::NAN)
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0).round()
}

async fn until(timeout: Duration, test: impl Fn() -> bool) -> Option<Instant> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if test() {
            return Some(Instant::now());
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    None
}

fn overlay_visible() -> bool {
    crate::overlay::is_visible()
}

fn capturing() -> bool {
    app().capture.capturing.load(Ordering::SeqCst)
}

// Demande de capture de zone → overlay visible (le raccourci clavier arrive au même endroit).
async fn overlay_latency() -> Option<f64> {
    let start = Instant::now();
    tauri::async_runtime::spawn(async { capture::start_capture("region", false).await });
    let shown = until(Duration::from_secs(5), overlay_visible).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    capture::cancel_selection();
    until(Duration::from_secs(5), || !capturing()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    shown.map(|t| ms(t - start))
}

// Capture plein écran → image affichée dans l'éditeur (copie et bibliothèque comprises).
async fn fullscreen_latency() -> Option<f64> {
    let marks = MARKS.get()?;
    let before = marks.lock().unwrap().library_id_at;
    let start = Instant::now();
    tauri::async_runtime::spawn(async { capture::start_capture("fullscreen", false).await });
    let done = until(Duration::from_secs(8), || marks.lock().unwrap().library_id_at != before).await;
    until(Duration::from_secs(5), || !capturing()).await;
    done.map(|t| ms(t - start))
}

pub fn start() {
    if !enabled() {
        return;
    }
    tauri::async_runtime::spawn(async {
        let marks = MARKS.get().unwrap();
        until(Duration::from_secs(15), || marks.lock().unwrap().editor_shown.is_some()).await;
        let startup = marks.lock().unwrap().editor_shown.map(ms);
        // assistants prêts (compilés au premier lancement)
        until(Duration::from_secs(30), || {
            let h = app().hotkeys.lock().unwrap();
            h.hook_ready || h.hook_failed
        })
        .await;
        until(Duration::from_secs(30), || app().zones.running()).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let memory_editor = win::memory_of_process_tree();

        let cold = overlay_latency().await;
        let mut warm = Vec::new();
        for _ in 0..RUNS {
            if let Some(v) = overlay_latency().await {
                warm.push(v);
            }
        }
        let mut full = Vec::new();
        for _ in 0..RUNS {
            if let Some(v) = fullscreen_latency().await {
                full.push(v);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // mémoire au repos : fenêtres d'édition fermées, Snapit dans la zone de notification
        for label in editors::labels() {
            editors::close(&label).await;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        let memory_tray = win::memory_of_process_tree();
        // capture au raccourci sans fenêtre de Snapit à l'écran (le cas le plus courant)
        let mut no_window = Vec::new();
        for _ in 0..RUNS {
            if let Some(v) = overlay_latency().await {
                no_window.push(v);
            }
        }
        capture::destroy_overlays();
        // Direct2D et le pilote graphique rendent la mémoire des surfaces de dessin avec quelques secondes de retard
        tokio::time::sleep(Duration::from_secs(15)).await;
        let memory_tray_no_overlays = win::memory_of_process_tree();
        let private_tray = win::private_memory();
        let processes: Vec<_> = win::memory_by_process().into_iter().map(|(name, bytes)| json!({ "name": name, "mb": bytes / 1024 / 1024 })).collect();

        let results = json!({
            "startupMs": startup,
            "overlayColdMs": cold,
            "overlayWarmMs": warm,
            "overlayWarmMedianMs": median(&warm),
            "overlayNoWindowMs": no_window,
            "overlayNoWindowMedianMs": median(&no_window),
            "fullscreenMs": full,
            "fullscreenMedianMs": median(&full),
            "memoryEditorOpenMb": memory_editor / 1024 / 1024,
            "memoryTrayOnlyMb": memory_tray / 1024 / 1024,
            "memoryTrayNoOverlaysMb": memory_tray_no_overlays / 1024 / 1024,
            "privateTrayNoOverlaysMb": private_tray / 1024 / 1024,
            "processesTrayOnly": processes,
            "version": env!("CARGO_PKG_VERSION"),
            "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        });
        let _ = std::fs::create_dir_all(out_dir());
        let _ = std::fs::write(out_dir().join("mesures.json"), serde_json::to_string_pretty(&results).unwrap_or_default());
        app().handle.exit(0);
    });
}
