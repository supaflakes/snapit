// Autotest de bout en bout de la version Tauri (l'équivalent de `npm run smoke` pour la version Electron) :
// lancer Snapit avec `--selftest`. Profil et bibliothèque à part, dans %TEMP%\snapit-selftest ; des captures
// d'écran de contrôle y sont enregistrées.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

use crate::{app, capture, editors, images, overlay, win};

static REPORT: Mutex<Vec<String>> = Mutex::new(Vec::new());
static FAILURES: Mutex<u32> = Mutex::new(0);
static RECORDED: Mutex<Option<String>> = Mutex::new(None);

/// Raccourci enregistré dans les paramètres (touche remontée par le hook).
pub fn recorded(accelerator: &str) {
    *RECORDED.lock().unwrap() = Some(accelerator.into());
}

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

// Appuie sur les touches (code virtuel, code de scan) dans l'ordre, puis les relâche dans l'ordre inverse, depuis
// un autre processus (PowerShell), comme un vrai clavier.
async fn press(keys: &[(u8, u8)]) {
    use std::os::windows::process::CommandExt;
    let flags = |vk: u8, up: bool| (if vk == 0x5b { 1 } else { 0 }) | (if up { 2 } else { 0 });
    let mut script = vec![
        "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'".to_string(),
        "$k = Add-Type -MemberDefinition $sig -Name K -Namespace SnapitSelftest -PassThru".to_string(),
    ];
    for &(vk, scan) in keys {
        script.push(format!("$k::keybd_event({vk}, {scan}, {}, [UIntPtr]::Zero)", flags(vk, false)));
    }
    script.push("Start-Sleep -Milliseconds 70".into());
    for &(vk, scan) in keys.iter().rev() {
        script.push(format!("$k::keybd_event({vk}, {scan}, {}, [UIntPtr]::Zero)", flags(vk, true)));
    }
    let script = script.join("
");
    let _ = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("powershell").args(["-NoProfile", "-Command", &script]).creation_flags(crate::win::CREATE_NO_WINDOW).output()
    })
    .await;
}

fn count_processes(name: &str) -> usize {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
        .creation_flags(crate::win::CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).matches(name).count())
        .unwrap_or(0)
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

fn visible_overlay() -> Option<(usize, [i32; 4], isize)> {
    overlay::visible()
}

// Souris simulée dans l'overlay : messages envoyés à sa fenêtre, en pixels physiques de la fenêtre.
fn post_mouse(hwnd: isize, msg: u32, x: i32, y: i32) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
    let lparam = (((y as u32 & 0xffff) << 16) | (x as u32 & 0xffff)) as isize;
    unsafe {
        let _ = PostMessageW(Some(HWND(hwnd as _)), msg, WPARAM(0), LPARAM(lparam));
    }
}

