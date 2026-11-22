// Page de test de la capture défilante (autotest), ouverte comme dans un navigateur ordinaire : dans un processus à
// part, lancé par l'autotest, et sans rester au premier plan (le défilement par UI Automation active la fenêtre,
// qui passerait alors au-dessus de l'overlay).
// Usage : snapit.exe --test-page <fichier HTML> <x> <y> <largeur> <hauteur> <scrollY>  (pixels logiques)
// Sortie : « ready <fenêtre> » une fois la page affichée (HWND), puis « scrollY <n> » à chaque changement de position.
use std::io::Write;
use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub const ARG: &str = "--test-page";

// La position de défilement remonte par le titre de la page : une page file:// n'a pas accès à l'IPC de Tauri.
const REPORT_SCROLL: &str = "addEventListener('scroll', () => { document.title = 'scrollY ' + Math.round(scrollY); });";

fn say(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn run(context: tauri::Context) {
    let args: Vec<String> = std::env::args().skip_while(|a| a != ARG).skip(1).collect();
    let n = |i: usize| args.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let file = args.first().cloned().unwrap_or_default();
    let (x, y, w, h, scroll_y) = (n(1), n(2), n(3), n(4), n(5));
    let url = format!("file:///{}", file.replace('\\', "/"));
    tauri::Builder::default()
        .setup(move |app| {
            // profil WebView2 à part : la page ne partage rien avec le Snapit testé
            let data = std::env::temp_dir().join("snapit-selftest").join("page-webview");
            WebviewWindowBuilder::new(app, "page", WebviewUrl::External(url.parse()?))
                .data_directory(data)
                .decorations(false)
                .resizable(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .focused(false)
                .position(x, y)
                .inner_size(w, h)
                .initialization_script(REPORT_SCROLL)
                .on_document_title_changed(|_, title| {
                    if title.starts_with("scrollY ") {
                        say(&title);
                    }
                })
                .on_page_load(move |window, payload| {
                    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        return;
                    }
                    let _ = window.eval(format!("scrollTo(0, {scroll_y})"));
                    let window = window.clone();
                    std::thread::spawn(move || {
                        // au premier plan le temps d'arriver devant les autres fenêtres…
                        std::thread::sleep(Duration::from_millis(350));
                        let _ = window.set_always_on_top(false); // … où elle reste
                        if let Some(hwnd) = crate::win::hwnd_value(&window) {
                            say(&format!("ready {hwnd}"));
                        }
                    });
                })
                .build()?;
            Ok(())
        })
        .build(context)
        .expect("page de test")
        .run(|_, _| {});
}
