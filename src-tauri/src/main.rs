// Snapit : zone de notification, fenêtres, capture, commandes des pages.
// L'éditeur et les paramètres sont des pages web (src/editor, src/settings) affichées par WebView2 ; src/bridge.js
// leur fournit l'API `window.snapit`. La capture, la sélection de zone et les raccourcis sont natifs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod commands;
mod dxgi;
mod editors;
mod helpers;
mod hotkeys;
mod i18n;
mod keyhook;
mod images;
mod library;
mod measure;
mod overlay;
mod selftest;
mod settings;
mod testpage;
mod updater;
mod win;
mod zones;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_notification::NotificationExt;

pub const BRIDGE: &str = include_str!("../../src/bridge.js");
// Lancé au démarrage de Windows, Snapit démarre discrètement dans la zone de notification.
const HIDDEN_ARG: &str = "--hidden";

pub struct Snapit {
    pub handle: AppHandle,
    pub data_dir: PathBuf,
    pub settings: settings::SettingsStore,
    pub library: Mutex<library::Library>,
    pub zones: Arc<zones::Zones>,
    pub hotkeys: Mutex<hotkeys::Hotkeys>,
    pub editors: editors::EditorsState,
    pub capture: capture::CaptureState,
    pub quitting: AtomicBool,
    pub balloon_shown: AtomicBool,
    pub exclude_supported: bool,
    pub last_save_dir: Mutex<Option<PathBuf>>,
    tray: Mutex<Option<TrayIcon>>,
}

static APP: OnceLock<Snapit> = OnceLock::new();

pub fn app() -> &'static Snapit {
    APP.get().expect("Snapit n'est pas initialisé")
}

// ------------------------------------------------------------------------------------- langue, état

pub fn lang() -> String {
    i18n::resolve(&app().settings.get().language)
}

pub fn t(key: &str, params: &[(&str, &str)]) -> String {
    i18n::t(&lang(), key, params)
}

pub fn shortcut_label(action: &str) -> String {
    i18n::format_accelerator(&lang(), app().settings.get().shortcuts.get(action))
}

pub fn pictures_dir() -> PathBuf {
    app().handle.path().picture_dir().unwrap_or_else(|_| PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Pictures"))
}

pub fn library_folder() -> PathBuf {
    let folder = app().settings.get().library_folder;
    if folder.is_empty() { pictures_dir().join("Snapit") } else { PathBuf::from(folder) }
}

pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

// État partagé avec les pages (éditeur, paramètres)
pub fn app_state() -> Value {
    let a = app();
    json!({
        "settings": a.settings.get(),
        "lang": lang(),
        "status": a.hotkeys.lock().unwrap().status(),
        "version": env!("CARGO_PKG_VERSION"),
        "isPackaged": is_packaged(),
        "openAtLogin": is_packaged() && a.handle.autolaunch().is_enabled().unwrap_or(false),
        "libraryFolder": library_folder(),
    })
}

pub fn broadcast() {
    let _ = app().handle.emit("app:state", app_state());
}

pub fn send_to_editors(event: &str, payload: Value) {
    for label in editors::labels() {
        let _ = app().handle.emit_to(&label, event, payload.clone());
    }
}

pub fn notify(title: &str, body: &str) {
    let _ = app().handle.notification().builder().title(title).body(body).show();
}

pub fn error_box(title: &str, message: &str) {
    app().handle.dialog().message(message).title(title).kind(MessageDialogKind::Error).show(|_| {});
}

pub async fn confirm_close_unsaved(window: &tauri::WebviewWindow) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app()
        .handle
        .dialog()
        .message(t("unsaved.detail", &[]))
        .title(t("unsaved.message", &[]))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(t("unsaved.close", &[]), t("unsaved.cancel", &[])))
        .parent(window)
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

// Le dossier de la bibliothèque est lisible par les pages (miniatures de la galerie), par le protocole asset.
fn allow_library_folder() {
    let _ = app().handle.asset_protocol_scope().allow_directory(library_folder(), true);
}

