// Capture d'écran et sélection de zone (comme la partie « Capture » de src/main.js).
// Chaque écran est capturé en GDI, directement en Rust ; une fenêtre d'overlay par écran affiche la capture figée.
// Les overlays sont conservés et réutilisés pour que la capture suivante soit instantanée.
use image::RgbaImage;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::{app, images, t, win, BRIDGE};

/// Image d'un écran, à sa résolution physique.
pub struct Capture {
    pub monitor: String,
    pub physical: [i32; 4], // position et taille de l'écran, en pixels physiques de l'écran virtuel
    pub scale: f64,
    pub bgra: Vec<u8>,
    jpeg: Vec<u8>, // aperçu figé pour l'overlay : bien plus léger à transmettre que l'image brute
}

impl Capture {
    fn width(&self) -> i32 {
        self.physical[2]
    }
    fn height(&self) -> i32 {
        self.physical[3]
    }

    /// Partie [x, y, l, h] de l'image (pixels de l'image), en RGBA.
    pub fn crop(&self, [x, y, w, h]: [i32; 4]) -> RgbaImage {
        let stride = self.width() as usize * 4;
        let mut out = RgbaImage::new(w as u32, h as u32);
        for (row, line) in out.chunks_exact_mut(w as usize * 4).enumerate() {
            let start = (y as usize + row) * stride + x as usize * 4;
            for (dst, src) in line.chunks_exact_mut(4).zip(self.bgra[start..start + w as usize * 4].chunks_exact(4)) {
                dst.copy_from_slice(&[src[2], src[1], src[0], 255]);
            }
        }
        out
    }

    pub fn full(&self) -> RgbaImage {
        self.crop([0, 0, self.width(), self.height()])
    }

}

/// Résultat d'une capture : l'image, éventuellement déjà encodée en PNG (capture défilante).
pub struct CaptureResult {
    pub image: RgbaImage,
    pub png: Option<Vec<u8>>,
    pub scale: f64,
    pub notice: Option<String>,
}

pub struct Session {
    id: u64,
    captures: Vec<Arc<Capture>>,
    done: Option<oneshot::Sender<Option<CaptureResult>>>,
    scrolling: bool,
}

pub struct Overlay {
    label: String,
    ready: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct CaptureState {
    pub capturing: AtomicBool,
    session: Mutex<Option<Session>>,
    overlays: Mutex<HashMap<String, Overlay>>, // écran -> overlay
    acks: Mutex<HashMap<String, oneshot::Sender<()>>>,
    seq: AtomicU64,      // numéros des overlays
    sessions: AtomicU64, // numéro de la dernière sélection
}

const SNAPIT_ORIGIN: &str = "http://snapit.localhost";
// Après ce délai sans capture, les overlays gardés en réserve sont détruits : au repos, Snapit libère la mémoire
// de leurs pages (plusieurs centaines de Mo dans WebView2). La capture suivante les recrée (~100 ms de plus).
const OVERLAY_IDLE: Duration = Duration::from_secs(120);

/// Protocole snapit:// : images des écrans de la sélection en cours, pour les overlays.
pub fn serve(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let not_found = || tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
    let path = request.uri().path();
    let Some(index) = path.strip_prefix("/capture/").and_then(|i| i.parse::<usize>().ok()) else { return not_found() };
    let capture = app().capture.session.lock().unwrap().as_ref().and_then(|s| s.captures.get(index).cloned());
    let Some(capture) = capture else { return not_found() };
    crate::measure::trace("image demandée par l'overlay");
    tauri::http::Response::builder()
        .header("Content-Type", "image/jpeg")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(capture.jpeg.clone())
        .unwrap()
}

/// Capture de chaque écran, à sa résolution physique.
async fn grab_displays() -> Result<Vec<Arc<Capture>>, String> {
    let monitors = app().handle.available_monitors().map_err(|e| e.to_string())?;
    let mut captures = Vec::new();
    for m in monitors {
        let (p, s) = (m.position(), m.size());
        let physical = [p.x, p.y, s.width as i32, s.height as i32];
        let (bgra, jpeg) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let bgra = win::grab_screen(physical[0], physical[1], physical[2], physical[3])?;
            crate::measure::trace("écran capturé (GDI)");
            let jpeg = win::encode_jpeg_wic(&bgra, physical[2] as u32, physical[3] as u32, 0.92)
                .unwrap_or_else(|_| images::encode_jpeg_bgra(&bgra, physical[2] as u16, physical[3] as u16, 92));
            crate::measure::trace("aperçu JPEG encodé");
            Ok((bgra, jpeg))
        })
        .await
        .map_err(|e| e.to_string())??;
        captures.push(Arc::new(Capture { monitor: m.name().cloned().unwrap_or_default(), physical, scale: m.scale_factor(), bgra, jpeg }));
    }
    Ok(captures)
}

