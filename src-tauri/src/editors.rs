// Fenêtres de l'éditeur et des paramètres (comme la partie « Éditeur » de src/main.js).
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

use crate::{app, t, BRIDGE};

// Délai laissé à l'éditeur pour enregistrer avant de fermer (une capture défilante très haute est longue à encoder).
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Editor {
    pub has_image: bool,
    pub library_id: Option<String>,
    focused_at: u64,
    loaded: bool,        // la page a demandé son image : elle sait répondre à une demande de fermeture
    close_allowed: bool, // fermeture confirmée
    closing: bool,
}

#[derive(Default)]
pub struct EditorsState {
    pub list: std::sync::Mutex<HashMap<String, Editor>>,
    pending: std::sync::Mutex<HashMap<String, Value>>, // image à charger au démarrage de l'éditeur
    close_requests: std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>,
    focus_clock: std::sync::atomic::AtomicU64,
    seq: std::sync::atomic::AtomicU64,
}

fn tick() -> u64 {
    app().editors.focus_clock.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn theme() -> Option<tauri::Theme> {
    match app().settings.get().theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    }
}

pub fn background() -> tauri::webview::Color {
    let light = match theme() {
        Some(tauri::Theme::Light) => true,
        Some(_) => false,
        None => crate::win::system_uses_light_theme(),
    };
    if light { tauri::webview::Color(0xf4, 0xf4, 0xf7, 255) } else { tauri::webview::Color(0x14, 0x14, 0x18, 255) }
}

/// Position et taille (logiques) d'une nouvelle fenêtre, centrée sur l'écran de la souris.
fn geometry(max_w: f64, max_h: f64, ratio: f64) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let handle = &app().handle;
    let cursor = handle.cursor_position().unwrap_or_default();
    let monitor = handle.monitor_from_point(cursor.x, cursor.y).ok().flatten().or_else(|| handle.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return (LogicalPosition::new(100.0, 100.0), LogicalSize::new(max_w, max_h)) };
    let scale = m.scale_factor();
    let area = m.work_area();
    let (ax, ay) = (area.position.x as f64 / scale, area.position.y as f64 / scale);
    let (aw, ah) = (area.size.width as f64 / scale, area.size.height as f64 / scale);
    let (w, h) = (max_w.min((aw * ratio).round()), max_h.min((ah * ratio).round()));
    (LogicalPosition::new((ax + (aw - w) / 2.0).round(), (ay + (ah - h) / 2.0).round()), LogicalSize::new(w, h))
}

fn builder<'a>(label: &'a str, url: &str, title: &str, size: (f64, f64), min: (f64, f64)) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    let (position, inner) = geometry(size.0, size.1, 0.85);
    WebviewWindowBuilder::new(&app().handle, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(inner.width, inner.height)
        .position(position.x, position.y)
        .min_inner_size(min.0, min.1)
        .visible(false)
        .theme(theme())
        .background_color(background())
        .disable_drag_drop_handler() // glisser-déposer d'images géré par la page (API HTML5)
        .initialization_script(BRIDGE)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && !window.is_visible().unwrap_or(true) {
                let _ = window.show();
                let _ = window.set_focus();
                crate::measure::editor_shown();
            }
        })
}

pub fn create(payload: Option<Value>) -> Option<WebviewWindow> {
    let state = &app().editors;
    let label = format!("editor-{}", state.seq.fetch_add(1, Ordering::SeqCst));
    let has_image = payload.is_some();
    let library_id = payload.as_ref().and_then(|p| p.get("libraryId")).and_then(Value::as_str).map(String::from);
    state.list.lock().unwrap().insert(label.clone(), Editor { has_image, library_id, focused_at: tick(), ..Default::default() });
    if let Some(payload) = payload {
        state.pending.lock().unwrap().insert(label.clone(), payload);
    }
    let window = match builder(&label, "editor/index.html", "Snapit", (1480.0, 940.0), (820.0, 520.0)).build() {
        Ok(w) => w,
        Err(_) => {
            state.list.lock().unwrap().remove(&label);
            state.pending.lock().unwrap().remove(&label);
            return None;
        }
    };
    let target = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            if let Some(e) = app().editors.list.lock().unwrap().get_mut(target.label()) {
                e.focused_at = tick();
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            let label = target.label().to_string();
            let mut list = app().editors.list.lock().unwrap();
            let Some(entry) = list.get_mut(&label) else { return };
            if entry.close_allowed {
                return;
            }
            api.prevent_close();
            if !entry.closing {
                entry.closing = true;
                drop(list);
                tauri::async_runtime::spawn(async move {
                    if !close(&label).await {
                        app().quitting.store(false, Ordering::SeqCst); // « Annuler » interrompt aussi la fermeture de Snapit
                    }
                });
            }
        }
        WindowEvent::Destroyed => {
            let state = &app().editors;
            let empty = {
                let mut list = state.list.lock().unwrap();
                list.remove(target.label());
                list.is_empty()
            };
            state.pending.lock().unwrap().remove(target.label());
            if empty && !app().quitting.load(Ordering::SeqCst) && !app().balloon_shown.swap(true, Ordering::SeqCst) {
                let key = crate::shortcut_label("region");
                let key = if key.is_empty() { t("balloon.noKey", &[]) } else { key };
                crate::notify(&t("balloon.title", &[]), &t("balloon.body", &[("key", &key)]));
            }
        }
        _ => {}
    });
    Some(window)
}