fn foreground() -> isize {
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize }
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
        until(Duration::from_secs(30), || app().zones.running()).await;
        let hook = until(Duration::from_secs(30), || {
            let h = app().hotkeys.lock().unwrap();
            h.hook_ready || h.hook_failed
        })
        .await;
        check("assistant clavier démarré", hook && app().hotkeys.lock().unwrap().hook_ready, app().hotkeys.lock().unwrap().status().to_string());
        check("assistant de détection des zones démarré", app().zones.running(), "");
        tokio::time::sleep(Duration::from_millis(800)).await;
        screenshot("0-editeur.png");

        // Touches réelles : Impr. écran, puis Win+Maj+S (envoyé par beaucoup de claviers pour Impr. écran), doivent
        // ouvrir la sélection de Snapit, et non l'Outil Capture de Windows.
        for (label, keys) in [("Impr. écran ouvre la sélection Snapit", vec![(0x2c, 0)]), ("Win+Maj+S ouvre la sélection Snapit", vec![(0x5b, 0x5b), (0xa0, 0x2a), (0x53, 0x1f)])] {
            let snipping_before = count_processes("ScreenClippingHost.exe");
            press(&keys).await;
            let opened = until(Duration::from_secs(4), || visible_overlay().is_some()).await;
            check(label, opened, "");
            tokio::time::sleep(Duration::from_millis(300)).await;
            capture::cancel_selection();
            until(Duration::from_secs(4), || !capturing()).await;
            let snipping_after = count_processes("ScreenClippingHost.exe");
            check("l'Outil Capture ne s'ouvre pas", snipping_after <= snipping_before, format!("{snipping_before} → {snipping_after}"));
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        scroll_test().await;

        // Enregistrement d'un raccourci dans les paramètres : Maj+Impr. écran est remontée par le hook
        app().hotkeys.lock().unwrap().start_recording();
        press(&[(0xa0, 0x2a), (0x2c, 0)]).await;
        let recorded = until(Duration::from_secs(3), || RECORDED.lock().unwrap().is_some()).await;
        app().hotkeys.lock().unwrap().stop_recording();
        let value = RECORDED.lock().unwrap().clone().unwrap_or_default();
        check("enregistrer un raccourci : Maj+Impr. écran", recorded && value == "Shift+PrintScreen", value);
        check("aucune capture pendant l'enregistrement", visible_overlay().is_none() && !capturing(), "");

        // 1. Zone : sélection tracée à la souris dans l'overlay
        tauri::async_runtime::spawn(async { capture::start_capture("region", false).await });
        let overlay = until(Duration::from_secs(5), || visible_overlay().is_some()).await;
        check("l'overlay de sélection s'affiche", overlay, "");
        tokio::time::sleep(Duration::from_millis(600)).await;
        screenshot("1-overlay.png");
        if let Some((index, [ox, oy, ow, oh], hwnd)) = visible_overlay() {
            let m = app().handle.primary_monitor().ok().flatten().map(|m| *m.size()).unwrap_or_default();
            check("l'overlay couvre l'écran", ow as u32 == m.width && oh as u32 == m.height, format!("{ow}×{oh} pour un écran de {}×{}", m.width, m.height));
            check("l'overlay reçoit le clavier", foreground() == hwnd, "");
            // À l'écran : l'image capturée, pixel pour pixel, assombrie hors de la zone en surbrillance
            if let (Some(c), Ok(shown)) = (capture::capture_at(index), win::grab_screen(ox, oy, ow, oh)) {
                let (mut same, mut dimmed, mut total) = (0u32, 0u32, 0u32);
                for y in (0..oh as usize).step_by(37) {
                    for x in (0..ow as usize).step_by(41) {
                        let o = (y * ow as usize + x) * 4;
                        let close = |expected: [f64; 3]| (0..3).all(|k| (shown[o + k] as f64 - expected[k]).abs() <= 3.0);
                        let src = [c.bgra[o] as f64, c.bgra[o + 1] as f64, c.bgra[o + 2] as f64];
                        total += 1;
                        if close(src) {
                            same += 1;
                        } else if close([src[0] * 0.5 + 5.0, src[1] * 0.5 + 3.0, src[2] * 0.5 + 3.0]) {
                            dimmed += 1;
                        }
                    }
                }
                check(
                    "l'overlay affiche l'image capturée, pixel pour pixel",
                    (same + dimmed) * 100 >= total * 93,
                    format!("{same} pixel(s) identiques et {dimmed} assombris sur {total}"),
                );
            }
            let at = |fx: f64, fy: f64| ((ow as f64 * fx).round() as i32, (oh as f64 * fy).round() as i32);
            let ((x1, y1), (x2, y2)) = (at(0.1, 0.1), at(0.4, 0.4));
            post_mouse(hwnd, 0x0200, x1, y1); // WM_MOUSEMOVE
            post_mouse(hwnd, 0x0201, x1, y1); // WM_LBUTTONDOWN
            post_mouse(hwnd, 0x0200, (x1 + x2) / 2, (y1 + y2) / 2);
            post_mouse(hwnd, 0x0200, x2, y2);
            tokio::time::sleep(Duration::from_millis(300)).await;
            screenshot("1b-overlay-zone-tracee.png");
            post_mouse(hwnd, 0x0202, x2, y2); // WM_LBUTTONUP
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
        // L'éditeur, rempli de magenta, reste affiché pendant la capture (retiré de l'image plutôt que caché) :
        // il ne doit pas figurer sur l'image.
        let editor = editors::create(None);
        until(Duration::from_secs(5), || editor.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false))).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut area = None;
        if let Some(w) = &editor {
            let _ = w.eval("(() => { const v = document.createElement('div'); v.id = 'selftest-veil'; v.style.cssText = 'position:fixed;inset:0;background:#ff00ff;z-index:99999'; document.body.append(v); })()");
            if let (Ok(p), Ok(s)) = (w.inner_position(), w.inner_size()) {
                area = Some((p.x.max(0) as u32, p.y.max(0) as u32, s.width, s.height));
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let before = app().library.lock().unwrap().list(&crate::library_folder()).len();
        let started = Instant::now();
        capture::start_capture("fullscreen", false).await;
        let elapsed = started.elapsed();
        if let Some(w) = &editor {
            let _ = w.eval("document.getElementById('selftest-veil')?.remove()");
        }
        let opened = until(Duration::from_secs(5), || editor_with_image().is_some()).await;
        check("capture plein écran ouverte dans l'éditeur", opened, format!("{} ms", elapsed.as_millis()));
        let clip = images::read_clipboard();
        if let (Some(c), Some((x0, y0, w, h))) = (&clip, area) {
            let (mut magenta, mut total) = (0u32, 0u32);
            for y in (y0 + 20..(y0 + h).saturating_sub(20).min(c.height())).step_by(13) {
                for x in (x0 + 20..(x0 + w).saturating_sub(20).min(c.width())).step_by(17) {
                    let px = c.get_pixel(x, y);
                    total += 1;
                    if px[0] > 240 && px[1] < 20 && px[2] > 240 {
                        magenta += 1;
                    }
                }
            }
            check("l'éditeur affiché ne figure pas sur la capture", total > 0 && magenta * 100 < total, format!("{magenta} pixel(s) magenta sur {total} relevés dans la zone de l'éditeur"));
        }
        check("capture copiée dans le presse-papiers", clip.as_ref().is_some_and(|c| c.width() == m.width && c.height() == m.height), clip.map(|c| format!("{}×{}", c.width(), c.height())).unwrap_or_default());
        let after = app().library.lock().unwrap().list(&crate::library_folder()).len();
        check("la galerie s'enrichit de la nouvelle capture", after == before + 1, format!("{after} capture(s)"));
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

// Capture défilante d'une page de test (la même que le test de fumée Electron), ouverte dans un autre processus
// comme un vrai navigateur : en-tête fixe, 16 bandes de couleurs différentes.
async fn scroll_test() {
    use std::io::BufRead;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let electron = root.join("node_modules").join("electron").join("dist").join("electron.exe");
    if !electron.exists() {
        check("capture défilante : page de test (Electron introuvable)", false, electron.display().to_string());
        return;
    }
    const HEADER: f64 = 50.0;
    const BAND: f64 = 150.0;
    const BANDS: usize = 16;
    let bands: String = (0..BANDS)
        .map(|i| format!(r#"<div style="height:{BAND}px;background:hsl({},70%,{}%)"><p style="margin:0;padding:24px 0 0 220px">Bande {i} : du texte pour superposer les captures</p></div>"#, (i * 47) % 360, if i % 2 == 1 { 40 } else { 70 }))
        .collect();
    let file = out_dir().join("page-defilante.html");
    let _ = std::fs::write(&file, format!(r#"<!doctype html><meta charset="utf-8"><body style="margin:0;font:18px sans-serif"><div style="position:sticky;top:0;height:{HEADER}px;background:#0f172a;color:#fff;padding-left:220px;line-height:{HEADER}px">En-tête fixe</div>{bands}</body>"#));
    let Ok(Some(m)) = app().handle.primary_monitor() else { return };
    let sf = m.scale_factor();
    let (px, py) = (m.position().x as f64 / sf, m.position().y as f64 / sf);
    // nos fenêtres sont cachées le temps du test : la page doit être visible
    let hidden: Vec<_> = app().handle.webview_windows().into_values().filter(|w| w.is_visible().unwrap_or(false)).collect();
    for w in &hidden {
        let _ = w.hide();
    }
    let mut child = match std::process::Command::new(&electron)
        .arg(root.join("scripts").join("smoke-page.js"))
        .args([file.display().to_string(), (px + 260.0).to_string(), (py + 160.0).to_string(), "700".into(), "480".into(), "400".into()])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            check("capture défilante : page de test ouverte", false, e.to_string());
            return;
        }
    };
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = lines.clone();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            sink.lock().unwrap().push(line);
        }
    });
    let ready = until(Duration::from_secs(15), || lines.lock().unwrap().iter().any(|l| l.starts_with("ready "))).await;
    check("capture défilante : page de test ouverte", ready, "");
    let hwnd = lines.lock().unwrap().iter().find_map(|l| l.strip_prefix("ready ").and_then(|h| h.parse::<i64>().ok()));
    tokio::time::sleep(Duration::from_millis(600)).await;
    let scroll_y = || lines.lock().unwrap().iter().rev().find_map(|l| l.strip_prefix("scrollY ").and_then(|v| v.parse::<f64>().ok()));
    if let Some(hwnd) = hwnd {
        let (x, y) = ((px + 260.0 + 350.0) * sf, (py + 160.0 + 240.0) * sf);
        // une seule recherche, comme au premier survol de la page dans l'overlay
        let chain = app().zones.probe(hwnd, x, y).await.unwrap_or_default();
        let target = chain.iter().rev().find(|e| e[5].as_i64().unwrap_or(0) > 0).cloned();
        check("capture défilante : la page qui défile est détectée", target.is_some(), format!("{} élément(s) sous la souris", chain.len()));
        if let Some(t) = target {
            let v = |i: usize| t[i].as_i64().unwrap_or(0) as i32;
            let started = Instant::now();
            let result = app().zones.scroll_capture(t[5].as_i64().unwrap(), [v(0), v(1), v(2), v(3)], sf, |_| {}).await;
            let elapsed = started.elapsed();
            match result {
                Some(r) => {
                    let img = &r.image;
                    let _ = std::fs::write(out_dir().join("6-page-entiere.png"), images::encode_png(img));
                    let expected = ((HEADER + BAND * BANDS as f64) * sf).round();
                    check("capture défilante : hauteur de la page entière", (img.height() as f64 - expected).abs() <= 2.0, format!("{}×{}, attendu {expected} de haut, fin « {} », {} ms", img.width(), img.height(), r.end, elapsed.as_millis()));
                    check("capture défilante : sans la barre de défilement", (img.width() as f64) < 700.0 * sf && img.width() as f64 > 700.0 * sf - 40.0 * sf, format!("{} px de large", img.width()));
                    let at = |x: f64, y: f64| {
                        let p = img.get_pixel(((x * sf).round() as u32).min(img.width() - 1), ((y * sf).round() as u32).min(img.height() - 1));
                        format!("{},{},{}", p[0], p[1], p[2])
                    };
                    let header = at(20.0, HEADER / 2.0);
                    let found: Vec<[String; 4]> = (0..BANDS)
                        .map(|i| {
                            let top = HEADER + BAND * i as f64;
                            [at(20.0, top - 3.0), at(20.0, top + 3.0), at(20.0, top + BAND * 0.7), at(20.0, top + BAND - 4.0)]
                        })
                        .collect();
                    let placed = found.iter().enumerate().all(|(i, b)| b[1] == b[2] && b[2] == b[3] && if i == 0 { b[0] == header } else { b[0] == found[i - 1][2] });
                    let distinct = found.iter().enumerate().all(|(i, b)| (i == 0 || b[2] != found[i - 1][2]) && b[2] != header);
                    check("capture défilante : bandes à leur place, en-tête fixe une seule fois", placed && distinct, format!("{:?}", &found[..3]));
                }
                None => check("capture défilante : image assemblée", false, ""),
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            let back = scroll_y();
            check("capture défilante : la page revient à sa position", back.is_some_and(|y| (y - 400.0).abs() <= 1.0), format!("scrollY = {back:?}"));

            // Chemin complet : sélection de zone, élément sous la souris dans l'overlay, capture défilante lancée
            // depuis l'overlay (qui reste affiché, retiré des captures), puis la page entière dans l'éditeur.
            let before = app().library.lock().unwrap().list(&crate::library_folder()).len();
            tauri::async_runtime::spawn(async { capture::start_capture("region", false).await });
            let shown = until(Duration::from_secs(5), || visible_overlay().is_some()).await;
            if let (true, Some((index, [ox, oy, _, _], overlay))) = (shown, visible_overlay()) {
                tokio::time::sleep(Duration::from_millis(300)).await;
                // la souris passe sur la page : l'overlay cherche ce qui est dessous et propose le bouton
                let (ix, iy) = ((x - ox as f64).round() as i32, (y - oy as f64).round() as i32);
                let mut button = None;
                let started = Instant::now();
                while button.is_none() && started.elapsed() < Duration::from_secs(5) {
                    post_mouse(overlay, 0x0200, ix, iy);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    button = overlay::scroll_button(index).await;
                }
                check("overlay : le bouton « Capturer toute la page » apparaît sur la page", button.is_some(), format!("{} ms", started.elapsed().as_millis()));
                screenshot("7-overlay-page.png");
                if let Some([bx, by, bw, bh]) = button {
                    let (cx, cy) = ((bx + bw / 2.0).round() as i32, (by + bh / 2.0).round() as i32);
                    let started = Instant::now();
                    post_mouse(overlay, 0x0200, cx, cy);
                    post_mouse(overlay, 0x0201, cx, cy);
                    post_mouse(overlay, 0x0202, cx, cy);
                    until(Duration::from_secs(20), || !capturing()).await;
                    let elapsed = started.elapsed();
                    let list = app().library.lock().unwrap().list(&crate::library_folder());
                    let expected = ((HEADER + BAND * BANDS as f64) * sf).round();
                    let height = list.first().and_then(|i| i["height"].as_f64()).unwrap_or(0.0);
                    check(
                        "overlay : la page entière s'ouvre dans l'éditeur",
                        list.len() == before + 1 && (height - expected).abs() <= 2.0,
                        format!("{height} px de haut, attendu {expected}, {} ms", elapsed.as_millis()),
                    );
                } else {
                    capture::cancel_selection();
                }
            } else {
                check("overlay : sélection ouverte sur la page", false, "");
            }
            until(Duration::from_secs(5), || !capturing()).await;
        }
    }
    let _ = child.kill();
    for w in &hidden {
        let _ = w.show();
    }
}
