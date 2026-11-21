// Commandes appelées par les pages, par l'intermédiaire de src/bridge.js (`window.snapit`).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::WebviewWindow;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::capture as cap;
use crate::{app, editors, images, library_folder, pictures_dir, send_to_editors, t};
use crate::app_state as current_state;

const IMAGE_TYPES: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("bmp", "image/bmp"), ("webp", "image/webp")];

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        capture,
        editor_initial,
        editor_state,
        editor_show,
        editor_close_ready,
        clipboard_write_image,
        clipboard_read_image,
        file_save_image,
        file_open_image,
        library_list,
        library_open,
        library_save,
        library_remove,
        library_copy,
        library_reveal,
        library_menu,
        library_open_folder,
        app_state,
        settings_open,
        settings_set,
        settings_set_login,
        settings_choose_folder,
        settings_choose_library_folder,
        settings_reset_shortcuts,
        settings_open_windows_keyboard,
        shortcuts_record_start,
        shortcuts_record_stop,
    ]
}

// ---------------------------------------------------------------------------------------------- éditeur

#[tauri::command]
async fn capture(mode: String) {
    cap::start_capture(&mode, false).await;
}

#[tauri::command]
fn editor_initial(window: WebviewWindow) -> Value {
    editors::initial(window.label())
}

#[tauri::command]
fn editor_state(window: WebviewWindow, has_image: bool, library_id: Option<String>) {
    crate::measure::editor_state(library_id.as_deref());
    editors::set_state(window.label(), has_image, library_id);
}

#[tauri::command]
fn editor_show(window: WebviewWindow, payload: Value) {
    editors::open_image(payload, Some(window.label()));
}

// Réponse de l'éditeur à une demande de fermeture, une fois ses dernières modifications enregistrées
#[tauri::command]
fn editor_close_ready(window: WebviewWindow, unsaved: bool) {
    editors::close_ready(window.label(), unsaved);
}

#[tauri::command]
async fn clipboard_write_image(data_url: String) -> Result<bool, String> {
    let png = images::from_data_url(&data_url).ok_or("image illisible")?;
    tauri::async_runtime::spawn_blocking(move || images::write_clipboard_png(&png)).await.map_err(|e| e.to_string())??;
    Ok(true)
}

#[tauri::command]
async fn clipboard_read_image() -> Value {
    let png = tauri::async_runtime::spawn_blocking(|| images::read_clipboard().map(|img| images::encode_png(&img))).await.ok().flatten();
    match png {
        Some(png) => json!({ "dataUrl": images::data_url("image/png", &png), "name": cap::capture_name(), "scaleFactor": 1 }),
        None => Value::Null,
    }
}

fn file_name_filter(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '-' } else { c }).collect();
    if cleaned.is_empty() { "Capture".into() } else { cleaned }
}

#[tauri::command]
async fn file_save_image(window: WebviewWindow, data_url: String, name: Option<String>) -> Result<Option<String>, String> {
    let s = app().settings.get();
    let jpeg_first = s.save_format == "jpeg";
    let dir = app().last_save_dir.lock().unwrap().clone().unwrap_or_else(|| if s.save_folder.is_empty() { pictures_dir() } else { PathBuf::from(&s.save_folder) });
    let file_name = format!("{}.{}", file_name_filter(name.as_deref().unwrap_or("Capture")), if jpeg_first { "jpg" } else { "png" });
    let mut dialog = app().handle.dialog().file().set_title(t("dialog.save", &[])).set_directory(&dir).set_file_name(&file_name).set_parent(&window);
    let (png, jpeg) = ((t("filter.png", &[]), ["png"].as_slice()), (t("filter.jpeg", &[]), ["jpg", "jpeg"].as_slice()));
    for (name, exts) in if jpeg_first { [jpeg, png] } else { [png, jpeg] } {
        dialog = dialog.add_filter(name, exts);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let data = images::from_data_url(&data_url).ok_or("image illisible")?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bytes = if ext == "jpg" || ext == "jpeg" {
            images::encode_jpeg(&image::load_from_memory(&data).map_err(|e| e.to_string())?, 92)
        } else {
            data
        };
        std::fs::write(&target, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    *app().last_save_dir.lock().unwrap() = path.parent().map(Path::to_path_buf);
    Ok(Some(path.display().to_string()))
}

pub async fn read_image_file(path: &Path) -> Result<Value, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    let mime = IMAGE_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).ok_or_else(|| t("error.format", &[]))?;
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(json!({
        "dataUrl": images::data_url(mime, &data),
        "name": path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        "scaleFactor": 1,
    }))
}

