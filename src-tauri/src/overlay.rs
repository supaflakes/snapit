// Overlay de sélection natif : une fenêtre Win32 par écran, dessinée en Direct2D. Fond assombri, zone détectée en
// surbrillance, sélection libre, dimensions, loupe, bouton « Capturer toute la page » et avancement de la capture
// défilante.
//
// Toutes les fenêtres vivent sur un fil dédié, avec sa propre boucle de messages : l'affichage ne dépend ni de la
// boucle de Tauri ni de WebView2. Les autres fils lui envoient des commandes (`send`).
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::mem::ManuallyDrop;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::oneshot;
use windows::core::{w, Interface, BOOL};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows_numerics::{Matrix3x2, Vector2};

use crate::capture::{self, Capture};

const ACCENT: Color = Color(143, 114, 255, 1.0);
const ACCENT_HOVER: Color = Color(164, 140, 255, 1.0);
const WHITE: Color = Color(255, 255, 255, 1.0);
const PANEL: Color = Color(20, 20, 26, 0.9);
const BUTTON_HEIGHT: f32 = 34.0;
const LOUPE_SIZE: f32 = 128.0;
const LOUPE_PIXELS: f32 = 15.0; // pixels d'image affichés sur la largeur de la loupe
const MIN_SELECTION: f64 = 4.0;
const DRAG_THRESHOLD: f64 = 4.0; // pixels logiques : au-delà, l'appui devient un glisser (zone libre) plutôt qu'un clic
const MIN_REGION: f64 = 12.0; // pixels logiques : les zones détectées plus petites ne sont pas proposées
const PROBE_DELAY: u32 = 40; // ms de pause de la souris avant de chercher les éléments d'interface sous elle
const WHEEL_STEP: f64 = 50.0; // défilement cumulé pour passer d'une zone à la suivante
// Éléments d'interface qu'on ne propose pas : texte courant, liens, barres de défilement…
const SKIPPED_TYPES: [&str; 7] = ["Text", "Hyperlink", "ScrollBar", "Thumb", "Separator", "TitleBar", "ToolTip"];

const WM_COMMANDS: u32 = WM_APP + 1; // message du fil : des commandes attendent
const PROBE_TIMER: usize = 1;
const RECOMPOSE_TIMER: usize = 2;
const WM_MOUSELEAVE: u32 = 0x02A3;
// Touche virtuelle non attribuée, envoyée pour que Windows autorise l'overlay à prendre le clavier.
const VK_NEUTRAL: u16 = 0xE8;

/// Textes de l'overlay, dans la langue de l'interface.
#[derive(Clone, Default)]
pub struct Labels {
    pub hint: String,
    pub scroll_page: String,
    pub scroll_area: String,
    pub scrolling: String,
    pub scroll_stop: String,
}

/// Affichage d'un écran au début d'une sélection.
pub struct Show {
    pub index: usize, // écran (rang dans la sélection)
    pub session: u64,
    pub capture: Arc<Capture>,
    pub windows: Value, // fenêtres visibles sur l'écran (pixels de l'image), null : détection désactivée
    pub labels: Labels,
    pub cursor: Option<(f64, f64)>, // souris sur cet écran (pixels de l'image)
}

enum Command {
    Show(Box<Show>, oneshot::Sender<()>),
    Focus(usize),
    Hide(usize),
    HideAll,
    Excluded(usize, bool),
    Progress(usize, f64),
    Probed { index: usize, session: u64, hwnd: i64, at: (f64, f64), found: Value },
    ScrollButton(usize, oneshot::Sender<Option<[f64; 4]>>),
    Release,
    Destroy,
    Recompose([i32; 4]),
}

struct Channel {
    tx: Mutex<Sender<Command>>,
    thread: u32,
}

static CHANNEL: OnceLock<Channel> = OnceLock::new();
// Overlays affichés : (écran, position et taille en pixels physiques, HWND)
static VISIBLE: Mutex<Vec<(usize, [i32; 4], isize)>> = Mutex::new(Vec::new());

fn channel_() -> &'static Channel {
    CHANNEL.get_or_init(|| {
        let (tx, rx) = channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("overlay".into())
            .spawn(move || run(rx, ready_tx))
            .expect("fil de l'overlay");
        let thread = ready_rx.recv().unwrap_or(0);
        Channel { tx: Mutex::new(tx), thread }
    })
}

fn send(command: Command) {
    let c = channel_();
    let _ = c.tx.lock().unwrap().send(command);
    unsafe {
        let _ = PostThreadMessageW(c.thread, WM_COMMANDS, WPARAM(0), LPARAM(0));
    }
}

// ------------------------------------------------------------------------------------------- API

/// Démarre le fil de l'overlay et prépare Direct2D, pour que la première sélection s'affiche sans attendre.
pub fn prepare() {
    channel_();
}

/// Affiche l'écran `show.index` ; le canal répond une fois l'image à l'écran.
pub fn show(show: Show) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    send(Command::Show(Box::new(show), tx));
    rx
}

/// Donne le clavier (Entrée, flèches, Échap) à l'overlay de cet écran.
pub fn focus(index: usize) {
    send(Command::Focus(index));
}

pub fn hide(index: usize) {
    send(Command::Hide(index));
}

/// Fin de la sélection : les overlays sont cachés et libèrent leur image ; les fenêtres restent prêtes.
pub fn hide_all() {
    VISIBLE.lock().unwrap().clear();
    send(Command::HideAll);
}

/// Retire l'overlay des captures d'écran (capture défilante) ou l'y remet.
pub fn set_excluded(index: usize, excluded: bool) {
    send(Command::Excluded(index, excluded));
}

/// Avancement de la capture défilante, de 0 à 1.
pub fn progress(index: usize, value: f64) {
    send(Command::Progress(index, value));
}

/// Libère les surfaces de dessin (longue période sans capture) ; elles sont recréées à la sélection suivante.
pub fn release() {
    send(Command::Release);
}

/// Oblige Windows à recomposer l'écran [x, y, l, h] (pixels physiques), sans rien y changer de visible : une fenêtre
/// d'un pixel, quasi transparente et retirée des captures, y apparaît un instant. Retirer nos fenêtres de la capture
/// ne change pas l'écran ; sans recomposition, la duplication du bureau ne fournirait pas d'image sans elles.
pub fn recompose(rect: [i32; 4]) {
    send(Command::Recompose(rect));
}

/// Détruit les fenêtres (changement d'écrans) ; elles sont recréées à la sélection suivante.
pub fn destroy() {
    send(Command::Destroy);
}

pub fn is_visible() -> bool {
    !VISIBLE.lock().unwrap().is_empty()
}

/// Premier overlay affiché : (écran, position et taille en pixels physiques, HWND).
pub fn visible() -> Option<(usize, [i32; 4], isize)> {
    VISIBLE.lock().unwrap().first().copied()
}

/// Bouton « Capturer toute la page » de cet écran, s'il est affiché (pixels physiques de la fenêtre).
pub async fn scroll_button(index: usize) -> Option<[f64; 4]> {
    let (tx, rx) = oneshot::channel();
    send(Command::ScrollButton(index, tx));
    rx.await.ok().flatten()
}

// ------------------------------------------------------------------------------------------- zones

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Screen,
    Window,
    Other,
}