fn visible_windows() -> Vec<WebviewWindow> {
    app()
        .handle
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("editor-") || label == "settings")
        .map(|(_, w)| w)
        .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .collect()
}

fn hide_windows() -> Vec<WebviewWindow> {
    let windows = visible_windows();
    for w in &windows {
        let _ = w.hide();
    }
    windows
}

fn restore_windows(hidden: &[WebviewWindow]) {
    for w in hidden {
        win::show_inactive(w);
    }
}

fn set_excluded(windows: &[WebviewWindow], excluded: bool) {
    for w in windows {
        win::set_excluded_from_capture(w, excluded);
    }
}

/// Capture demandée par un raccourci, l'éditeur ou la zone de notification (`from_menu` : son menu doit d'abord
/// disparaître de l'écran).
pub async fn start_capture(mode: &str, from_menu: bool) {
    let state = &app().capture;
    if state.capturing.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::measure::trace("demande");
    let mut mode = mode.to_string();
    // Windows 10 2004 et suivants : nos fenêtres sont retirées de la capture sans être cachées, donc sans attendre
    // qu'elles disparaissent ; elles le sont ensuite, sous l'overlay. Pour la capture différée, elles sont cachées
    // tout de suite, pour libérer l'écran pendant le compte à rebours.
    let excluded = if app().exclude_supported && mode != "delay" { visible_windows() } else { Vec::new() };
    let mut hidden = if excluded.is_empty() { hide_windows() } else { Vec::new() };
    set_excluded(&excluded, true);

    let outcome: Result<(), String> = async {
        if mode == "delay" {
            tokio::time::sleep(Duration::from_secs(app().settings.get().capture_delay as u64)).await;
            mode = "region".into();
        }
        // Laisse le temps à Windows de retirer nos fenêtres (et le menu de la zone de notification) de l'écran.
        if from_menu || !hidden.is_empty() {
            tokio::time::sleep(Duration::from_millis(if hidden.is_empty() { 180 } else { 250 })).await;
        } // l'exclusion de la capture est immédiate : rien à attendre dans ce cas
        // les fenêtres visibles sont relevées en même temps que l'image, pour la détection de zone
        let detect = mode == "region" && app().settings.get().detect_regions;
        let regions = app().regions.clone();
        let (captures, found) = futures::join!(grab_displays(), async { if detect { regions.windows().await } else { None } });
        crate::measure::trace("écrans capturés, fenêtres relevées");
        set_excluded(&excluded, false);
        let captures = captures?;
        if captures.is_empty() {
            return Err(t("error.noScreen", &[]));
        }
        // nos fenêtres restées affichées ne sont pas sur l'image : elles ne doivent pas non plus être détectées
        let ours: Vec<i64> = excluded.iter().filter_map(win::hwnd_value).collect();
        let windows = found.map(|list| list.into_iter().filter(|w| !w.get("hwnd").and_then(Value::as_i64).is_some_and(|h| ours.contains(&h))).collect::<Vec<_>>());

        let result = if mode == "fullscreen" {
            let cursor = app().handle.cursor_position().unwrap_or_default();
            let c = captures
                .iter()
                .find(|c| contains(c.physical, cursor.x, cursor.y))
                .unwrap_or(&captures[0]);
            Some(CaptureResult { image: c.full(), png: None, scale: c.scale, notice: None })
        } else {
            let exclude_now = !excluded.is_empty();
            select_region(captures, windows, move || {
                if exclude_now {
                    hide_windows()
                } else {
                    Vec::new()
                }
            })
            .await
            .map(|(result, newly_hidden)| {
                hidden.extend(newly_hidden);
                result
            })
            .unwrap_or(None)
        };
        restore_windows(&hidden);
        hidden.clear();
        if let Some(result) = result {
            deliver(result).await;
        }
        Ok(())
    }
    .await;

    if let Err(err) = outcome {
        restore_windows(&hidden);
        crate::error_box(&t("error.capture", &[]), &err);
    }
    set_excluded(&excluded, false);
    state.capturing.store(false, Ordering::SeqCst);
}