pub fn on_settings_changed(next: &settings::Settings, previous: &settings::Settings) {
    if next.theme != previous.theme {
        for (_, w) in app().handle.webview_windows() {
            let _ = w.set_theme(editors::theme());
        }
    }
    if next.shortcuts != previous.shortcuts || next.override_snipping_tool != previous.override_snipping_tool {
        app().hotkeys.lock().unwrap().apply(&next.shortcuts, next.override_snipping_tool);
    }
    if next.language != previous.language {
        capture::destroy_overlays();
    }
    if next.library_folder != previous.library_folder {
        allow_library_folder();
        send_to_editors("library:changed", json!({ "type": "reset" }));
    }
    refresh_tray();
    broadcast();
}

// ------------------------------------------------------------------------------- zone de notification

fn tray_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let s = app().settings.get();
    // le raccourci s'affiche à droite de l'élément
    let item = |id: &str, key: &str, params: &[(&str, &str)], shortcut: Option<&str>| {
        let mut text = t(key, params);
        if let Some(acc) = shortcut.filter(|a| !a.is_empty()) {
            text = format!("{text}\t{}", i18n::format_accelerator(&lang(), acc));
        }
        MenuItem::with_id(handle, id, text, true, None::<&str>)
    };
    let delay = s.capture_delay.to_string();
    let menu = Menu::with_items(
        handle,
        &[
            &item("region", "tray.region", &[], Some(&s.shortcuts.region))?,
            &item("fullscreen", "tray.fullscreen", &[], Some(&s.shortcuts.fullscreen))?,
            &item("delay", "tray.delay", &[("s", &delay)], Some(&s.shortcuts.delay))?,
            &PredefinedMenuItem::separator(handle)?,
            &item("editor", "tray.editor", &[], None)?,
            &item("open", "tray.open", &[], None)?,
            &PredefinedMenuItem::separator(handle)?,
            &item("settings", "tray.settings", &[], None)?,
            &item("quit", "tray.quit", &[], None)?,
        ],
    )?;
    // mise à jour prête : proposée en tête du menu
    if let Some(version) = updater::pending_version() {
        menu.prepend_items(&[&item("update", "tray.update", &[("version", &version)], None)?, &PredefinedMenuItem::separator(handle)?])?;
    }
    Ok(menu)
}

pub fn refresh_tray() {
    if let Some(tray) = app().tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(t("tray.tooltip", &[])));
        if let Ok(menu) = tray_menu(&app().handle) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn create_tray(handle: &AppHandle) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray@2x.png"))?;
    let tray = TrayIconBuilder::with_id("snapit")
        .icon(icon)
        .tooltip(t("tray.tooltip", &[]))
        .menu(&tray_menu(handle)?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|_, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                editors::show();
            }
        })
        .build(handle)?;
    *app().tray.lock().unwrap() = Some(tray);
    Ok(())
}

fn on_menu(id: &str) {
    match id {
        "region" | "fullscreen" | "delay" => {
            let mode = id.to_string();
            tauri::async_runtime::spawn(async move { capture::start_capture(&mode, true).await });
        }
        "editor" => editors::show(),
        "open" => {
            tauri::async_runtime::spawn(async {
                match commands::open_image_dialog(None).await {
                    Ok(Some(payload)) => editors::open_image(payload, None),
                    Ok(None) => {}
                    Err(err) => error_box(&t("error.open", &[]), &err),
                }
            });
        }
        "settings" => editors::open_settings(),
        "update" => updater::install(),
        "quit" => quit(),
        _ => {
            // menu contextuel d'une miniature : « gallery|<fenêtre>|<action>|<capture> »
            let parts: Vec<&str> = id.splitn(4, '|').collect();
            if let ["gallery", label, action, capture] = parts[..] {
                let _ = app().handle.emit_to(label, "library:menu-action", json!({ "action": action, "id": capture }));
            }
        }
    }
}

/// Quitter : chaque éditeur enregistre ses dernières modifications (ou demande confirmation) avant de fermer.
pub fn quit() {
    app().quitting.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async {
        for label in editors::labels() {
            if !editors::close(&label).await {
                app().quitting.store(false, Ordering::SeqCst);
                return;
            }
        }
        app().handle.exit(0);
    });
}

// ----------------------------------------------------------------------------------------- raccourcis