/// Zone en pixels de l'image.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Zone {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    kind: Kind,
    scroll: i64, // élément qui défile (UI Automation), 0 sinon
    page: bool,  // page web
    parent: i64, // sous-fenêtres : rang du parent, -1 pour la fenêtre
}

impl Zone {
    fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Zone { x, y, w, h, kind: Kind::Other, scroll: 0, page: false, parent: -1 }
    }
    fn from(v: &Value) -> Option<Self> {
        let r = v.as_array()?;
        let n = |i: usize| r.get(i).and_then(Value::as_f64);
        let mut z = Zone::new(n(0)?, n(1)?, n(2)?, n(3)?);
        z.parent = r.get(4).and_then(Value::as_i64).unwrap_or(-1);
        Some(z)
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
    fn same_rect(&self, o: &Zone) -> bool {
        self.x == o.x && self.y == o.y && self.w == o.w && self.h == o.h
    }
}

fn near(a: &Zone, b: &Zone, tolerance: f64) -> bool {
    (a.x - b.x).abs() <= tolerance
        && (a.y - b.y).abs() <= tolerance
        && (a.x + a.w - b.x - b.w).abs() <= tolerance
        && (a.y + a.h - b.y - b.h).abs() <= tolerance
}

struct Win {
    hwnd: i64,
    frame: Zone,
    client: Option<Zone>,
    children: Vec<Option<Zone>>,
}

fn windows_from(v: &Value) -> Option<Vec<Win>> {
    let list = v.as_array()?;
    Some(
        list.iter()
            .filter_map(|w| {
                let mut frame = Zone::from(w.get("frame")?)?;
                frame.kind = Kind::Window;
                Some(Win {
                    hwnd: w.get("hwnd").and_then(Value::as_i64).unwrap_or(0),
                    frame,
                    client: w.get("client").and_then(Zone::from),
                    children: w.get("children").and_then(Value::as_array).map(|c| c.iter().map(Zone::from).collect()).unwrap_or_default(),
                })
            })
            .collect(),
    )
}

/// Rectangle en pixels logiques (DIP) de la fenêtre.
#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn contains(&self, p: (f64, f64)) -> bool {
        p.0 >= self.x && p.1 >= self.y && p.0 < self.x + self.w && p.1 < self.y + self.h
    }
}

struct Button {
    rect: Rect,
    label: String,
}

// ------------------------------------------------------------------------------------------- état d'une sélection

struct Selection {
    session: u64,
    capture: Arc<Capture>,
    labels: Labels,
    width: f64,  // taille de la fenêtre en pixels logiques
    height: f64, // (pixels physiques / échelle de l'écran)
    scale: f64,  // pixels de l'image par pixel logique
    active: bool,
    mouse: Option<(f64, f64)>,
    start: Option<(f64, f64)>,
    dragging: bool,
    selection: Option<Rect>,
    windows: Option<Vec<Win>>,
    elements: HashMap<i64, Vec<Zone>>, // fenêtre -> éléments d'interface déjà trouvés sous la souris
    chain: Vec<Zone>,                  // zones imbriquées sous la souris, de l'écran entier à la plus petite
    pinned: Option<Zone>,              // zone choisie à la molette, gardée tant que la souris reste dedans
    hovered: Option<Zone>,             // zone en surbrillance, capturée d'un clic
    probing: bool,
    wheel: f64,
    focus_asked: bool,
    scroll_target: Option<Zone>,
    scroll_button: Option<Button>,
    over_button: bool,
    pressed_button: bool,
    scrolling: Option<(Zone, f64)>, // capture défilante en cours : zone et avancement
}