fn contains([x, y, w, h]: [i32; 4], px: f64, py: f64) -> bool {
    px >= x as f64 && px < (x + w) as f64 && py >= y as f64 && py < (y + h) as f64
}

/// Copie la capture dans le presse-papiers et l'enregistre dans la bibliothèque (selon les paramètres), puis
/// l'ouvre dans l'éditeur.
pub async fn deliver(result: CaptureResult) {
    let settings = app().settings.get();
    let CaptureResult { image, png, scale, mut notice } = result;
    let (image, png, thumb) = tauri::async_runtime::spawn_blocking(move || {
        let png = png.unwrap_or_else(|| images::encode_png(&image));
        let thumb = images::thumbnail_jpeg(&image);
        (image, png, thumb)
    })
    .await
    .expect("encodage");
    crate::measure::trace("PNG et miniature encodés");
    let name = capture_name();
    let mut library_id = Value::Null;
    if settings.auto_save {
        let folder = crate::library_folder();
        let created = app().library.lock().unwrap().create(&folder, &png, &thumb, &name, scale, image.width(), image.height());
        match created {
            Ok(item) => {
                library_id = item["id"].clone();
                crate::send_to_editors("library:changed", json!({ "type": "add", "item": item }));
            }
            Err(_) => notice = Some(t("toast.autosaveFailed", &[])), // la capture s'ouvre quand même, sans enregistrement
        }
    }
    let payload = json!({
        "dataUrl": images::data_url("image/png", &png),
        "scaleFactor": scale,
        "name": name,
        "copied": settings.copy_after_capture,
        "notice": notice,
        "libraryId": library_id,
    });
    crate::measure::trace("enregistrée, envoi à l'éditeur");
    crate::editors::open_image(payload, None);
    // copie dans le presse-papiers pendant que l'éditeur affiche l'image
    if settings.copy_after_capture {
        let _ = tauri::async_runtime::spawn_blocking(move || images::write_clipboard(&image)).await;
        crate::measure::trace("copiée dans le presse-papiers");
    }
}

pub fn capture_name() -> String {
    let now = chrono::Local::now();
    t("capture.name", &[("date", &now.format("%Y-%m-%d").to_string()), ("time", &now.format("%H.%M.%S").to_string())])
}

// ------------------------------------------------------------------------------------------- overlays

fn get_overlay(monitor: &str, physical: [i32; 4]) -> Result<(WebviewWindow, Arc<AtomicBool>), String> {
    let state = &app().capture;
    let mut overlays = state.overlays.lock().unwrap();
    if let Some(o) = overlays.get(monitor) {
        if let Some(w) = app().handle.get_webview_window(&o.label) {
            return Ok((w, o.ready.clone()));
        }
    }
    let label = format!("overlay-{}", state.seq.fetch_add(1, Ordering::SeqCst));
    let ready = Arc::new(AtomicBool::new(false));
    let flag = ready.clone();
    let window = WebviewWindowBuilder::new(&app().handle, &label, WebviewUrl::App("overlay/overlay.html".into()))
        .title("Snapit — sélection")
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .shadow(false)
        .background_color(tauri::webview::Color(0, 0, 0, 255))
        // le thème clair/sombre de WebView2 est commun à toutes les pages : l'overlay suit aussi les paramètres
        .theme(crate::editors::theme())
        .initialization_script(BRIDGE)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                flag.store(true, Ordering::SeqCst);
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    win::make_tool_window(&window);
    place(&window, physical);
    overlays.insert(monitor.into(), Overlay { label, ready: ready.clone() });
    Ok((window, ready))
}

fn place(window: &WebviewWindow, [x, y, w, h]: [i32; 4]) {
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
}

/// Détruit les overlays (changement d'écrans, de langue) ; ils sont recréés à la capture suivante.
pub fn destroy_overlays() {
    let state = &app().capture;
    if state.session.lock().unwrap().is_some() {
        return; // on ne détruit rien pendant une sélection
    }
    for (_, o) in state.overlays.lock().unwrap().drain() {
        if let Some(w) = app().handle.get_webview_window(&o.label) {
            let _ = w.destroy();
        }
    }
}