fn on_hotkey_line(line: String) {
    let event = app().hotkeys.lock().unwrap().handle_line(&line);
    match event {
        hotkeys::HotkeyEvent::Trigger(action) => {
            tauri::async_runtime::spawn(async move { capture::start_capture(&action, false).await });
        }
        hotkeys::HotkeyEvent::Recorded(accelerator) => {
            selftest::recorded(&accelerator);
            let _ = app().handle.emit_to("settings", "shortcuts:recorded", accelerator);
        }
        hotkeys::HotkeyEvent::None => {}
    }
}

fn on_global_shortcut(shortcut: &tauri_plugin_global_shortcut::Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let action = app().hotkeys.lock().unwrap().action_of(shortcut);
    match action.as_deref() {
        Some(hotkeys::ESCAPE) => capture::cancel_selection(),
        Some(action) => {
            let action = action.to_string();
            tauri::async_runtime::spawn(async move { capture::start_capture(&action, false).await });
        }
        None => {}
    }
}

// -------------------------------------------------------------------------------------------- démarrage

fn data_dir() -> PathBuf {
    if let Some(dir) = measure::profile_dir().or_else(selftest::profile_dir) {
        return dir;
    }
    // même dossier que les versions Electron (jusqu'à la 0.4) : paramètres et bibliothèque repris tels quels
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("snapit")
}

fn setup(handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = data_dir();
    let settings = settings::SettingsStore::new(dir.join("settings.json"));
    let snapit = Snapit {
        handle: handle.clone(),
        data_dir: dir.clone(),
        settings,
        library: Mutex::new(library::Library::new()),
        zones: zones::Zones::new(),
        hotkeys: Mutex::new(hotkeys::Hotkeys::new(handle.clone())),
        editors: Default::default(),
        capture: Default::default(),
        quitting: AtomicBool::new(false),
        balloon_shown: AtomicBool::new(false),
        exclude_supported: win::can_exclude_from_capture(),
        last_save_dir: Mutex::new(None),
        tray: Mutex::new(None),
    };
    if APP.set(snapit).is_err() {
        return Err("Snapit est déjà initialisé".into());
    }
    let a = app();
    allow_library_folder();
    {
        // rien n'est enregistré avant le hook : un raccourci Impr. écran enregistré auprès de Windows lui
        // prendrait la touche
        let s = a.settings.get();
        a.hotkeys.lock().unwrap().configure(&s.shortcuts, s.override_snipping_tool);
    }
    // hook clavier (Impr. écran prioritaire sur l'Outil Capture), puis raccourcis
    std::thread::spawn(|| hotkeys::init(&app().hotkeys, on_hotkey_line, broadcast)); // sans retarder l'éditeur
    a.zones.start(); // détection des zones : prêt dès la première capture
    dxgi::warm_up(); // duplications du bureau ouvertes d'avance
    overlay::prepare(); // fil de l'overlay et Direct2D prêts dès la première capture
    create_tray(handle)?;
    if !std::env::args().any(|arg| arg == HIDDEN_ARG) {
        editors::create(None);
    }
    measure::start();
    selftest::start();
    updater::start();
    Ok(())
}

fn main() {
    // processus du hook clavier, lancé par Snapit lui-même (voir keyhook.rs)
    if std::env::args().any(|a| a == keyhook::ARG) {
        std::process::exit(keyhook::run_helper());
    }
    let context = tauri::generate_context!();
    // page de test de l'autotest, dans un processus à part (voir testpage.rs)
    if std::env::args().any(|a| a == testpage::ARG) {
        return testpage::run(context);
    }
    measure::mark_start();
    let mut builder = tauri::Builder::default();
    // Une seule instance, sauf pour l'autotest et les mesures : ils ont leur propre profil et doivent pouvoir tourner
    // à côté du Snapit installé.
    if !selftest::enabled() && !measure::enabled() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_, _, _| editors::show()));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|_, shortcut, event| on_global_shortcut(shortcut, event.state)).build())
        .register_uri_scheme_protocol("snapit", |_, request| capture::serve(&request))
        .on_menu_event(|_, event| on_menu(event.id().as_ref()))
        .invoke_handler(commands::handler())
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .build(context)
        .expect("démarrage de Snapit");

    app.run(|handle, event| match event {
        // L'application vit dans la zone de notification : fermer les fenêtres ne la quitte pas.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(a) = APP.get() {
                a.hotkeys.lock().unwrap().dispose();
                a.zones.stop();
            }
            let _ = handle;
        }
        _ => {}
    });
}