impl Selection {
    fn image_w(&self) -> f64 {
        self.capture.physical[2] as f64
    }
    fn image_h(&self) -> f64 {
        self.capture.physical[3] as f64
    }
    fn to_image(&self, p: (f64, f64)) -> (f64, f64) {
        (p.0 * self.scale, p.1 * self.scale)
    }
    fn to_dip(&self, z: &Zone) -> Rect {
        Rect { x: z.x / self.scale, y: z.y / self.scale, w: z.w / self.scale, h: z.h / self.scale }
    }
    fn rect_from(&self, a: (f64, f64), b: (f64, f64)) -> Rect {
        let x1 = a.0.min(b.0).max(0.0);
        let y1 = a.1.min(b.1).max(0.0);
        let x2 = a.0.max(b.0).min(self.width);
        let y2 = a.1.max(b.1).min(self.height);
        Rect { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }

    // Zones sous le point p (pixels de l'image), de l'écran entier à la plus petite : la fenêtre la plus haute,
    // sa zone cliente, ses sous-fenêtres et les éléments d'interface déjà trouvés, sans doublons.
    fn compute_chain(&self, p: (f64, f64)) -> Vec<Zone> {
        let mut screen = Zone::new(0.0, 0.0, self.image_w(), self.image_h());
        screen.kind = Kind::Screen;
        let Some(win) = self.windows.as_ref().and_then(|list| list.iter().find(|w| w.frame.contains(p.0, p.1))) else { return vec![screen] };

        let mut found = vec![win.frame];
        if let Some(client) = win.client.filter(|c| c.contains(p.0, p.1)) {
            found.push(client);
        }
        // sous-fenêtres : à chaque niveau, la plus haute qui contient le point
        let mut parent = -1;
        loop {
            let Some(i) = win.children.iter().position(|c| c.is_some_and(|c| c.parent == parent && c.contains(p.0, p.1))) else { break };
            found.push(win.children[i].unwrap());
            parent = i as i64;
        }
        if let Some(list) = self.elements.get(&win.hwnd) {
            found.extend(list.iter().filter(|e| e.contains(p.0, p.1)).copied());
        }

        let f = win.frame;
        let min = MIN_REGION * self.scale;
        let mut clipped: Vec<Zone> = found
            .into_iter()
            .map(|r| {
                // dans les limites de la fenêtre
                let x = r.x.max(f.x);
                let y = r.y.max(f.y);
                Zone { x, y, w: (r.x + r.w).min(f.x + f.w) - x, h: (r.y + r.h).min(f.y + f.h) - y, ..r }
            })
            .filter(|r| r.w >= min && r.h >= min)
            .collect();
        clipped.sort_by(|a, b| (b.w * b.h).partial_cmp(&(a.w * a.h)).unwrap_or(std::cmp::Ordering::Equal));
        let mut list = vec![screen];
        let tolerance = 2.0 * self.scale;
        for r in clipped {
            match list.iter_mut().find(|q| near(q, &r, tolerance)) {
                None => list.push(r),
                Some(same) if r.scroll != 0 && same.scroll == 0 => {
                    // même zone : elle défile
                    same.scroll = r.scroll;
                    same.page = r.page;
                }
                Some(_) => {}
            }
        }
        list
    }

    fn update_hover(&mut self, ctx: &Resources) {
        match (self.windows.is_some(), self.mouse) {
            (true, Some(mouse)) => {
                let p = self.to_image(mouse);
                self.chain = self.compute_chain(p);
                let kept = self.pinned.filter(|z| z.contains(p.0, p.1)).and_then(|pinned| self.chain.iter().find(|r| near(r, &pinned, 0.5)).copied());
                self.pinned = kept;
                self.hovered = kept.or(self.chain.last().copied());
            }
            _ => {
                self.chain.clear();
                self.hovered = None;
            }
        }
        self.update_scroll_target(ctx);
    }

    fn hovered_index(&self) -> Option<usize> {
        let h = self.hovered?;
        self.chain.iter().position(|z| z.same_rect(&h))
    }

    // Zone qui défile liée à la zone en surbrillance : elle-même ou la plus petite zone qui défile autour d'elle (la
    // page autour d'un paragraphe), sinon la plus grande qui défile à l'intérieur (la page d'une fenêtre).
    fn update_scroll_target(&mut self, ctx: &Resources) {
        let mut target = None;
        if let Some(i) = self.hovered_index() {
            target = self.chain[..=i].iter().rev().find(|z| z.scroll != 0).copied();
            if target.is_none() && i > 0 {
                target = self.chain[i + 1..].iter().find(|z| z.scroll != 0).copied();
            }
        }
        self.scroll_target = target;
        self.scroll_button = target.and_then(|z| self.button_for(&z, ctx));
        self.over_button = matches!((&self.scroll_button, self.mouse), (Some(b), Some(m)) if b.rect.contains(m));
    }

    // Bouton en bas de la zone, s'il y a la place
    fn button_for(&self, zone: &Zone, ctx: &Resources) -> Option<Button> {
        let label = if zone.page { &self.labels.scroll_page } else { &self.labels.scroll_area };
        if label.is_empty() {
            return None;
        }
        let z = self.to_dip(zone);
        let w = (ctx.text_width(label, true).ceil() + 48.0) as f64;
        if z.w < w + 24.0 || z.h < BUTTON_HEIGHT as f64 * 3.0 {
            return None;
        }
        let rect = Rect { x: (z.x + (z.w - w) / 2.0).round(), y: (z.y + z.h - BUTTON_HEIGHT as f64 - 18.0).round(), w, h: BUTTON_HEIGHT as f64 };
        Some(Button { rect, label: label.clone() })
    }

    // Molette ou flèches : zone englobante (-1) ou plus petite (+1), gardée tant que la souris reste dedans.
    fn change_level(&mut self, step: i32, ctx: &Resources) {
        if self.chain.is_empty() || self.start.is_some() {
            return;
        }
        let i = self.hovered_index().unwrap_or(0) as i32;
        let next = (i + step).clamp(0, self.chain.len() as i32 - 1) as usize;
        self.hovered = Some(self.chain[next]);
        self.pinned = if next == self.chain.len() - 1 { None } else { self.hovered };
        self.update_scroll_target(ctx);
    }

    // Zone en surbrillance (sinon l'écran entier), en fractions de l'image
    fn hovered_fraction(&self) -> Value {
        let (w, h) = (self.image_w(), self.image_h());
        let r = self.hovered.unwrap_or(Zone::new(0.0, 0.0, w, h));
        json!({ "x": r.x / w, "y": r.y / h, "w": r.w / w, "h": r.h / h })
    }
}

// ------------------------------------------------------------------------------------------- fenêtres

struct Overlay {
    hwnd: HWND,
    rect: [i32; 4],
    target: Option<ID2D1HwndRenderTarget>,
    brush: Option<ID2D1SolidColorBrush>,
    bitmap: Option<ID2D1Bitmap>,
    sel: Option<Selection>,
}

struct Resources {
    d2d: ID2D1Factory,
    dwrite: IDWriteFactory,
    text: IDWriteTextFormat,
    bold: IDWriteTextFormat,
    dashed: ID2D1StrokeStyle,
    round: ID2D1StrokeStyle,
}

impl Resources {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let d2d: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let dwrite: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            let format = |weight, size| -> windows::core::Result<IDWriteTextFormat> {
                let f = dwrite.CreateTextFormat(w!("Segoe UI Variable Text"), None, weight, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, w!(""))?;
                f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
                f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
                Ok(f)
            };
            let text = format(DWRITE_FONT_WEIGHT_NORMAL, 12.0)?;
            let bold = format(DWRITE_FONT_WEIGHT_SEMI_BOLD, 13.0)?;
            let stroke = |cap, dashes: Option<&[f32]>| {
                let props = D2D1_STROKE_STYLE_PROPERTIES {
                    startCap: cap,
                    endCap: cap,
                    dashCap: D2D1_CAP_STYLE_FLAT,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    dashStyle: if dashes.is_some() { D2D1_DASH_STYLE_CUSTOM } else { D2D1_DASH_STYLE_SOLID },
                    dashOffset: 0.0,
                };
                d2d.CreateStrokeStyle(&props, dashes)
            };
            let dashed = stroke(D2D1_CAP_STYLE_FLAT, Some(&[4.0, 4.0]))?;
            let round = stroke(D2D1_CAP_STYLE_ROUND, None)?;
            Ok(Resources { d2d, dwrite, text, bold, dashed, round })
        }
    }

    fn layout(&self, text: &str, bold: bool, height: f32) -> Option<(IDWriteTextLayout, f32)> {
        let utf16: Vec<u16> = text.encode_utf16().collect();
        unsafe {
            let layout = self.dwrite.CreateTextLayout(&utf16, if bold { &self.bold } else { &self.text }, 10_000.0, height).ok()?;
            let mut m = DWRITE_TEXT_METRICS::default();
            layout.GetMetrics(&mut m).ok()?;
            Some((layout, m.widthIncludingTrailingWhitespace))
        }
    }

    fn text_width(&self, text: &str, bold: bool) -> f32 {
        self.layout(text, bold, 30.0).map(|(_, w)| w).unwrap_or(0.0)
    }
}

struct Thread {
    res: Resources,
    overlays: HashMap<usize, Overlay>,
}

thread_local! {
    static STATE: RefCell<Option<Thread>> = const { RefCell::new(None) };
    static RECOMPOSE: std::cell::Cell<isize> = const { std::cell::Cell::new(0) }; // fenêtre d'un pixel
}

// Fenêtre d'un pixel de `recompose` : elle disparaît d'elle-même peu après.
unsafe extern "system" fn recompose_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TIMER && wparam.0 == RECOMPOSE_TIMER {
        let _ = KillTimer(Some(hwnd), RECOMPOSE_TIMER);
        let _ = ShowWindow(hwnd, SW_HIDE);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn create_recompose_window(instance: HINSTANCE) {
    unsafe {
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(recompose_proc),
            hInstance: instance,
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(windows::Win32::Graphics::Gdi::GetStockObject(windows::Win32::Graphics::Gdi::BLACK_BRUSH).0),
            lpszClassName: w!("SnapitRecompose"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        let hwnd = CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
            w!("SnapitRecompose"),
            w!(""),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance),
            None,
        );
        if let Ok(hwnd) = hwnd {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA);
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            RECOMPOSE.with(|r| r.set(hwnd.0 as isize));
        }
    }
}