// [x, y, l, h] physique -> pixels de l'image de l'écran (à la même échelle), coupé à ses bords
fn to_image_rect(c: &Capture, r: &[Value]) -> Option<[i32; 4]> {
    let v = |i: usize| r.get(i).and_then(Value::as_f64).unwrap_or(0.0);
    let (w, h) = (c.width() as f64, c.height() as f64);
    let x1 = (v(0) - c.physical[0] as f64).round().clamp(0.0, w);
    let y1 = (v(1) - c.physical[1] as f64).round().clamp(0.0, h);
    let x2 = (v(0) + v(2) - c.physical[0] as f64).round().clamp(0.0, w);
    let y2 = (v(1) + v(3) - c.physical[1] as f64).round().clamp(0.0, h);
    (x2 - x1 >= 1.0 && y2 - y1 >= 1.0).then_some([x1 as i32, y1 as i32, (x2 - x1) as i32, (y2 - y1) as i32])
}

// Fenêtres visibles sur l'écran de `c`. Les sous-fenêtres hors de l'écran restent (à null) : les autres
// désignent leur parent par son indice.
fn windows_on(c: &Capture, windows: &Option<Vec<Value>>) -> Value {
    let Some(windows) = windows else { return Value::Null };
    let rect = |v: &Value| v.as_array().and_then(|r| to_image_rect(c, r));
    Value::Array(
        windows
            .iter()
            .filter_map(|w| {
                let frame = rect(w.get("frame")?)?;
                let client = w.get("client").and_then(rect);
                let children: Vec<Value> = w
                    .get("children")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .map(|child| {
                                let r = child.as_array();
                                match (r.and_then(|r| to_image_rect(c, r)), r.and_then(|r| r.get(4))) {
                                    (Some([x, y, cw, ch]), Some(parent)) => json!([x, y, cw, ch, parent]),
                                    _ => Value::Null,
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Some(json!({ "hwnd": w.get("hwnd"), "frame": frame, "client": client, "children": children }))
            })
            .collect(),
    )
}

/// Sélection de zone sur les écrans capturés. `on_shown` est appelé une fois les overlays affichés ; les fenêtres
/// qu'il renvoie sont rendues avec le résultat, pour être réaffichées ensuite.
async fn select_region(captures: Vec<Arc<Capture>>, windows: Option<Vec<Value>>, on_shown: impl FnOnce() -> Vec<WebviewWindow>) -> Option<(Option<CaptureResult>, Vec<WebviewWindow>)> {
    let state = &app().capture;
    let id = state.sessions.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    *state.session.lock().unwrap() = Some(Session { id, captures: captures.clone(), done: Some(tx), scrolling: false });
    app().hotkeys.lock().unwrap().set_escape(true);
    let hint = t(if windows.is_some() { "overlay.hintDetect" } else { "overlay.hint" }, &[]);
    let labels = json!({
        "scrollPage": t("overlay.scrollPage", &[]),
        "scrollArea": t("overlay.scrollArea", &[]),
        "scrolling": t("overlay.scrolling", &[]),
        "scrollStop": t("overlay.scrollStop", &[]),
    });
    let cursor = app().handle.cursor_position().unwrap_or_default();

    let shown = captures.iter().enumerate().map(|(index, c)| {
        let (hint, labels, regions) = (hint.clone(), labels.clone(), windows_on(c, &windows));
        let c = c.clone();
        async move {
            let (window, ready) = get_overlay(&c.monitor, c.physical).ok()?;
            win::set_low_memory(&window, false);
            for _ in 0..300 {
                if ready.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let (ack_tx, ack_rx) = oneshot::channel();
            app().capture.acks.lock().unwrap().insert(window.label().to_string(), ack_tx);
            let here = contains(c.physical, cursor.x, cursor.y);
            crate::measure::trace("overlay prêt, envoi de l'image");
            let _ = window.emit_to(
                window.label(),
                "overlay:show",
                json!({
                    "dataUrl": format!("{SNAPIT_ORIGIN}/capture/{index}?s={id}"),
                    "hint": hint,
                    "labels": labels,
                    "regions": regions,
                    // pour mettre en évidence la zone d'emblée (pixels CSS de l'overlay)
                    "cursor": if here { json!({ "x": (cursor.x - c.physical[0] as f64) / c.scale, "y": (cursor.y - c.physical[1] as f64) / c.scale }) } else { Value::Null },
                }),
            );
            let acked = tokio::time::timeout(Duration::from_millis(1500), ack_rx).await.is_ok();
            crate::measure::trace(if acked { "image affichée par l'overlay" } else { "overlay muet (délai dépassé)" });
            app().capture.acks.lock().unwrap().remove(window.label());
            if !session_is(id) {
                return None;
            }
            place(&window, c.physical);
            let _ = window.show();
            crate::measure::trace("overlay visible");
            place(&window, c.physical); // corrige le positionnement sur les écrans à échelle mixte
            Some((window, c.physical))
        }
    });
    let shown: Vec<_> = futures::future::join_all(shown).await.into_iter().flatten().collect();
    let mut newly_hidden = Vec::new();
    if session_is(id) {
        newly_hidden = on_shown();
        let active = shown.iter().find(|(_, p)| contains(*p, cursor.x, cursor.y)).or(shown.first());
        if let Some((w, _)) = active {
            let _ = w.set_focus();
        }
    }
    let result = rx.await.ok().flatten();
    Some((result, newly_hidden))
}

fn session_is(id: u64) -> bool {
    app().capture.session.lock().unwrap().as_ref().is_some_and(|s| s.id == id)
}

fn end_session(result: Option<CaptureResult>) {
    let state = &app().capture;
    let Some(mut session) = state.session.lock().unwrap().take() else { return };
    app().hotkeys.lock().unwrap().set_escape(false);
    for o in state.overlays.lock().unwrap().values() {
        if let Some(w) = app().handle.get_webview_window(&o.label) {
            let _ = w.hide();
            let _ = w.emit_to(w.label(), "overlay:reset", ());
            win::set_low_memory(&w, true); // l'overlay reste prêt, mais WebView2 libère sa mémoire
        }
    }
    if let Some(done) = session.done.take() {
        let _ = done.send(result);
    }
    let id = session.id;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(OVERLAY_IDLE).await;
        if app().capture.sessions.load(Ordering::SeqCst) == id && app().capture.session.lock().unwrap().is_none() {
            destroy_overlays(); // aucune capture depuis
        }
    });
}

/// Échap : annule la sélection. Pendant une capture défilante, l'arrête là : ce qui est capturé est gardé.
pub fn cancel_selection() {
    let scrolling = app().capture.session.lock().unwrap().as_ref().is_some_and(|s| s.scrolling);
    if scrolling {
        app().regions.stop_scroll();
    } else {
        end_session(None);
    }
}

pub fn overlay_ready(label: &str) {
    if let Some(ack) = app().capture.acks.lock().unwrap().remove(label) {
        let _ = ack.send(());
    }
}

// Capture affichée par l'overlay `label` pendant la sélection en cours
fn capture_of(label: &str) -> Option<Arc<Capture>> {
    let state = &app().capture;
    let monitor = state.overlays.lock().unwrap().iter().find(|(_, o)| o.label == label).map(|(m, _)| m.clone())?;
    state.session.lock().unwrap().as_ref()?.captures.iter().find(|c| c.monitor == monitor).cloned()
}

/// Éléments d'interface sous la souris (point en pixels de l'image de l'overlay), du plus grand au plus petit.
pub async fn probe(label: &str, hwnd: i64, x: f64, y: f64) -> Value {
    let Some(c) = capture_of(label) else { return Value::Null };
    if !x.is_finite() || !y.is_finite() {
        return Value::Null;
    }
    let Some(chain) = app().regions.probe(hwnd, c.physical[0] as f64 + x, c.physical[1] as f64 + y).await else { return Value::Null };
    if app().capture.session.lock().unwrap().is_none() {
        return Value::Null;
    }
    Value::Array(
        chain
            .iter()
            .filter_map(|item| {
                let r = item.as_array()?;
                let [x, y, w, h] = to_image_rect(&c, r)?;
                let kind = r.get(4).and_then(Value::as_str).unwrap_or_default();
                let scroll = r.get(5).and_then(Value::as_i64).filter(|n| *n > 0).unwrap_or(0);
                Some(json!([x, y, w, h, kind, scroll]))
            })
            .collect(),
    )
}

/// Zone choisie (fractions de l'image de l'overlay).
pub fn select(label: &str, frac: &Value) {
    if app().capture.session.lock().unwrap().is_none() {
        return;
    }
    let Some(c) = capture_of(label) else { return end_session(None) };
    let f = |k: &str| frac.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let (w, h) = (c.width(), c.height());
    let x = ((f("x") * w as f64).round() as i32).clamp(0, w - 1);
    let y = ((f("y") * h as f64).round() as i32).clamp(0, h - 1);
    let cw = ((f("w") * w as f64).round() as i32).clamp(1, w - x);
    let ch = ((f("h") * h as f64).round() as i32).clamp(1, h - y);
    end_session(Some(CaptureResult { image: c.crop([x, y, cw, ch]), png: None, scale: c.scale, notice: None }));
}

/// Le clavier (Entrée, flèches, Échap) suit la souris d'un écran à l'autre.
pub fn focus(window: &WebviewWindow) {
    if app().capture.session.lock().unwrap().is_some() {
        let _ = window.set_focus();
    }
}

/// Capture défilante de la zone [x, y, l, h] (pixels de l'image de l'overlay), qui montre l'élément `scroll` :
/// l'assistant fait défiler la page de haut en bas en la capturant, puis assemble les captures. L'overlay reste
/// affiché mais Windows le retire des captures. En cas d'échec, seule la partie visible est capturée.
pub async fn scroll(window: WebviewWindow, zone: Value) {
    let label = window.label().to_string();
    let Some(c) = capture_of(&label) else { return };
    let scroll = zone.get("scroll").and_then(Value::as_i64).unwrap_or(0);
    let v = |k: &str| zone.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let (Some(x), Some(y), Some(w), Some(h)) = (v("x"), v("y"), v("w"), v("h")) else { return };
    {
        let mut session = app().capture.session.lock().unwrap();
        let Some(s) = session.as_mut() else { return };
        if s.scrolling || scroll <= 0 {
            return;
        }
        s.scrolling = true;
    }
    let (zw, zh) = (c.width(), c.height());
    let zx = (x.round() as i32).clamp(0, zw - 1);
    let zy = (y.round() as i32).clamp(0, zh - 1);
    let zone = [zx, zy, (w.round() as i32).clamp(1, zw - zx), (h.round() as i32).clamp(1, zh - zy)];
    let physical = [c.physical[0] + zone[0], c.physical[1] + zone[1], zone[2], zone[3]];
    let file = std::env::temp_dir().join(format!("snapit-page-{}-{}.png", std::process::id(), chrono::Utc::now().timestamp_millis()));

    if app().exclude_supported {
        win::set_excluded_from_capture(&window, true);
    } else {
        let _ = window.hide();
    }
    tokio::time::sleep(Duration::from_millis(120)).await; // le temps que l'overlay disparaisse des captures
    let progress_window = window.clone();
    let progress = move |value: f64| {
        let _ = progress_window.emit_to(progress_window.label(), "overlay:scroll-progress", value);
    };
    let done = app().regions.scroll_capture(scroll, physical, c.scale, &file, &progress).await;
    let mut result = None;
    if let Some(done) = done {
        if let Ok(png) = std::fs::read(&file) {
            if let Ok(image) = image::load_from_memory(&png) {
                let image = image.to_rgba8();
                let end = done.get("end").and_then(Value::as_str).unwrap_or_default();
                let notice = match end {
                    "limit" => Some(t("toast.pageTruncated", &[("h", &format_height(image.height()))])),
                    "interrupted" => Some(t("toast.scrollIncomplete", &[])),
                    _ => None,
                };
                result = Some(CaptureResult { image, png: Some(png), scale: c.scale, notice });
            }
        }
    }
    let _ = std::fs::remove_file(&file);
    win::set_excluded_from_capture(&window, false);
    end_session(Some(result.unwrap_or_else(|| CaptureResult { image: c.crop(zone), png: None, scale: c.scale, notice: Some(t("toast.scrollFailed", &[])) })));
}

// 30000 -> « 30 000 » (fr) ou « 30,000 » (en), comme toLocaleString
fn format_height(h: u32) -> String {
    let sep = if crate::lang() == "fr" { "\u{202f}" } else { "," };
    let digits = h.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push_str(sep);
        }
        out.push(ch);
    }
    out
}