/// Fermeture en deux temps : l'éditeur enregistre d'abord ce qui reste, puis répond s'il garde des modifications
/// non enregistrées (la fermeture est alors confirmée par l'utilisateur). Renvoie vrai si la fenêtre est fermée.
pub async fn close(label: &str) -> bool {
    let Some(window) = app().handle.get_webview_window(label) else { return true };
    let loaded = app().editors.list.lock().unwrap().get(label).is_some_and(|e| e.loaded);
    let mut unsaved = false;
    if loaded {
        let (tx, rx) = oneshot::channel();
        app().editors.close_requests.lock().unwrap().insert(label.into(), tx);
        let _ = window.emit_to(label, "editor:close-request", ());
        unsaved = tokio::time::timeout(CLOSE_TIMEOUT, rx).await.ok().and_then(Result::ok).unwrap_or(false);
        app().editors.close_requests.lock().unwrap().remove(label);
    }
    if unsaved && !crate::confirm_close_unsaved(&window).await {
        if let Some(e) = app().editors.list.lock().unwrap().get_mut(label) {
            e.closing = false;
        }
        return false;
    }
    if let Some(e) = app().editors.list.lock().unwrap().get_mut(label) {
        e.close_allowed = true;
    }
    let _ = window.destroy();
    true
}

pub fn close_ready(label: &str, unsaved: bool) {
    if let Some(tx) = app().editors.close_requests.lock().unwrap().remove(label) {
        let _ = tx.send(unsaved);
    }
}

/// Image en attente pour l'éditeur qui démarre ; marque aussi la page comme prête.
pub fn initial(label: &str) -> Value {
    if let Some(e) = app().editors.list.lock().unwrap().get_mut(label) {
        e.loaded = true;
    }
    app().editors.pending.lock().unwrap().remove(label).unwrap_or(Value::Null)
}

pub fn set_state(label: &str, has_image: bool, library_id: Option<String>) {
    if let Some(e) = app().editors.list.lock().unwrap().get_mut(label) {
        e.has_image = has_image;
        e.library_id = library_id;
    }
}

pub fn labels() -> Vec<String> {
    app().editors.list.lock().unwrap().keys().cloned().collect()
}

pub fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn show() {
    let latest = {
        let list = app().editors.list.lock().unwrap();
        list.iter().max_by_key(|(_, e)| e.focused_at).map(|(l, _)| l.clone())
    };
    match latest.and_then(|l| app().handle.get_webview_window(&l)) {
        Some(w) => focus(&w),
        None => {
            create(None);
        }
    }
}

/// Affiche une image dans l'éditeur. Si une fenêtre montre déjà cette capture, elle est mise en avant. Sinon
/// l'image remplace le contenu de `preferred`, d'une fenêtre vide ou — galerie affichée — d'une fenêtre dont la
/// capture est enregistrée automatiquement (on la retrouve dans la galerie). Sinon, nouvelle fenêtre.
pub fn open_image(payload: Value, preferred: Option<&str>) {
    let library_id = payload.get("libraryId").and_then(Value::as_str).map(String::from);
    let show_gallery = app().settings.get().show_gallery;
    let target = {
        let list = app().editors.list.lock().unwrap();
        if let Some((label, _)) = library_id.as_ref().and_then(|id| list.iter().find(|(_, e)| e.library_id.as_ref() == Some(id))) {
            let label = label.clone();
            drop(list);
            if let Some(w) = app().handle.get_webview_window(&label) {
                focus(&w);
            }
            return;
        }
        let reusable = |e: &Editor| !e.has_image || (e.library_id.is_some() && show_gallery);
        let mut by_focus: Vec<(&String, &Editor)> = list.iter().collect();
        by_focus.sort_by(|a, b| b.1.focused_at.cmp(&a.1.focused_at));
        let preferred = preferred.and_then(|p| list.get_key_value(p));
        let empty = list.iter().filter(|(_, e)| !e.has_image);
        preferred.into_iter().chain(empty).chain(by_focus).find(|(_, e)| reusable(e)).map(|(l, _)| l.clone())
    };
    let Some(label) = target else {
        create(Some(payload));
        return;
    };
    if let Some(e) = app().editors.list.lock().unwrap().get_mut(&label) {
        e.has_image = true;
        e.library_id = library_id;
    }
    if let Some(w) = app().handle.get_webview_window(&label) {
        let _ = w.emit_to(&label, "editor:load", payload); // l'éditeur enregistre d'abord la capture qu'il affiche
        focus(&w);
    }
}

pub fn open_settings() {
    if let Some(w) = app().handle.get_webview_window("settings") {
        return focus(&w);
    }
    let Ok(window) = builder("settings", "settings/index.html", &t("settings.title", &[]), (720.0, 760.0), (560.0, 480.0)).build() else { return };
    window.on_window_event(|event| {
        if matches!(event, WindowEvent::Destroyed) {
            app().hotkeys.lock().unwrap().stop_recording();
        }
    });
}