fn run(rx: Receiver<Command>, ready: std::sync::mpsc::Sender<u32>) {
    unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE); // crée la file de messages du fil
        let instance = GetModuleHandleW(None).map(|h| HINSTANCE(h.0)).unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            hCursor: LoadCursorW(None, IDC_CROSS).unwrap_or_default(),
            lpszClassName: w!("SnapitSelection"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        create_recompose_window(instance);
        match Resources::new() {
            Ok(res) => STATE.with(|s| *s.borrow_mut() = Some(Thread { res, overlays: HashMap::new() })),
            Err(e) => eprintln!("overlay : Direct2D indisponible ({e})"),
        }
        let _ = ready.send(GetCurrentThreadId());
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.hwnd.is_invalid() && msg.message == WM_COMMANDS {
                while let Ok(command) = rx.try_recv() {
                    with_state(|t| t.command(command));
                }
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

// L'état du fil, s'il n'est pas déjà en cours d'utilisation : certains appels Windows (affichage, focus) envoient des
// messages à la fenêtre pendant qu'on la manipule ; ils suivent alors le traitement par défaut.
fn with_state<R>(f: impl FnOnce(&mut Thread) -> R) -> Option<R> {
    STATE.with(|s| s.try_borrow_mut().ok().and_then(|mut s| s.as_mut().map(f)))
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let point = || {
        let x = (lparam.0 & 0xffff) as i16 as f64;
        let y = ((lparam.0 >> 16) & 0xffff) as i16 as f64;
        (x, y)
    };
    let handled = match msg {
        WM_ERASEBKGND => return LRESULT(1),
        WM_DPICHANGED => return LRESULT(0), // la fenêtre garde la taille de son écran
        WM_MOUSEACTIVATE => return LRESULT(MA_ACTIVATE as isize),
        WM_PAINT => with_state(|t| t.paint(hwnd)).is_some(),
        WM_SETCURSOR if (lparam.0 & 0xffff) as u32 == HTCLIENT => with_state(|t| t.set_cursor(hwnd)).is_some(),
        WM_MOUSEMOVE => with_state(|t| t.on_mouse(hwnd, Mouse::Move, point())).is_some(),
        WM_LBUTTONDOWN => with_state(|t| t.on_mouse(hwnd, Mouse::Down, point())).is_some(),
        WM_LBUTTONUP => with_state(|t| t.on_mouse(hwnd, Mouse::Up, point())).is_some(),
        WM_RBUTTONDOWN => with_state(|t| t.on_mouse(hwnd, Mouse::Right, point())).is_some(),
        WM_MOUSELEAVE => with_state(|t| t.on_mouse(hwnd, Mouse::Leave, (0.0, 0.0))).is_some(),
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) & 0xffff) as i16 as f64;
            with_state(|t| t.on_wheel(hwnd, delta)).is_some()
        }
        WM_KEYDOWN => with_state(|t| t.on_key(hwnd, wparam.0 as u16)).is_some(),
        WM_TIMER if wparam.0 == PROBE_TIMER => {
            let _ = KillTimer(Some(hwnd), PROBE_TIMER);
            with_state(|t| t.probe(hwnd)).is_some()
        }
        WM_ACTIVATE => {
            if (wparam.0 & 0xffff) as u32 == WA_INACTIVE {
                with_state(|t| {
                    if let Some(s) = t.find(hwnd).and_then(|(_, o)| o.sel.as_mut()) {
                        s.focus_asked = false;
                    }
                });
            }
            false
        }
        _ => false,
    };
    if handled && msg != WM_ACTIVATE {
        return LRESULT(if msg == WM_SETCURSOR { 1 } else { 0 });
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

#[derive(Clone, Copy, PartialEq)]
enum Mouse {
    Move,
    Down,
    Up,
    Right,
    Leave,
}

fn redraw(hwnd: HWND) {
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, false);
    }
}

fn cloak(hwnd: HWND, cloaked: bool) {
    let value = BOOL::from(cloaked);
    unsafe {
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, &value as *const BOOL as _, std::mem::size_of::<BOOL>() as u32);
    }
}

// Met la fenêtre au premier plan. Windows ne l'autorise qu'au processus qui a reçu la dernière saisie : une touche
// neutre est envoyée si nécessaire (comme le fait Tauri pour ses fenêtres).
fn bring_to_front(hwnd: HWND) {
    unsafe {
        if GetForegroundWindow() == hwnd {
            return;
        }
        if !SetForegroundWindow(hwnd).as_bool() || GetForegroundWindow() != hwnd {
            let key = |flags| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(VK_NEUTRAL), dwFlags: flags, ..Default::default() } },
            };
            SendInput(&[key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32);
            let _ = SetForegroundWindow(hwnd);
        }
        let _ = SetFocus(Some(hwnd));
    }
}

fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) {
    tauri::async_runtime::spawn(f);
}