pub async fn open_image_dialog(parent: Option<&WebviewWindow>) -> Result<Option<Value>, String> {
    let exts: Vec<&str> = IMAGE_TYPES.iter().map(|(e, _)| *e).collect();
    let mut dialog = app().handle.dialog().file().set_title(t("dialog.open", &[])).set_directory(pictures_dir()).add_filter(t("filter.images", &[]), &exts);
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    match rx.await.ok().flatten().and_then(|p| p.into_path().ok()) {
        Some(path) => read_image_file(&path).await.map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
async fn file_open_image(window: WebviewWindow) -> Result<Value, String> {
    Ok(open_image_dialog(Some(&window)).await?.unwrap_or(Value::Null))
}

// ------------------------------------------------------------------------------------------ bibliothèque

#[tauri::command]
fn library_list() -> Vec<Value> {
    app().library.lock().unwrap().list(&library_folder())
}

#[tauri::command]
fn library_open(window: WebviewWindow, id: String, new_window: bool) -> Result<(), String> {
    let showing = app().editors.list.lock().unwrap().iter().find(|(_, e)| e.library_id.as_deref() == Some(&id)).map(|(l, _)| l.clone());
    if let Some(w) = showing.and_then(|l| tauri::Manager::get_webview_window(&app().handle, &l)) {
        editors::focus(&w);
        return Ok(());
    }
    let payload = app().library.lock().unwrap().load(&id)?;
    if new_window {
        editors::create(Some(payload));
    } else {
        editors::open_image(payload, Some(window.label()));
    }
    Ok(())
}

#[tauri::command]
async fn library_save(data: Value) -> Result<bool, String> {
    let saved = tauri::async_runtime::spawn_blocking(move || app().library.lock().unwrap().save(&data)).await.map_err(|e| e.to_string())??;
    match saved {
        Some(item) => {
            send_to_editors("library:changed", json!({ "type": "update", "item": item }));
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
async fn library_remove(id: String) -> Result<bool, String> {
    let target = id.clone();
    let removed = tauri::async_runtime::spawn_blocking(move || app().library.lock().unwrap().remove(&target)).await.map_err(|e| e.to_string())??;
    if removed {
        send_to_editors("library:changed", json!({ "type": "remove", "id": id }));
    }
    Ok(removed)
}

#[tauri::command]
async fn library_copy(id: String) -> Result<bool, String> {
    let path = app().library.lock().unwrap().image_path(&id).ok_or("Capture introuvable")?;
    tauri::async_runtime::spawn_blocking(move || images::write_clipboard_png(&std::fs::read(path).map_err(|e| e.to_string())?))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}

#[tauri::command]
fn library_reveal(id: String) {
    if let Some(path) = app().library.lock().unwrap().image_path(&id) {
        let _ = app().handle.opener().reveal_item_in_dir(path);
    }
}

// Menu contextuel d'une miniature : l'éditeur exécute l'action choisie (voir on_menu dans main.rs).
#[tauri::command]
fn library_menu(window: WebviewWindow, id: String) -> Result<(), String> {
    let h = &app().handle;
    let label = window.label();
    let item = |action: &str, key: &str| MenuItem::with_id(h, format!("gallery|{label}|{action}|{id}"), t(key, &[]), true, None::<&str>);
    let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
        Menu::with_items(
            h,
            &[
                &item("open", "gallery.menuOpen")?,
                &item("openNew", "gallery.menuOpenNew")?,
                &PredefinedMenuItem::separator(h)?,
                &item("copy", "gallery.menuCopy")?,
                &item("reveal", "gallery.menuReveal")?,
                &PredefinedMenuItem::separator(h)?,
                &item("delete", "gallery.menuDelete")?,
            ],
        )
    })()
    .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn library_open_folder() -> Result<(), String> {
    let folder = library_folder();
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    app().handle.opener().open_path(folder.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------------------------------- paramètres

#[tauri::command]
fn app_state() -> Value {
    current_state()
}

#[tauri::command]
fn settings_open() {
    editors::open_settings();
}

fn set_settings(patch: Value) -> Value {
    let (next, previous) = app().settings.set(&patch);
    crate::on_settings_changed(&next, &previous);
    current_state()
}

#[tauri::command]
fn settings_set(patch: Value) -> Value {
    set_settings(patch)
}

#[tauri::command]
fn settings_set_login(enabled: bool) -> Value {
    if crate::is_packaged() {
        let launcher = app().handle.autolaunch();
        let _ = if enabled { launcher.enable() } else { launcher.disable() };
    }
    crate::broadcast();
    current_state()
}

async fn pick_folder(window: &WebviewWindow, title: String, start: PathBuf) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app().handle.dialog().file().set_title(title).set_directory(start).set_parent(window).pick_folder(move |path| {
        let _ = tx.send(path);
    });
    rx.await.ok().flatten().and_then(|p| p.into_path().ok())
}

#[tauri::command]
async fn settings_choose_folder(window: WebviewWindow) -> Value {
    let current = app().settings.get().save_folder;
    let start = if current.is_empty() { pictures_dir() } else { PathBuf::from(current) };
    match pick_folder(&window, t("dialog.folder", &[]), start).await {
        Some(path) => set_settings(json!({ "saveFolder": path })),
        None => current_state(),
    }
}

#[tauri::command]
async fn settings_choose_library_folder(window: WebviewWindow) -> Value {
    match pick_folder(&window, t("dialog.libraryFolder", &[]), library_folder()).await {
        Some(path) => set_settings(json!({ "libraryFolder": path })),
        None => current_state(),
    }
}

#[tauri::command]
fn settings_reset_shortcuts() -> Value {
    set_settings(json!({ "shortcuts": crate::settings::Shortcuts::defaults() }))
}

#[tauri::command]
fn settings_open_windows_keyboard() {
    let _ = app().handle.opener().open_url("ms-settings:easeofaccess-keyboard", None::<&str>);
}

#[tauri::command]
fn shortcuts_record_start() {
    app().hotkeys.lock().unwrap().start_recording();
}

#[tauri::command]
fn shortcuts_record_stop() {
    app().hotkeys.lock().unwrap().stop_recording();
}