impl Thread {
    fn find(&mut self, hwnd: HWND) -> Option<(usize, &mut Overlay)> {
        self.overlays.iter_mut().find(|(_, o)| o.hwnd == hwnd).map(|(i, o)| (*i, o))
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Show(show, ack) => {
                self.show(*show);
                let _ = ack.send(());
            }
            Command::Focus(index) => {
                if let Some(o) = self.overlays.get(&index).filter(|o| o.sel.is_some()) {
                    bring_to_front(o.hwnd);
                }
            }
            Command::Hide(index) => {
                if let Some(o) = self.overlays.get(&index) {
                    unsafe {
                        let _ = ShowWindow(o.hwnd, SW_HIDE);
                    }
                }
                VISIBLE.lock().unwrap().retain(|(i, _, _)| *i != index);
            }
            Command::HideAll => {
                for o in self.overlays.values_mut() {
                    unsafe {
                        let _ = KillTimer(Some(o.hwnd), PROBE_TIMER);
                        let _ = ShowWindow(o.hwnd, SW_HIDE);
                        let _ = SetWindowDisplayAffinity(o.hwnd, WDA_NONE);
                    }
                    o.sel = None;
                    o.bitmap = None; // l'image de l'écran n'est pas gardée entre deux sélections
                }
            }
            Command::Excluded(index, excluded) => {
                if let Some(o) = self.overlays.get(&index) {
                    unsafe {
                        let _ = SetWindowDisplayAffinity(o.hwnd, if excluded { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
                    }
                }
            }
            Command::Progress(index, value) => {
                if let Some(o) = self.overlays.get_mut(&index) {
                    if let Some((_, progress)) = o.sel.as_mut().and_then(|s| s.scrolling.as_mut()) {
                        *progress = value.clamp(0.0, 1.0).max(*progress);
                        redraw(o.hwnd);
                    }
                }
            }
            Command::Probed { index, session, hwnd, at, found } => self.probed(index, session, hwnd, at, found),
            Command::ScrollButton(index, reply) => {
                let button = self.overlays.get(&index).and_then(|o| {
                    let s = o.sel.as_ref()?;
                    let b = s.scroll_button.as_ref()?;
                    let k = s.capture.scale;
                    Some([b.rect.x * k, b.rect.y * k, b.rect.w * k, b.rect.h * k])
                });
                let _ = reply.send(button);
            }
            Command::Release => {
                for o in self.overlays.values_mut().filter(|o| o.sel.is_none()) {
                    o.bitmap = None;
                    o.brush = None;
                    o.target = None;
                }
                self.renew_factory();
            }
            Command::Recompose([x, y, _, _]) => {
                let hwnd = HWND(RECOMPOSE.with(|r| r.get()) as _);
                if !hwnd.is_invalid() {
                    unsafe {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, 1, 1, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                        SetTimer(Some(hwnd), RECOMPOSE_TIMER, 200, None);
                    }
                }
            }
            Command::Destroy => {
                for (_, o) in self.overlays.drain() {
                    unsafe {
                        let _ = DestroyWindow(o.hwnd);
                    }
                }
                self.renew_factory();
            }
        }
    }

    // La fabrique Direct2D garde son périphérique graphique et ses caches tant qu'elle existe : quand plus aucune
    // surface de dessin n'est utilisée, elle est remplacée par une neuve, qui ne réserve rien avant le premier dessin.
    fn renew_factory(&mut self) {
        if self.overlays.values().all(|o| o.target.is_none()) {
            if let Ok(res) = Resources::new() {
                self.res = res;
            }
        }
    }

    fn show(&mut self, show: Show) {
        let Show { index, session, capture, windows, labels, cursor } = show;
        let [x, y, w, h] = capture.physical;
        let dpi = (96.0 * capture.scale) as f32;
        if !self.overlays.contains_key(&index) {
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    w!("SnapitSelection"),
                    w!("Snapit — sélection"),
                    WS_POPUP,
                    x,
                    y,
                    w,
                    h,
                    None,
                    None,
                    GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0)),
                    None,
                )
            };
            let Ok(hwnd) = hwnd else { return };
            self.overlays.insert(index, Overlay { hwnd, rect: [x, y, w, h], target: None, brush: None, bitmap: None, sel: None });
        }
        let res = &self.res;
        let o = self.overlays.get_mut(&index).unwrap();
        let hwnd = o.hwnd;
        unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
        }
        if o.rect != [x, y, w, h] {
            o.rect = [x, y, w, h];
            if let Some(t) = &o.target {
                unsafe {
                    let _ = t.Resize(&D2D_SIZE_U { width: w as u32, height: h as u32 });
                }
            }
        }
        o.bitmap = None;
        o.sel = Some(Selection {
            session,
            labels,
            width: w as f64 / capture.scale,
            height: h as f64 / capture.scale,
            scale: capture.scale,
            capture,
            active: true,
            mouse: None,
            start: None,
            dragging: false,
            selection: None,
            windows: windows_from(&windows),
            elements: HashMap::new(),
            chain: Vec::new(),
            pinned: None,
            hovered: None,
            probing: false,
            wheel: 0.0,
            focus_asked: false,
            scroll_target: None,
            scroll_button: None,
            over_button: false,
            pressed_button: false,
            scrolling: None,
        });
        if let Some(t) = &o.target {
            unsafe { t.SetDpi(dpi, dpi) };
        }
        let sel = o.sel.as_mut().unwrap();
        if let Some(c) = cursor {
            // la zone sous la souris est en surbrillance d'emblée, sans attendre qu'elle bouge
            sel.mouse = Some((c.0 / sel.scale, c.1 / sel.scale));
            sel.update_hover(res);
        }
        // Affichée masquée par DWM le temps de dessiner la première image : rien d'autre n'apparaît à l'écran.
        cloak(hwnd, true);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        self.paint(hwnd);
        crate::measure::trace("overlay dessiné");
        cloak(hwnd, false);
        VISIBLE.lock().unwrap().push((index, [x, y, w, h], hwnd.0 as isize));
        if cursor.is_some() {
            self.schedule_probe(index);
        }
    }

    fn paint(&mut self, hwnd: HWND) {
        let res = &self.res;
        let Some((_, o)) = self.overlays.iter_mut().find(|(_, o)| o.hwnd == hwnd) else { return };
        unsafe {
            let _ = ValidateRect(Some(hwnd), None);
        }
        let Some(sel) = o.sel.as_ref() else { return };
        if o.target.is_none() {
            let dpi = (96.0 * sel.capture.scale) as f32;
            let props = D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_IGNORE },
                dpiX: dpi,
                dpiY: dpi,
                usage: D2D1_RENDER_TARGET_USAGE_NONE,
                minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
            };
            let hwnd_props = D2D1_HWND_RENDER_TARGET_PROPERTIES {
                hwnd,
                pixelSize: D2D_SIZE_U { width: o.rect[2] as u32, height: o.rect[3] as u32 },
                presentOptions: D2D1_PRESENT_OPTIONS_IMMEDIATELY,
            };
            let Ok(target) = (unsafe { res.d2d.CreateHwndRenderTarget(&props, &hwnd_props) }) else { return };
            unsafe {
                target.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            }
            o.brush = unsafe { target.CreateSolidColorBrush(&WHITE.into(), None) }.ok();
            o.target = Some(target);
            o.bitmap = None;
        }
        let target = o.target.clone().unwrap();
        if o.bitmap.is_none() {
            let c = &sel.capture;
            let props = D2D1_BITMAP_PROPERTIES {
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_IGNORE },
                dpiX: 96.0,
                dpiY: 96.0,
            };
            let size = D2D_SIZE_U { width: c.physical[2] as u32, height: c.physical[3] as u32 };
            o.bitmap = unsafe { target.CreateBitmap(size, Some(c.bgra.as_ptr() as _), c.physical[2] as u32 * 4, &props) }.ok();
        }
        let (Some(bitmap), Some(brush)) = (o.bitmap.clone(), o.brush.clone()) else { return };
        let painter = Painter { t: &target, brush: &brush, res, bitmap: &bitmap, sel };
        unsafe {
            target.BeginDraw();
            painter.draw();
            if let Err(e) = target.EndDraw(None, None) {
                if e.code() == D2DERR_RECREATE_TARGET {
                    // carte graphique réinitialisée : tout est recréé au dessin suivant
                    o.target = None;
                    o.brush = None;
                    o.bitmap = None;
                    redraw(hwnd);
                }
            }
        }
    }

    fn set_cursor(&mut self, hwnd: HWND) {
        let Some((_, o)) = self.find(hwnd) else { return };
        let id = match o.sel.as_ref() {
            Some(s) if s.scrolling.is_some() => IDC_APPSTARTING,
            Some(s) if s.over_button => IDC_HAND,
            _ => IDC_CROSS,
        };
        unsafe {
            SetCursor(LoadCursorW(None, id).ok());
        }
    }

    fn schedule_probe(&mut self, index: usize) {
        let Some(o) = self.overlays.get(&index) else { return };
        unsafe {
            let _ = KillTimer(Some(o.hwnd), PROBE_TIMER);
        }
        let Some(s) = o.sel.as_ref() else { return };
        if s.windows.is_some() && s.mouse.is_some() && s.start.is_none() && s.scrolling.is_none() {
            unsafe {
                SetTimer(Some(o.hwnd), PROBE_TIMER, PROBE_DELAY, None);
            }
        }
    }

    // Cherche les éléments d'interface sous la souris (barres d'outils, panneaux, page web, images…) : la zone en
    // surbrillance s'affine dès qu'ils arrivent.
    fn probe(&mut self, hwnd: HWND) {
        let Some((index, o)) = self.find(hwnd) else { return };
        let Some(s) = o.sel.as_mut() else { return };
        if s.probing || !s.active || s.start.is_some() || s.scrolling.is_some() {
            return;
        }
        let Some(mouse) = s.mouse else { return };
        let p = s.to_image(mouse);
        let Some(win) = s.windows.as_ref().and_then(|list| list.iter().find(|w| w.frame.contains(p.0, p.1))) else { return };
        let (win_hwnd, session) = (win.hwnd, s.session);
        s.probing = true;
        spawn(async move {
            let found = capture::probe(index, win_hwnd, p.0.round(), p.1.round()).await;
            send(Command::Probed { index, session, hwnd: win_hwnd, at: p, found });
        });
    }

    fn probed(&mut self, index: usize, session: u64, win_hwnd: i64, at: (f64, f64), found: Value) {
        let res = &self.res;
        let Some(o) = self.overlays.get_mut(&index) else { return };
        let hwnd = o.hwnd;
        let Some(s) = o.sel.as_mut().filter(|s| s.session == session) else { return };
        s.probing = false;
        if !s.active || s.scrolling.is_some() {
            return;
        }
        if let Some(items) = found.as_array().filter(|a| !a.is_empty()) {
            let list = s.elements.entry(win_hwnd).or_default();
            for item in items {
                let Some(mut el) = Zone::from(item) else { continue };
                let kind = item.get(4).and_then(Value::as_str).unwrap_or_default();
                el.parent = -1;
                el.scroll = item.get(5).and_then(Value::as_i64).unwrap_or(0);
                el.page = kind == "Document"; // page web
                if !SKIPPED_TYPES.contains(&kind) && !list.iter().any(|e| near(e, &el, 0.0)) {
                    list.push(el);
                }
            }
            if s.start.is_none() && !s.over_button {
                s.update_hover(res); // sur le bouton, la zone reste celle du bouton
            }
            redraw(hwnd);
        }
        // la souris a bougé pendant la recherche : on recommence là où elle est
        let moved = s.start.is_none() && !s.over_button && s.mouse.is_some_and(|m| {
            let q = s.to_image(m);
            (q.0 - at.0).abs() >= 1.0 || (q.1 - at.1).abs() >= 1.0
        });
        if moved {
            self.schedule_probe(index);
        }
    }

    fn on_mouse(&mut self, hwnd: HWND, event: Mouse, physical: (f64, f64)) {
        let res = &self.res;
        let Some((index, o)) = self.overlays.iter_mut().find(|(_, o)| o.hwnd == hwnd).map(|(i, o)| (*i, o)) else { return };
        let Some(s) = o.sel.as_mut() else { return };
        if !s.active || s.scrolling.is_some() {
            return;
        }
        // pixels physiques de la fenêtre -> pixels logiques
        let p = (physical.0 / s.scale, physical.1 / s.scale);
        let mut probe = false;
        match event {
            Mouse::Move => {
                if !s.focus_asked && unsafe { GetForegroundWindow() } != hwnd {
                    s.focus_asked = true; // Entrée et les flèches visent l'écran sous la souris
                    bring_to_front(hwnd);
                }
                let mut track = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                unsafe {
                    let _ = TrackMouseEvent(&mut track);
                }
                s.mouse = Some(p);
                if let Some(start) = s.start {
                    s.dragging |= (p.0 - start.0).hypot(p.1 - start.1) > DRAG_THRESHOLD;
                    if s.dragging {
                        s.selection = Some(s.rect_from(start, p));
                    }
                } else if s.scroll_button.as_ref().is_some_and(|b| b.rect.contains(p)) {
                    s.over_button = true; // sur le bouton, la zone en surbrillance reste celle qu'il capture
                } else {
                    s.update_hover(res);
                    probe = true;
                }
            }
            Mouse::Down => {
                if s.over_button {
                    s.pressed_button = true; // la capture défilante démarre au relâchement, sur le bouton
                    return;
                }
                s.start = Some(p);
                s.mouse = Some(p);
                s.dragging = false;
                s.selection = None;
                unsafe {
                    let _ = KillTimer(Some(hwnd), PROBE_TIMER);
                    SetCapture(hwnd);
                }
            }
            Mouse::Up => {
                unsafe {
                    let _ = ReleaseCapture();
                }
                if s.pressed_button {
                    s.pressed_button = false;
                    if s.over_button {
                        self.start_scroll(index);
                    }
                    return;
                }
                let Some(start) = s.start.take() else { return };
                let r = if s.dragging { Some(s.rect_from(start, p)) } else { None };
                s.dragging = false;
                match r {
                    Some(r) if r.w >= MIN_SELECTION && r.h >= MIN_SELECTION => {
                        let frac = json!({ "x": r.x / s.width, "y": r.y / s.height, "w": r.w / s.width, "h": r.h / s.height });
                        self.finish(index, frac);
                    }
                    _ => {
                        let frac = s.hovered_fraction(); // simple clic : la zone en surbrillance, sinon l'écran entier
                        self.finish(index, frac);
                    }
                }
                return;
            }
            Mouse::Right => {
                // clic droit : annule la zone en cours de tracé, sinon quitte
                if s.start.take().is_some() {
                    s.dragging = false;
                    s.selection = None;
                    unsafe {
                        let _ = ReleaseCapture();
                    }
                } else {
                    self.cancel(index);
                    return;
                }
            }
            Mouse::Leave => {
                if s.start.is_some() {
                    return;
                }
                s.mouse = None;
                s.chain.clear();
                s.hovered = None;
                s.pinned = None;
                s.pressed_button = false;
                s.update_scroll_target(res);
                unsafe {
                    let _ = KillTimer(Some(hwnd), PROBE_TIMER);
                }
            }
        }
        redraw(hwnd);
        if probe {
            self.schedule_probe(index);
        }
    }

    fn on_wheel(&mut self, hwnd: HWND, delta: f64) {
        let res = &self.res;
        let Some((_, o)) = self.overlays.iter_mut().find(|(_, o)| o.hwnd == hwnd) else { return };
        let Some(s) = o.sel.as_mut() else { return };
        if !s.active || s.windows.is_none() || s.start.is_some() || s.scrolling.is_some() {
            return;
        }
        // un cran de molette (120) vaut environ 100 pixels de défilement dans un navigateur ; vers le haut : zone
        // plus grande
        s.wheel -= delta * 100.0 / 120.0;
        if s.wheel.abs() < WHEEL_STEP {
            return;
        }
        s.change_level(if s.wheel < 0.0 { -1 } else { 1 }, res);
        s.wheel = 0.0;
        redraw(hwnd);
    }

    fn on_key(&mut self, hwnd: HWND, key: u16) {
        let res = &self.res;
        let Some((index, o)) = self.overlays.iter_mut().find(|(_, o)| o.hwnd == hwnd).map(|(i, o)| (*i, o)) else { return };
        let Some(s) = o.sel.as_mut() else { return };
        if !s.active {
            return;
        }
        let key = VIRTUAL_KEY(key);
        if key == VK_ESCAPE {
            // pendant la capture défilante : l'arrête, en gardant ce qui est capturé
            if s.scrolling.is_none() {
                s.active = false;
            }
            spawn(async { capture::cancel_selection() });
        } else if s.scrolling.is_some() {
            // rien d'autre pendant la capture défilante
        } else if key == VK_RETURN && s.start.is_none() {
            if s.over_button {
                self.start_scroll(index);
            } else {
                let frac = s.hovered_fraction();
                self.finish(index, frac);
            }
        } else if (key == VK_UP || key == VK_DOWN) && s.windows.is_some() {
            s.change_level(if key == VK_UP { -1 } else { 1 }, res);
            redraw(hwnd);
        }
    }

    fn finish(&mut self, index: usize, frac: Value) {
        if let Some(s) = self.overlays.get_mut(&index).and_then(|o| o.sel.as_mut()) {
            s.active = false;
        }
        spawn(async move { capture::select(index, &frac) });
    }

    fn cancel(&mut self, index: usize) {
        if let Some(s) = self.overlays.get_mut(&index).and_then(|o| o.sel.as_mut()) {
            s.active = false;
        }
        spawn(async { capture::cancel_selection() });
    }

    // Capture défilante de la zone du bouton : l'overlay affiche l'avancement jusqu'à la fin de la capture.
    fn start_scroll(&mut self, index: usize) {
        let Some(o) = self.overlays.get_mut(&index) else { return };
        let hwnd = o.hwnd;
        let Some(s) = o.sel.as_mut() else { return };
        let Some(zone) = s.scroll_target else { return };
        s.scrolling = Some((zone, 0.0));
        s.over_button = false;
        s.pressed_button = false;
        unsafe {
            let _ = KillTimer(Some(hwnd), PROBE_TIMER);
        }
        redraw(hwnd);
        self.set_cursor(hwnd);
        let zone = json!({ "scroll": zone.scroll, "x": zone.x, "y": zone.y, "w": zone.w, "h": zone.h });
        spawn(async move { capture::scroll(index, zone).await });
    }
}

// ------------------------------------------------------------------------------------------- dessin

#[derive(Clone, Copy)]
struct Color(u8, u8, u8, f32);

impl From<Color> for D2D1_COLOR_F {
    fn from(c: Color) -> Self {
        D2D1_COLOR_F { r: c.0 as f32 / 255.0, g: c.1 as f32 / 255.0, b: c.2 as f32 / 255.0, a: c.3 }
    }
}

fn rf(x: f64, y: f64, w: f64, h: f64) -> D2D_RECT_F {
    D2D_RECT_F { left: x as f32, top: y as f32, right: (x + w) as f32, bottom: (y + h) as f32 }
}

fn rounded(x: f64, y: f64, w: f64, h: f64, r: f64) -> D2D1_ROUNDED_RECT {
    D2D1_ROUNDED_RECT { rect: rf(x, y, w, h), radiusX: r as f32, radiusY: r as f32 }
}

fn v2(x: f64, y: f64) -> Vector2 {
    Vector2 { X: x as f32, Y: y as f32 }
}

struct Painter<'a> {
    t: &'a ID2D1HwndRenderTarget,
    brush: &'a ID2D1SolidColorBrush,
    res: &'a Resources,
    bitmap: &'a ID2D1Bitmap,
    sel: &'a Selection,
}

impl Painter<'_> {
    fn color(&self, c: Color) -> &ID2D1SolidColorBrush {
        unsafe { self.brush.SetColor(&c.into()) };
        self.brush
    }

    fn fill(&self, r: D2D_RECT_F, c: Color) {
        unsafe { self.t.FillRectangle(&r, self.color(c)) };
    }

    fn fill_rounded(&self, r: D2D1_ROUNDED_RECT, c: Color) {
        unsafe { self.t.FillRoundedRectangle(&r, self.color(c)) };
    }

    fn stroke(&self, r: D2D_RECT_F, c: Color, width: f64, style: Option<&ID2D1StrokeStyle>) {
        unsafe { self.t.DrawRectangle(&r, self.color(c), width as f32, style) };
    }

    fn line(&self, a: (f64, f64), b: (f64, f64), c: Color, width: f64, style: Option<&ID2D1StrokeStyle>) {
        unsafe { self.t.DrawLine(v2(a.0, a.1), v2(b.0, b.1), self.color(c), width as f32, style) };
    }

    // Ombre portée floue (comme shadowBlur du canvas), faite de rectangles arrondis de plus en plus grands
    fn shadow(&self, x: f64, y: f64, w: f64, h: f64, radius: f64, blur: f64, alpha: f32, dy: f64) {
        let sigma = blur / 2.0;
        const STEPS: usize = 10;
        for i in 0..STEPS {
            let e = -0.5 * sigma + 2.5 * sigma * (i as f64 + 0.5) / STEPS as f64;
            if w + 2.0 * e <= 0.0 || h + 2.0 * e <= 0.0 {
                continue;
            }
            self.fill_rounded(rounded(x - e, y + dy - e, w + 2.0 * e, h + 2.0 * e, (radius + e).max(0.0)), Color(0, 0, 0, alpha / STEPS as f32 * 0.8));
        }
    }

    fn text(&self, text: &str, bold: bool, x: f64, top: f64, height: f64, c: Color) {
        if let Some((layout, _)) = self.res.layout(text, bold, height as f32) {
            unsafe { self.t.DrawTextLayout(v2(x, top + 0.5), &layout, self.color(c), D2D1_DRAW_TEXT_OPTIONS_NONE) };
        }
    }

    fn pill(&self, text: &str, x: f64, y: f64, center: bool) {
        let s = self.sel;
        let w = self.res.text_width(text, false) as f64 + 16.0;
        let h = 24.0;
        let left = if center { x - w / 2.0 } else { x };
        let left = left.min(s.width - w - 4.0).max(4.0);
        let top = y.min(s.height - h - 4.0).max(4.0);
        self.fill_rounded(rounded(left, top, w, h, 6.0), PANEL);
        self.text(text, false, left + 8.0, top, h, WHITE);
    }

    // Assombrit l'écran, sauf `hole`
    fn dim(&self, hole: Option<Rect>) {
        let s = self.sel;
        let c = Color(6, 6, 10, 0.5);
        let Some(hole) = hole else { return self.fill(rf(0.0, 0.0, s.width, s.height), c) };
        let x1 = hole.x.clamp(0.0, s.width);
        let y1 = hole.y.clamp(0.0, s.height);
        let x2 = (hole.x + hole.w).clamp(x1, s.width);
        let y2 = (hole.y + hole.h).clamp(y1, s.height);
        self.fill(rf(0.0, 0.0, s.width, y1), c);
        self.fill(rf(0.0, y2, s.width, s.height - y2), c);
        self.fill(rf(0.0, y1, x1, y2 - y1), c);
        self.fill(rf(x2, y1, s.width - x2, y2 - y1), c);
    }

    // cadre à l'intérieur de la zone : visible même pour une fenêtre plein écran
    fn frame_spot(&self, r: Rect) {
        self.stroke(rf(r.x + 1.5, r.y + 1.5, r.w - 3.0, r.h - 3.0), ACCENT, 3.0, None);
    }

    fn loupe(&self, label: Option<String>) {
        let s = self.sel;
        let Some(mouse) = s.mouse else { return };
        let (ix, iy) = s.to_image(mouse);
        let half = LOUPE_PIXELS as f64 / 2.0;
        let size = LOUPE_SIZE as f64;
        let cell = size / LOUPE_PIXELS as f64;

        let mut x = mouse.0 + 24.0;
        let mut y = mouse.1 + 24.0;
        if x + size > s.width - 8.0 {
            x = mouse.0 - 24.0 - size;
        }
        if y + size + 30.0 > s.height - 8.0 {
            y = mouse.1 - 24.0 - size - 30.0;
        }

        self.shadow(x, y, size, size, 10.0, 16.0, 0.45, 0.0);
        let frame = rounded(x, y, size, size, 10.0);
        self.fill_rounded(frame, Color(0, 0, 0, 1.0));

        unsafe {
            // pixels agrandis, coupés aux coins arrondis
            let mask: Option<ID2D1Geometry> = self.res.d2d.CreateRoundedRectangleGeometry(&frame).ok().and_then(|g| g.cast().ok());
            let layer = self.t.CreateLayer(None).ok();
            if let (Some(mask), Some(layer)) = (mask, layer) {
                let params = D2D1_LAYER_PARAMETERS {
                    contentBounds: rf(x, y, size, size),
                    geometricMask: ManuallyDrop::new(Some(mask)),
                    maskAntialiasMode: D2D1_ANTIALIAS_MODE_PER_PRIMITIVE,
                    maskTransform: Matrix3x2::identity(),
                    opacity: 1.0,
                    opacityBrush: ManuallyDrop::new(None),
                    layerOptions: D2D1_LAYER_OPTIONS_NONE,
                };
                self.t.PushLayer(&params, &layer);
                let _ = ManuallyDrop::into_inner(params.geometricMask);
                // partie de l'image sous la loupe, coupée aux bords de l'écran
                let sx = (ix - half).floor();
                let sy = (iy - half).floor();
                let n = LOUPE_PIXELS as f64;
                let x1 = sx.max(0.0);
                let y1 = sy.max(0.0);
                let x2 = (sx + n).min(s.image_w());
                let y2 = (sy + n).min(s.image_h());
                if x2 > x1 && y2 > y1 {
                    let dest = rf(x + (x1 - sx) * cell, y + (y1 - sy) * cell, (x2 - x1) * cell, (y2 - y1) * cell);
                    let src = rf(x1, y1, x2 - x1, y2 - y1);
                    self.t.DrawBitmap(self.bitmap, Some(&dest), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, Some(&src));
                }
                // pixel central
                let cx = x + (LOUPE_PIXELS as f64 / 2.0).floor() * cell;
                let cy = y + (LOUPE_PIXELS as f64 / 2.0).floor() * cell;
                let guide = Color(255, 255, 255, 0.35);
                self.line((x, cy + cell / 2.0), (x + size, cy + cell / 2.0), guide, 1.0, None);
                self.line((cx + cell / 2.0, y), (cx + cell / 2.0, y + size), guide, 1.0, None);
                self.stroke(rf(cx, cy, cell, cell), WHITE, 1.5, None);
                self.t.PopLayer();
            }
            self.t.DrawRoundedRectangle(&frame, self.color(Color(255, 255, 255, 0.8)), 1.5, None);
        }
        let label = label.unwrap_or_else(|| format!("{}, {}", ix.round(), iy.round()));
        self.pill(&label, x + size / 2.0, y + size + 6.0, true);
    }

    // Bouton « Capturer toute la page », avec une flèche vers le bas
    fn scroll_button(&self, b: &Button) {
        let r = b.rect;
        self.shadow(r.x, r.y, r.w, r.h, r.h / 2.0, 14.0, 0.4, 2.0);
        self.fill_rounded(rounded(r.x, r.y, r.w, r.h, r.h / 2.0), if self.sel.over_button { ACCENT_HOVER } else { ACCENT });
        let cx = r.x + 21.0;
        let cy = r.y + r.h / 2.0 - 1.0;
        let round = Some(&self.res.round);
        self.line((cx, cy - 7.0), (cx, cy + 3.0), WHITE, 2.0, round);
        self.line((cx - 4.5, cy - 1.5), (cx, cy + 3.0), WHITE, 2.0, round);
        self.line((cx, cy + 3.0), (cx + 4.5, cy - 1.5), WHITE, 2.0, round);
        self.line((cx - 5.5, cy + 7.0), (cx + 5.5, cy + 7.0), WHITE, 2.0, round);
        self.text(&b.label, true, r.x + 36.0, r.y, r.h, WHITE);
    }

    // Capture défilante en cours : la zone reste en surbrillance, avec l'avancement
    fn scrolling(&self, zone: &Zone, progress: f64) {
        let s = self.sel;
        let z = s.to_dip(zone);
        self.dim(Some(z));
        self.frame_spot(z);
        let w = (z.w - 32.0).clamp(220.0, 340.0);
        let h = 86.0;
        let x = (z.x + (z.w - w) / 2.0).min(s.width - w - 8.0).max(8.0);
        let y = (z.y + (z.h - h) / 2.0).min(s.height - h - 8.0).max(8.0);
        self.shadow(x, y, w, h, 12.0, 20.0, 0.45, 0.0);
        self.fill_rounded(rounded(x, y, w, h, 12.0), Color(20, 20, 26, 0.94));
        self.text(&s.labels.scrolling, true, x + 16.0, y + 22.0 - 15.0, 30.0, WHITE);
        let percent = format!("{} %", (progress * 100.0).round());
        let pw = self.res.text_width(&percent, true) as f64;
        self.text(&percent, true, x + w - 16.0 - pw, y + 22.0 - 15.0, 30.0, WHITE);
        self.fill_rounded(rounded(x + 16.0, y + 40.0, w - 32.0, 6.0, 3.0), Color(255, 255, 255, 0.14));
        if progress > 0.0 {
            self.fill_rounded(rounded(x + 16.0, y + 40.0, ((w - 32.0) * progress).max(6.0), 6.0, 3.0), ACCENT);
        }
        self.text(&s.labels.scroll_stop, false, x + 16.0, y + 66.0 - 15.0, 30.0, Color(255, 255, 255, 0.65));
    }

    fn draw(&self) {
        let s = self.sel;
        unsafe {
            self.t.Clear(Some(&Color(0, 0, 0, 1.0).into()));
            // l'image de l'écran, pixel pour pixel
            self.t.DrawBitmap(self.bitmap, Some(&rf(0.0, 0.0, s.width, s.height)), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, None);
        }
        if let Some((zone, progress)) = &s.scrolling {
            return self.scrolling(zone, *progress);
        }

        let r = s.selection.filter(|r| s.dragging && r.w > 0.0 && r.h > 0.0);
        // zone détectée en surbrillance (sur le bouton : la zone qu'il capture) ; l'écran entier n'assombrit rien
        let zone = if s.over_button { s.scroll_target } else { s.hovered };
        let spot = match (r, zone) {
            (None, Some(z)) if z.kind == Kind::Screen => Some(Rect { x: 0.0, y: 0.0, w: s.width, h: s.height }),
            (None, Some(z)) => Some(s.to_dip(&z)),
            _ => None,
        };
        if spot.is_none() || zone.is_some_and(|z| z.kind != Kind::Screen) {
            self.dim(r.or(spot));
        }

        if let Some(r) = r {
            self.stroke(rf(r.x - 1.0, r.y - 1.0, r.w + 2.0, r.h + 2.0), ACCENT, 2.0, None);
            self.stroke(rf(r.x + 0.5, r.y + 0.5, r.w - 1.0, r.h - 1.0), Color(255, 255, 255, 0.9), 1.0, Some(&self.res.dashed));
        } else {
            if let Some(spot) = spot {
                self.frame_spot(spot);
            }
            if let (Some(m), false) = (s.mouse, s.over_button) {
                // réticule
                let c = Color(143, 114, 255, 0.85);
                let (mx, my) = (m.0.round() + 0.5, m.1.round() + 0.5);
                self.line((0.0, my), (s.width, my), c, 1.0, None);
                self.line((mx, 0.0), (mx, s.height), c, 1.0, None);
            }
            if let (Some(b), None) = (&s.scroll_button, s.start) {
                self.scroll_button(b);
            }
        }

        if s.start.is_none() && !s.labels.hint.is_empty() {
            self.pill(&s.labels.hint, s.width / 2.0, 20.0, true);
        }

        let label = match (r, zone) {
            (Some(r), _) => Some(format!("{} × {} px", (r.w * s.scale).round(), (r.h * s.scale).round())),
            (None, Some(z)) => Some(format!("{} × {} px", z.w.round(), z.h.round())),
            _ => None,
        };
        if !s.over_button {
            self.loupe(label);
        }
    }
}
