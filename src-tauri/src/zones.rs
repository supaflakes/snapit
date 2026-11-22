// Détection des zones et capture défilante :
// - fenêtres visibles et leurs sous-fenêtres, pour la sélection de zone ;
// - éléments d'interface sous la souris (UI Automation), du plus grand au plus petit ;
// - capture défilante d'une page web (ou de toute zone qui défile) : défilement par UI Automation, captures
//   superposées au pixel près, assemblées en une seule image.
// Des fenêtres et des éléments, seuls la position, le type et la possibilité de défiler sont lus : ni titre, ni texte.
// UI Automation tourne sur un fil dédié (COM) ; une recherche d'éléments en attente est remplacée par la suivante.
use image::RgbaImage;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Ole::{SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const MIN_SIZE: i32 = 8; // pixels : en dessous, ce n'est pas une zone utile
const MAX_CHILDREN: usize = 300; // sous-fenêtres décrites par fenêtre
const PROBE_BUDGET: Duration = Duration::from_millis(250); // par recherche : au-delà, on s'arrête là où on en est
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const SCROLL_TIMEOUT: Duration = Duration::from_secs(120);

// ------------------------------------------------------------------------------------------- fenêtres

fn rect_value(r: &RECT) -> Value {
    json!([r.left, r.top, r.right - r.left, r.bottom - r.top])
}

fn class_name(hwnd: HWND) -> String {
    let mut name = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut name) };
    String::from_utf16_lossy(&name[..len.max(0) as usize])
}

fn is_candidate(hwnd: HWND) -> Option<RECT> {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        // masquée par Windows : autre bureau virtuel, application suspendue…
        let mut cloaked = 0i32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as _, 4).is_ok() && cloaked != 0 {
            return None;
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TRANSPARENT.0 != 0 {
            return None; // surimpression qui laisse passer la souris
        }
        if ex & WS_EX_LAYERED.0 != 0 {
            let (mut key, mut alpha, mut flags) = (Default::default(), 0u8, Default::default());
            if GetLayeredWindowAttributes(hwnd, Some(&mut key), Some(&mut alpha), Some(&mut flags)).is_ok() && flags.0 & LWA_ALPHA.0 != 0 && alpha == 0 {
                return None;
            }
        }
        let class = class_name(hwnd);
        if class == "Progman" || class == "WorkerW" {
            return None; // le bureau : c'est l'écran entier
        }
        // bords visibles, sans les bordures invisibles de redimensionnement ni l'ombre
        let mut frame = RECT::default();
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut _ as _, std::mem::size_of::<RECT>() as u32).is_err() && GetWindowRect(hwnd, &mut frame).is_err() {
            return None;
        }
        (frame.right - frame.left >= MIN_SIZE && frame.bottom - frame.top >= MIN_SIZE).then_some(frame)
    }
}

fn client_rect(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let mut r = RECT::default();
        GetClientRect(hwnd, &mut r).ok()?;
        let mut origin = POINT::default();
        if !windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        r.left += origin.x;
        r.right += origin.x;
        r.top += origin.y;
        r.bottom += origin.y;
        (r.right - r.left >= MIN_SIZE && r.bottom - r.top >= MIN_SIZE).then_some(r)
    }
}

struct ChildScan {
    top: HWND,
    frame: RECT,
    index: HashMap<isize, usize>,
    list: Vec<Value>,
}

unsafe extern "system" fn on_child(child: HWND, state: LPARAM) -> BOOL {
    let scan = &mut *(state.0 as *mut ChildScan);
    if scan.list.len() >= MAX_CHILDREN {
        return false.into();
    }
    let mut r = RECT::default();
    if !IsWindowVisible(child).as_bool() || GetWindowRect(child, &mut r).is_err() {
        return true.into();
    }
    if GetWindowLongW(child, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 != 0 {
        return true.into();
    }
    // une sous-fenêtre peut déborder (contenu défilé) : on la limite à la fenêtre
    r.left = r.left.max(scan.frame.left);
    r.top = r.top.max(scan.frame.top);
    r.right = r.right.min(scan.frame.right);
    r.bottom = r.bottom.min(scan.frame.bottom);
    if r.right - r.left < MIN_SIZE || r.bottom - r.top < MIN_SIZE {
        return true.into();
    }
    // parent : le plus proche ancêtre décrit (les ancêtres sont énumérés avant leurs sous-fenêtres)
    let mut parent = -1i64;
    let mut a = GetAncestor(child, GA_PARENT);
    for _ in 0..64 {
        if a.is_invalid() || a == scan.top {
            break;
        }
        if let Some(&i) = scan.index.get(&(a.0 as isize)) {
            parent = i as i64;
            break;
        }
        a = GetAncestor(a, GA_PARENT);
    }
    scan.list.push(json!([r.left, r.top, r.right - r.left, r.bottom - r.top, parent]));
    scan.index.insert(child.0 as isize, scan.list.len() - 1);
    true.into()
}

unsafe extern "system" fn on_window(hwnd: HWND, state: LPARAM) -> BOOL {
    let list = &mut *(state.0 as *mut Vec<Value>);
    let Some(frame) = is_candidate(hwnd) else { return true.into() };
    let mut scan = ChildScan { top: hwnd, frame, index: HashMap::new(), list: Vec::new() };
    let _ = EnumChildWindows(Some(hwnd), Some(on_child), LPARAM(&mut scan as *mut _ as isize));
    list.push(json!({
        "hwnd": hwnd.0 as i64,
        "frame": rect_value(&frame),
        "client": client_rect(hwnd).map(|r| rect_value(&r)),
        "children": scan.list,
    }));
    true.into()
}

/// Fenêtres visibles, de la plus haute à la plus basse, en pixels physiques de l'écran virtuel.
fn list_windows() -> Vec<Value> {
    let mut list: Vec<Value> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(on_window), LPARAM(&mut list as *mut _ as isize));
    }
    list
}

// ----------------------------------------------------------------------------------- UI Automation

fn control_type_name(id: UIA_CONTROLTYPE_ID) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu", "MenuBar", "MenuItem", "ProgressBar", "RadioButton",
        "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text", "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid",
        "DataItem", "Document", "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar",
    ];
    NAMES.get((id.0 - 50000) as usize).copied().unwrap_or("Custom")
}

// Rectangle d'un élément ; None s'il n'a pas de bords
fn bounds(r: RECT) -> Option<RECT> {
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

fn area(r: &Option<RECT>) -> f64 {
    r.map_or(0.0, |r| (r.right - r.left) as f64 * (r.bottom - r.top) as f64)
}

fn contains(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

fn intersect(a: &RECT, b: &RECT) -> Option<RECT> {
    let r = RECT { left: a.left.max(b.left), top: a.top.max(b.top), right: a.right.min(b.right), bottom: a.bottom.min(b.bottom) };
    (r.right >= r.left && r.bottom >= r.top).then_some(r)
}

fn deepest_child(hwnd: HWND, x: i32, y: i32) -> HWND {
    let mut current = hwnd;
    for _ in 0..32 {
        let mut p = POINT { x, y };
        unsafe {
            if !ScreenToClient(current, &mut p).as_bool() {
                break;
            }
            let child = ChildWindowFromPointEx(current, p, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
            if child.is_invalid() || child == current {
                break;
            }
            current = child;
        }
    }
    current
}

// Fenêtre de Chromium (Chrome, Edge, applications Electron…) : la page, ou la fenêtre qui la contient
fn is_chromium_page(hwnd: HWND) -> bool {
    class_name(hwnd).starts_with("Chrome_")
}

// Pages Chromium (Chrome, Edge, applications Electron…) d'une fenêtre
fn chromium_pages(top: HWND) -> Vec<HWND> {
    unsafe extern "system" fn collect(child: HWND, state: LPARAM) -> BOOL {
        let list = &mut *(state.0 as *mut Vec<HWND>);
        if is_chromium_page(child) && IsWindowVisible(child).as_bool() {
            list.push(child);
        }
        true.into()
    }
    let mut list = Vec::new();
    if class_name(top).starts_with("Chrome_WidgetWin") {
        unsafe {
            let _ = EnumChildWindows(Some(top), Some(collect), LPARAM(&mut list as *mut _ as isize));
        }
        if list.is_empty() {
            list.push(top);
        }
    }
    list
}

struct Node {
    element: IUIAutomationElement,
    parent: Option<usize>,
    rect: Option<RECT>,
    depth: u32,
}

/// Résultat d'une capture défilante : l'image assemblée et la raison de sa fin.
pub struct ScrollResult {
    pub image: RgbaImage,
    /// "bottom" (bas atteint), "stopped" (arrêtée), "limit" (image trop haute) ou "interrupted"
    pub end: String,
}

enum Job {
    Probe { hwnd: i64, x: i32, y: i32, reply: oneshot::Sender<Option<Vec<Value>>> },
    Forget,
    Warm(Vec<i64>),
    Scroll { n: i64, area: [i32; 4], scale: f64, progress: Box<dyn Fn(f64) + Send>, reply: oneshot::Sender<Option<ScrollResult>> },
}

struct Worker {
    automation: IUIAutomation,
    cache: IUIAutomationCacheRequest,
    condition: IUIAutomationCondition,
    // éléments qui défilent trouvés par les recherches, numérotés à partir de 1 pour la sélection en cours
    scroll_numbers: HashMap<String, i64>,
    scrollables: Vec<IUIAutomationElement>,
    // pages Chromium déjà interrogées : Chromium n'active son accessibilité complète (défilement compris) qu'après
    // une première interrogation
    warmed: std::collections::HashSet<isize>,
}

impl Worker {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let cache = automation.CreateCacheRequest()?;
            for id in [
                UIA_BoundingRectanglePropertyId,
                UIA_ControlTypePropertyId,
                UIA_IsOffscreenPropertyId,
                // pour la capture défilante
                UIA_RuntimeIdPropertyId,
                UIA_IsScrollPatternAvailablePropertyId,
                UIA_ScrollVerticallyScrollablePropertyId,
                UIA_ScrollVerticalViewSizePropertyId,
            ] {
                cache.AddProperty(id)?;
            }
            let condition = automation.ControlViewCondition()?;
            Ok(Worker { automation, cache, condition, scroll_numbers: HashMap::new(), scrollables: Vec::new(), warmed: Default::default() })
        }
    }

    fn run(mut self, jobs: Receiver<Job>, stop: Arc<AtomicBool>) {
        while let Ok(first) = jobs.recv() {
            // seule la dernière recherche d'éléments compte : les précédentes, encore en attente, sont abandonnées
            let mut batch = vec![first];
            while let Ok(job) = jobs.try_recv() {
                batch.push(job);
            }
            let last_probe = batch.iter().rposition(|j| matches!(j, Job::Probe { .. }));
            for (i, job) in batch.into_iter().enumerate() {
                match job {
                    Job::Probe { reply, .. } if Some(i) != last_probe => {
                        let _ = reply.send(None);
                    }
                    Job::Probe { hwnd, x, y, reply } => {
                        let _ = reply.send(Some(self.probe(HWND(hwnd as _), x, y)));
                    }
                    Job::Warm(windows) => {
                        for hwnd in windows {
                            for page in chromium_pages(HWND(hwnd as _)) {
                                self.warm(page);
                            }
                        }
                    }
                    Job::Forget => {
                        self.scroll_numbers.clear();
                        self.scrollables.clear();
                    }
                    Job::Scroll { n, area, scale, progress, reply } => {
                        stop.store(false, Ordering::SeqCst);
                        let element = usize::try_from(n - 1).ok().and_then(|i| self.scrollables.get(i).cloned());
                        let result = element.and_then(|e| PageCapture::new(e, area, scale, &stop, progress).and_then(|mut c| c.run()));
                        let _ = reply.send(result);
                    }
                }
            }
        }
    }

    // Première interrogation d'une page Chromium : son accessibilité complète s'active (en quelques dizaines de
    // millisecondes) ; les recherches suivantes y trouvent ce qui défile.
    fn warm(&mut self, page: HWND) {
        if !self.warmed.insert(page.0 as isize) {
            return;
        }
        unsafe {
            if let Ok(element) = self.automation.ElementFromHandleBuildCache(page, &self.cache) {
                let _ = element.FindAllBuildCache(TreeScope_Children, &self.condition, &self.cache);
            }
        }
    }

    fn probe(&mut self, hwnd: HWND, x: i32, y: i32) -> Vec<Value> {
        let target = deepest_child(hwnd, x, y);
        let first_time = is_chromium_page(target) && !self.warmed.contains(&(target.0 as isize));
        let chain = self.chain(hwnd, x, y).unwrap_or_default();
        self.warmed.insert(target.0 as isize);
        // page Chromium interrogée pour la première fois et rien qui défile : sans doute pas encore activée
        if first_time && !chain.iter().any(|e| e[5].as_i64().unwrap_or(0) > 0) {
            std::thread::sleep(Duration::from_millis(150));
            return self.chain(hwnd, x, y).unwrap_or(chain);
        }
        chain
    }

    // Cherche dans l'arbre UI Automation, depuis la sous-fenêtre sous le point, le plus petit élément qui le
    // contient, puis renvoie ses ancêtres. Seules les branches qui contiennent le point sont explorées, en
    // commençant par les plus petites. Les conteneurs sans bords (Chrome range son interface dans des « Pane »
    // vides) et les enveloppes de même taille sont traversés. À taille presque égale, l'élément le plus profond
    // l'emporte : dans une fenêtre Electron, la page est plus grande d'un pixel qu'un panneau technique voisin.
    fn chain(&mut self, hwnd: HWND, x: i32, y: i32) -> windows::core::Result<Vec<Value>> {
        let clock = Instant::now();
        let mut nodes: Vec<Node> = Vec::new();
        unsafe {
            let root = self.automation.ElementFromHandleBuildCache(deepest_child(hwnd, x, y), &self.cache)?;
            let rect = bounds(root.CachedBoundingRectangle()?);
            nodes.push(Node { element: root, parent: None, rect, depth: 0 });
        }
        let mut best = 0usize;
        let mut best_area = if nodes[0].rect.is_none() { f64::MAX } else { area(&nodes[0].rect) };
        let mut stack = vec![0usize];
        let mut visited = 0;
        while let Some(index) = stack.pop() {
            if visited >= 300 || clock.elapsed() >= PROBE_BUDGET {
                break;
            }
            visited += 1;
            let children = unsafe { nodes[index].element.FindAllBuildCache(TreeScope_Children, &self.condition, &self.cache) };
            let Ok(children) = children else { continue }; // élément disparu entre-temps
            let count = unsafe { children.Length() }.unwrap_or(0);
            let mut inside = Vec::new();
            for j in 0..count {
                let Ok(child) = (unsafe { children.GetElement(j) }) else { continue };
                let rect = unsafe { child.CachedBoundingRectangle() }.ok().and_then(bounds);
                if let Some(r) = &rect {
                    let offscreen = unsafe { child.CachedIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false);
                    if !contains(r, x, y) || offscreen {
                        continue;
                    }
                }
                let depth = nodes[index].depth + 1;
                let a = area(&rect);
                nodes.push(Node { element: child, parent: Some(index), rect, depth });
                let n = nodes.len() - 1;
                if rect.is_some() && (a < best_area * 0.99 || (a <= best_area * 1.01 && depth > nodes[best].depth)) {
                    best = n;
                    best_area = a;
                }
                inside.push(n);
            }
            // le plus petit (ou sans bords) en dernier sur la pile : exploré en premier
            inside.sort_by(|a, b| area(&nodes[*b].rect).total_cmp(&area(&nodes[*a].rect)));
            stack.extend(inside);
        }
        // de la fenêtre à l'élément trouvé, sans les conteneurs sans bords
        let mut chain = Vec::new();
        let mut n = Some(best);
        while let Some(i) = n {
            if nodes[i].rect.is_some() {
                chain.push(i);
            }
            n = nodes[i].parent;
        }
        chain.reverse();
        let mut found: Vec<(RECT, usize, i64)> = Vec::new();
        let mut visible: Option<RECT> = None;
        for i in chain {
            let rect = nodes[i].rect.unwrap();
            // partie visible : un élément ne dépasse pas de ses ancêtres (page défilée plus haute que la fenêtre…)
            let Some(r) = (match &visible {
                None => Some(rect),
                Some(v) => intersect(v, &rect),
            }) else {
                break;
            };
            let scroll = self.scroll_number(&nodes[i].element);
            // enveloppes identiques : une seule fois, qui défile si l'une d'elles défile
            if visible.as_ref() != Some(&r) {
                found.push((r, i, scroll));
            } else if scroll > 0 {
                if let Some(last) = found.last_mut().filter(|f| f.2 == 0) {
                    last.2 = scroll;
                }
            }
            visible = Some(r);
        }
        Ok(found
            .into_iter()
            .filter(|(r, _, _)| r.right - r.left >= 1 && r.bottom - r.top >= 1)
            .map(|(r, i, scroll)| {
                let kind = unsafe { nodes[i].element.CachedControlType() }.map(control_type_name).unwrap_or("Custom");
                json!([r.left, r.top, r.right - r.left, r.bottom - r.top, kind, scroll])
            })
            .collect())
    }

    // Numéro de l'élément s'il défile verticalement (le même à chaque recherche), 0 sinon. Un contenu qui ne
    // dépasse que d'un pixel ne compte pas.
    fn scroll_number(&mut self, element: &IUIAutomationElement) -> i64 {
        unsafe {
            let flag = |id| element.GetCachedPropertyValue(id).ok().and_then(|v| bool::try_from(&v).ok()).unwrap_or(false);
            if !flag(UIA_IsScrollPatternAvailablePropertyId) || !flag(UIA_ScrollVerticallyScrollablePropertyId) {
                return 0;
            }
            let view = element.GetCachedPropertyValue(UIA_ScrollVerticalViewSizePropertyId).ok().and_then(|v| f64::try_from(&v).ok());
            if !view.is_some_and(|v| v < 99.0) {
                return 0;
            }
            let Some(key) = runtime_id(element) else { return 0 };
            if let Some(&n) = self.scroll_numbers.get(&key) {
                return n;
            }
            self.scrollables.push(element.clone());
            let n = self.scrollables.len() as i64;
            self.scroll_numbers.insert(key, n);
            n
        }
    }
}

unsafe fn runtime_id(element: &IUIAutomationElement) -> Option<String> {
    let array = element.GetRuntimeId().ok()?;
    if array.is_null() {
        return None;
    }
    let (lower, upper) = (SafeArrayGetLBound(array, 1).ok()?, SafeArrayGetUBound(array, 1).ok()?);
    let mut parts = Vec::new();
    for i in lower..=upper {
        let mut value = 0i32;
        if SafeArrayGetElement(array, &i, &mut value as *mut _ as _).is_ok() {
            parts.push(value.to_string());
        }
    }
    let _ = SafeArrayDestroy(array);
    Some(parts.join("."))
}

// ------------------------------------------------------------------------------- capture défilante

// Capture de l'écran dans la zone, et signature de chaque ligne (entière, et par bande verticale) pour la comparer
// rapidement à une autre capture. Les bords, où se trouve la barre de défilement, sont ignorés.
struct Frame {
    pixels: Vec<u32>,
    rows: Vec<u64>,
    bands: Vec<Vec<u64>>,
    plain: Vec<Vec<bool>>, // ligne d'une seule couleur dans la bande (un fond, rien dessus)
}

const FNV_OFFSET: u64 = 14695981039346656037;
const FNV_PRIME: u64 = 1099511628211;

impl Frame {
    fn new(pixels: Vec<u32>, w: usize, h: usize, edge: usize, bands: usize) -> Self {
        let mut f = Frame { rows: vec![0; h], bands: vec![vec![0; h]; bands], plain: vec![vec![false; h]; bands], pixels };
        let span = w - 2 * edge;
        for y in 0..h {
            let row = &f.pixels[y * w..(y + 1) * w];
            let mut whole = FNV_OFFSET;
            for b in 0..bands {
                let (start, end) = (edge + span * b / bands, edge + span * (b + 1) / bands);
                let color = row[start];
                let mut hash = FNV_OFFSET; // FNV-1a
                let mut plain = true;
                for &pixel in &row[start..end] {
                    hash = (hash ^ pixel as u64).wrapping_mul(FNV_PRIME);
                    plain &= pixel == color;
                }
                f.bands[b][y] = hash;
                f.plain[b][y] = plain;
                whole = (whole ^ hash).wrapping_mul(FNV_PRIME);
            }
            f.rows[y] = whole;
        }
        f
    }
}

// Morceau de l'image finale : lignes d'une capture
struct Part {
    pixels: Vec<u32>,
    rows: usize,
}

const MAX_HEIGHT: usize = 30000; // pixels : au-delà, l'image serait trop lourde pour l'éditeur
const MAX_PIXELS: usize = 80_000_000;
const TIME_BUDGET: Duration = Duration::from_secs(90);
const STABLE: Duration = Duration::from_millis(150); // sans changement pour qu'une capture soit prise

// Capture défilante : remonte en haut de l'élément, le fait défiler par pas en capturant la zone, superpose
// chaque capture à la précédente (au pixel près, d'après le contenu) et n'en garde que la partie nouvelle.
// Un en-tête ou un pied de page fixes (identiques d'une capture à l'autre) ne sont gardés qu'une fois, la
// barre de défilement est retirée. Les autres éléments fixes (barre latérale collante…) ne sont pas répétés :
// chaque partie nouvelle commence sous eux, sauf s'ils occupent presque toute la hauteur de la zone.
// L'élément revient ensuite à sa position de départ.
struct PageCapture<'a> {
    pattern: IUIAutomationScrollPattern,
    area: [i32; 4],
    w: usize,
    h: usize,
    edge: usize,    // largeur des bords ignorés pour superposer les captures (barre de défilement)
    bands: usize,   // bandes verticales comparées séparément (une barre latérale fixe ne gêne pas les autres)
    margin: usize,  // bas de chaque capture laissé à la suivante (coins arrondis de la fenêtre…)
    overlap: usize, // hauteur visée commune à deux captures successives
    probe: usize,   // petit pas, qui laisse voir les éléments fixes presque en entier dans la partie commune
    tall: Vec<bool>, // bandes où un élément fixe occupe presque toute la hauteur : impossible à éviter
    parts: Vec<Part>,
    viewport: f64, // hauteur de l'élément : la page en montre VerticalViewSize %
    stop: &'a AtomicBool,
    progress: Box<dyn Fn(f64) + Send>,
}

impl<'a> PageCapture<'a> {
    fn new(element: IUIAutomationElement, zone: [i32; 4], scale: f64, stop: &'a AtomicBool, progress: Box<dyn Fn(f64) + Send>) -> Option<Self> {
        if zone[2] < 16 || zone[3] < 16 {
            return None;
        }
        unsafe {
            let pattern: IUIAutomationScrollPattern = element.GetCurrentPatternAs(UIA_ScrollPatternId).ok()?;
            // la zone montrée par Snapit, ramenée aux bords de l'élément (elle peut en déborder d'un pixel ou deux)
            let b = element.CurrentBoundingRectangle().ok().and_then(bounds);
            let viewport = b.map_or(0.0, |b| (b.bottom - b.top) as f64);
            let mut area = zone;
            if let Some(b) = b {
                let z = RECT { left: zone[0], top: zone[1], right: zone[0] + zone[2], bottom: zone[1] + zone[3] };
                if let Some(i) = intersect(&z, &b).filter(|i| i.right - i.left >= 16 && i.bottom - i.top >= 16) {
                    area = [i.left, i.top, i.right - i.left, i.bottom - i.top];
                }
            }
            let (w, h) = (area[2] as usize, area[3] as usize);
            let edge = (w / 8).min((24.0 * scale).ceil() as usize);
            let bands = ((w - 2 * edge) / 96).clamp(1, 6);
            Some(PageCapture {
                pattern,
                area,
                w,
                h,
                edge,
                bands,
                margin: (h / 10).min((12.0 * scale).ceil() as usize),
                overlap: (h / 6).max(32),
                probe: (h / 4).max(16),
                tall: vec![false; bands],
                parts: Vec::new(),
                viewport,
                stop,
                progress,
            })
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn scroll_to(&self, percent: f64) {
        unsafe {
            let _ = self.pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, percent);
        }
    }

    fn run(&mut self) -> Option<ScrollResult> {
        let original = unsafe { self.pattern.CurrentVerticalScrollPercent() }.ok()?;
        let result = self.capture(original);
        if original >= 0.0 {
            self.scroll_to(original); // retour à la position de départ
        }
        result
    }

    fn capture(&mut self, original: f64) -> Option<ScrollResult> {
        let (h, margin, probe, overlap) = (self.h, self.margin, self.probe, self.overlap);
        let clock = Instant::now();
        let mut header = usize::MAX; // en-tête fixe : lignes identiques en haut de toutes les captures
        let mut lead = 0usize; // haut de la partie qui défile, sous l'en-tête fixe, même translucide
        let mut fixed_bottom = 0usize; // bas des éléments fixes (en-tête, barre latérale collante…)
        let mut cut = margin; // bas de la dernière capture laissé à la suivante
        let (mut left, mut right) = (0usize, 0usize); // colonnes retirées : barre de défilement
        let mut end: i64 = -1; // position dans la page de la fin de l'image assemblée (-1 : rien encore)
        let mut offset: i64 = 0; // position dans la page du haut de la capture `a`
        let (mut pct, mut measured) = (0.0f64, 0.0f64);
        let mut outcome = "bottom";

        let mut a = self.grab()?;
        if original > 0.0 {
            self.scroll_to(0.0);
            if let Some(settled) = self.settle(&a) {
                a = settled;
            }
        }
        let limit = MAX_HEIGHT.min(MAX_PIXELS / self.w);
        while pct < 100.0 {
            if self.stopped() {
                outcome = "stopped";
                break;
            }
            if clock.elapsed() > TIME_BUDGET {
                outcome = "interrupted";
                break;
            }
            // pas visé : la hauteur utile de la capture, moins de quoi superposer les deux captures. Le premier,
            // petit, laisse voir les éléments fixes ; les lignes nouvelles commencent ensuite sous eux, sauf s'il ne
            // reste presque plus de place.
            let usable = h as i64 - (if header == usize::MAX { 0 } else { header }).max(lead) as i64 - cut as i64;
            let mut wanted = if end < 0 { probe as i64 } else { (usable - overlap as i64).max((usable / 3).max(16)) };
            let room = h as i64 - cut as i64 - fixed_bottom as i64 - 2 * margin as i64;
            if end >= 0 && room >= ((h / 10).max(32)) as i64 {
                wanted = wanted.min(room);
            }
            let rate = measured.max(self.pixels_per_percent());
            if rate <= 0.0 {
                break; // l'élément ne défile plus
            }
            let (mut top, mut bottom, mut d) = (0usize, 0usize, -1i64);
            let mut next = pct;
            let mut b: Option<Frame> = None;
            let mut halted = false;
            for _ in 0..5 {
                if d >= 0 || self.stopped() {
                    break;
                }
                next = 100f64.min(pct + wanted as f64 / rate);
                self.scroll_to(next);
                // comparée à la dernière capture vue, pour attendre que la page ait bougé
                let Some(frame) = self.settle(b.as_ref().unwrap_or(&a)) else {
                    halted = true; // arrêt demandé
                    break;
                };
                let expected = ((next - pct) * rate).round() as i64;
                (d, top, bottom, lead) = self.shift(&a, &frame, expected);
                b = Some(frame);
                if d < 0 {
                    wanted /= 2; // défilement trop grand (la page s'est allongée…) : on recommence avec un pas plus petit
                    continue;
                }
                if d == 0 {
                    break;
                }
                let bottom_of_fixed = self.fixed_bottom(&a, b.as_ref().unwrap(), d as usize, bottom);
                if bottom_of_fixed < 0 {
                    d = -1; // un élément fixe descend plus bas que la partie commune : petit pas pour le voir en entier
                    wanted = probe as i64;
                    continue;
                }
                fixed_bottom = bottom_of_fixed as usize;
            }
            let Some(bf) = b.filter(|_| !halted && !(d < 0 && self.stopped())) else {
                outcome = "stopped";
                break;
            };
            if d < 0 {
                outcome = "interrupted";
                break;
            }
            if d == 0 {
                if end < 0 {
                    outcome = "interrupted"; // la page n'a pas défilé du tout
                }
                break; // sinon, le bas est atteint
            }
            let du = d as usize;
            let bottom_cut = bottom.max(margin);
            if end < 0 {
                self.add(&a, 0, h - bottom_cut); // première capture, en-tête compris
                end = (h - bottom_cut) as i64;
            }
            header = header.min(top);
            left = left.max(self.edge_cut(&a, &bf, du, bottom, true));
            right = right.max(self.edge_cut(&a, &bf, du, bottom, false));
            offset += d;
            let from = (end - offset).max(header as i64);
            if from < (h - bottom_cut) as i64 {
                self.add(&bf, from.max(0) as usize, h - bottom_cut);
                end = offset + (h - bottom_cut) as i64;
            }
            cut = bottom_cut;
            if next < 100.0 {
                measured = d as f64 / (next - pct);
            }
            pct = next;
            a = bf;
            (self.progress)((offset + h as i64) as f64 / ((offset + h as i64) as f64 + (100.0 - pct) * rate));
            if self.height() >= limit {
                outcome = "limit";
                break;
            }
        }
        // dernière capture : jusqu'en bas, pied de page compris
        let rest = if end < 0 { 0 } else { (end - offset).max(0) as usize };
        if rest < h {
            self.add(&a, rest, h);
        }
        let height = self.height().min(limit);
        if self.height() > limit {
            outcome = "limit";
        }
        (self.progress)(1.0);
        Some(ScrollResult { image: self.save(height, left, right), end: outcome.into() })
    }

    // Hauteur de page parcourue par point de pourcentage de défilement, d'après UI Automation.
    fn pixels_per_percent(&self) -> f64 {
        let view = unsafe { self.pattern.CurrentVerticalViewSize() }.unwrap_or(0.0);
        if view > 0.0 && view < 100.0 { self.viewport * (100.0 / view - 1.0) / 100.0 } else { 0.0 }
    }

    fn height(&self) -> usize {
        self.parts.iter().map(|p| p.rows).sum()
    }

    // Seules les lignes gardées sont copiées : les captures entières seraient bien plus lourdes que l'image.
    fn add(&mut self, f: &Frame, from: usize, to: usize) {
        if to <= from {
            return;
        }
        self.parts.push(Part { pixels: f.pixels[from * self.w..to * self.w].to_vec(), rows: to - from });
    }

    fn grab(&self) -> Option<Frame> {
        let [x, y, w, h] = self.area;
        let bytes = crate::win::grab_screen(x, y, w, h).ok()?;
        let pixels: Vec<u32> = bytes.chunks_exact(4).map(|p| u32::from_le_bytes([p[0], p[1], p[2], p[3]])).collect();
        Some(Frame::new(pixels, self.w, self.h, self.edge, self.bands))
    }

    // Attend que la zone ait défilé (capture différente de `before`) puis soit stable. None : arrêt demandé.
    // Stable depuis un moment : Chrome montre parfois d'abord une partie de la page dans un rendu provisoire,
    // remplacé une ou deux captures plus tard.
    fn settle(&self, before: &Frame) -> Option<Frame> {
        let clock = Instant::now();
        std::thread::sleep(Duration::from_millis(50));
        let mut last = self.grab()?;
        let mut moved = self.different_rows(&last, before) > 0;
        let mut changed = clock.elapsed();
        loop {
            if self.stopped() {
                return None;
            }
            std::thread::sleep(Duration::from_millis(30));
            let next = self.grab()?;
            let t = clock.elapsed();
            if self.different_rows(&next, &last) > self.h / 100 {
                changed = t;
            }
            moved = moved || self.different_rows(&next, before) > 0;
            last = next;
            if if moved { t - changed >= STABLE } else { t > Duration::from_millis(700) } {
                return Some(last); // stable, ou rien n'a bougé
            }
            if t > Duration::from_millis(1500) {
                return Some(last); // contenu animé : la capture est prise telle quelle
            }
        }
    }

    fn different_rows(&self, a: &Frame, b: &Frame) -> usize {
        a.rows.iter().zip(&b.rows).filter(|(x, y)| x != y).count()
    }

    // Superpose b à a : décalage d tel que la ligne y de b montre ce que montrait la ligne y + d de a. Les lignes
    // identiques en haut et en bas des deux captures sont fixes (en-tête, pied de page) ; `lead` : haut de la
    // partie qui défile. Renvoie (d, top, bottom, lead) ; d = 0 : rien n'a défilé ; d = -1 : aucun décalage
    // convaincant.
    fn shift(&self, a: &Frame, b: &Frame, expected: i64) -> (i64, usize, usize, usize) {
        let h = self.h;
        let mut top = 0;
        while top < h && a.rows[top] == b.rows[top] {
            top += 1;
        }
        let mut bottom = 0;
        while bottom < h - top && a.rows[h - 1 - bottom] == b.rows[h - 1 - bottom] {
            bottom += 1;
        }
        let mut lead = top;
        if h - top - bottom < 4 {
            return (0, top, bottom, lead);
        }
        let max = (h - top - bottom) as i64 - 8.max(self.overlap / 3) as i64; // assez de lignes communes pour conclure
        if max < 1 {
            return (-1, top, bottom, lead);
        }
        // lignes parlantes : rares dans leur bande (une ligne blanche ressemble à toutes les autres)
        let mut rare = vec![vec![false; h]; self.bands];
        for k in 0..self.bands {
            let mut count: HashMap<u64, u32> = HashMap::new();
            let s = &a.bands[k];
            for y in top..h - bottom {
                *count.entry(s[y]).or_insert(0) += 1;
            }
            for y in top..h - bottom {
                rare[k][y] = count[&s[y]] <= 2;
            }
        }
        // chaque bande vote : lignes parlantes retrouvées, moins les lignes différentes. Une bande qui ne suit pas
        // le défilement (barre latérale fixe, animation) ne compte pas.
        let mut best = -1i64;
        let mut best_score = 0.0f64;
        for d in 1..=max {
            let du = d as usize;
            let mut score = 0.0;
            for k in 0..self.bands {
                let (sa, sb, r) = (&a.bands[k], &b.bands[k], &rare[k]);
                let (mut found, mut missed) = (0i64, 0i64);
                for y in top..h - bottom - du {
                    if sb[y] != sa[y + du] {
                        missed += 1;
                    } else if r[y + du] {
                        found += 1;
                    }
                }
                score += 0.max(found - 3 * missed) as f64;
            }
            score -= (d - expected).abs() as f64 * 1e-6; // à égalité, le défilement demandé
            if score > best_score {
                best_score = score;
                best = d;
            }
        }
        if best_score < 3.5 {
            // Pas de décalage convaincant : un en-tête fixe translucide (la page défilée transparaît dessous) ne suit
            // pas le défilement sans être identique d'une capture à l'autre, et pèse trop sur une petite partie
            // commune. Le défilement demandé (UI Automation est précis) est vérifié en le tolérant.
            best = -1;
            best_score = f64::MIN;
            for d in (expected - 2).max(1)..=max.min(expected + 2) {
                let score = self.confirm(a, b, d as usize, top, bottom, &rare);
                if score < 0.0 {
                    continue;
                }
                let score = score - (d - expected).abs() as f64 * 1e-6;
                if score > best_score {
                    best_score = score;
                    best = d;
                }
            }
        }
        if best > 0 {
            lead = self.lead(a, b, best as usize, top, bottom, &rare);
        }
        (best, top, bottom, lead)
    }

    // Vote des bandes sur le décalage d, comme dans shift, en ignorant dans chaque bande les lignes qui ne suivent
    // pas le défilement en haut et en bas (au plus un tiers de la hauteur de chaque côté) : en-tête ou bandeau fixes
    // translucides. Entre les deux, les lignes semblables à l'œil comptent comme identiques (voir close) ; pas aux
    // bords, où un en-tête sombre et translucide sur un fond sombre leur ressemblerait. Renvoie son score, 0 si peu
    // de lignes parlantes mais la plupart des bandes confirment (zones unies), -1 sinon.
    fn confirm(&self, a: &Frame, b: &Frame, d: usize, top: usize, bottom: usize, rare: &[Vec<bool>]) -> f64 {
        let stop = self.h - bottom - d;
        let zone = self.h / 3;
        let (mut counted, mut agree) = (0, 0);
        let mut score = 0.0;
        for k in 0..self.bands {
            let (sa, sb) = (&a.bands[k], &b.bands[k]);
            let (mut first, mut last) = (top, stop);
            while first < last && first < top + zone && sb[first] != sa[first + d] {
                first += 1;
            }
            while last > first && last > stop.saturating_sub(zone) && sb[last - 1] != sa[last - 1 + d] {
                last -= 1;
            }
            let (mut found, mut missed) = (0i64, 0i64);
            for y in first..last {
                if !self.same(a, y + d, b, y, k) {
                    missed += 1;
                } else if rare[k][y + d] {
                    found += 1;
                }
            }
            score += 0.max(found - 3 * missed) as f64;
            if last - first >= 16 {
                counted += 1;
                if missed <= ((last - first) / 20) as i64 {
                    agree += 1;
                }
            }
        }
        if score >= 3.5 {
            return score;
        }
        if agree * 2 > counted { 0.0 } else { -1.0 }
    }

    fn same(&self, a: &Frame, ya: usize, b: &Frame, yb: usize, k: usize) -> bool {
        a.bands[k][ya] == b.bands[k][yb] || self.close(a, ya, b, yb, k)
    }

    // Lignes semblables à l'œil dans la bande k : même contenu, mais un lissage du texte différent (Chrome passe une
    // partie de la page du lissage ClearType aux niveaux de gris selon la position de défilement). Ce lissage
    // déplace la lumière d'un pixel à son voisin : cumulée par groupes de 4 pixels, la luminosité ne change presque
    // pas, alors qu'une ligne décalée d'un pixel diffère nettement.
    fn close(&self, a: &Frame, ya: usize, b: &Frame, yb: usize, k: usize) -> bool {
        let span = self.w - 2 * self.edge;
        let (start, end) = (self.edge + span * k / self.bands, self.edge + span * (k + 1) / self.bands);
        let (ra, rb) = (ya * self.w, yb * self.w);
        let mut x = start;
        while x + 4 <= end {
            let sum: i64 = (x..x + 4).map(|i| luma(a.pixels[ra + i]) - luma(b.pixels[rb + i])).sum();
            if !(-4 * 40 * 1000..=4 * 40 * 1000).contains(&sum) {
                return false; // 40 niveaux sur 255 en moyenne
            }
            x += 4;
        }
        true
    }

    // Haut de la partie de la page qui défile : première ligne parlante retrouvée à l'identique, sous un éventuel
    // en-tête fixe (cherchée dans le premier tiers de la zone ; `top` si aucune).
    fn lead(&self, a: &Frame, b: &Frame, d: usize, top: usize, bottom: usize, rare: &[Vec<bool>]) -> usize {
        let stop = (self.h - bottom - d).min(top + self.h / 3);
        let mut lead = stop;
        for k in 0..self.bands {
            for y in top..lead {
                if rare[k][y + d] && b.bands[k][y] == a.bands[k][y + d] {
                    lead = y;
                    break;
                }
            }
        }
        if lead < stop { lead } else { top }
    }

    // Bas des éléments fixes (en-tête, barre latérale collante…) : dans chaque bande, lignes restées à la même place
    // alors que la page a défilé dessous. -1 si l'un d'eux descend jusqu'au bas de la partie commune aux deux
    // captures après un grand pas : on n'en voit pas le bas. Après un petit pas, la bande est désormais ignorée :
    // l'élément occupe presque toute la hauteur de la zone, on ne peut pas l'éviter.
    fn fixed_bottom(&mut self, a: &Frame, b: &Frame, d: usize, bottom: usize) -> i64 {
        let stop = self.h - bottom - d;
        let mut result = 0i64;
        for k in 0..self.bands {
            if self.tall[k] {
                continue;
            }
            let (sa, sb) = (&a.bands[k], &b.bands[k]);
            let mut last = -1i64;
            for y in 0..stop {
                if sb[y] != sa[y] || sb[y] == sa[y + d] {
                    continue; // la ligne a défilé, ou bouge d'elle-même
                }
                // un fond uni, là où un élément fixe (bouton flottant…) cache la ligne suivie dans `a` : c'est
                // cet élément-là, plus bas, qui ne suit pas le défilement
                if b.plain[k][y] && !a.plain[k][y + d] && sb[y + d] == sa[y + d] {
                    continue;
                }
                last = y as i64;
            }
            if last >= stop as i64 - self.margin as i64 {
                if d > self.probe {
                    return -1;
                }
                self.tall[k] = true;
                continue;
            }
            result = result.max(last + 1);
        }
        result
    }

    // Colonnes d'un bord qui ne suivent pas le défilement (le curseur de la barre de défilement se déplace) : leur
    // nombre, compté depuis le bord. Seules comptent les lignes où la page, à côté du bord, a suivi le défilement :
    // pas celles d'un en-tête ou d'une barre latérale fixes.
    fn edge_cut(&self, a: &Frame, b: &Frame, d: usize, bottom: usize, left_side: bool) -> usize {
        let k = if left_side { 0 } else { self.bands - 1 };
        let (sa, sb) = (&a.bands[k], &b.bands[k]);
        let rows: Vec<usize> = (0..self.h - bottom - d).filter(|&y| sb[y] == sa[y + d]).collect();
        if rows.is_empty() {
            return 0;
        }
        for i in (0..self.edge).rev() {
            // de l'intérieur vers le bord
            let x = if left_side { i } else { self.w - 1 - i };
            let missed = rows.iter().filter(|&&y| b.pixels[y * self.w + x] != a.pixels[(y + d) * self.w + x]).count();
            if missed > 1.max(rows.len() / 200) {
                return i + 1;
            }
        }
        0
    }

    // Image assemblée, sans les colonnes retirées.
    fn save(&self, height: usize, left: usize, right: usize) -> RgbaImage {
        let width = self.w - left - right;
        let mut image = RgbaImage::new(width as u32, height as u32);
        let mut y = 0;
        'parts: for part in &self.parts {
            for row in 0..part.rows {
                if y >= height {
                    break 'parts;
                }
                let src = &part.pixels[row * self.w + left..row * self.w + left + width];
                let dst = &mut image.as_mut()[y * width * 4..(y + 1) * width * 4];
                for (px, out) in src.iter().zip(dst.chunks_exact_mut(4)) {
                    let [bl, g, r, _] = px.to_le_bytes();
                    out.copy_from_slice(&[r, g, bl, 255]);
                }
                y += 1;
            }
        }
        image
    }
}

// Luminosité d'un pixel, en millièmes de niveau
fn luma(pixel: u32) -> i64 {
    ((pixel >> 16) & 0xFF) as i64 * 299 + ((pixel >> 8) & 0xFF) as i64 * 587 + (pixel & 0xFF) as i64 * 114
}

// ------------------------------------------------------------------------------------------ interface

/// Détection des zones et capture défilante (même interface que l'ancien assistant C#).
pub struct Zones {
    jobs: Mutex<Option<Sender<Job>>>,
    stop: Arc<AtomicBool>,
}

impl Zones {
    pub fn new() -> Arc<Self> {
        Arc::new(Zones { jobs: Mutex::new(None), stop: Arc::new(AtomicBool::new(false)) })
    }

    /// Démarre le fil UI Automation (au démarrage de Snapit, pour que la première recherche soit rapide).
    pub fn start(&self) {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.is_some() {
            return;
        }
        let (tx, rx) = channel();
        let stop = self.stop.clone();
        let spawned = std::thread::Builder::new().name("snapit-zones".into()).spawn(move || {
            if let Ok(worker) = Worker::new() {
                worker.run(rx, stop);
            }
        });
        if spawned.is_ok() {
            *jobs = Some(tx);
        }
    }

    pub fn running(&self) -> bool {
        self.jobs.lock().unwrap().is_some()
    }

    fn send(&self, job: Job) -> bool {
        self.start();
        self.jobs.lock().unwrap().as_ref().is_some_and(|tx| tx.send(job).is_ok())
    }

    /// Fenêtres visibles, de la plus haute à la plus basse (nouvelle sélection : les éléments qui défilent trouvés
    /// pour la précédente sont oubliés).
    pub async fn windows(&self) -> Option<Vec<Value>> {
        self.send(Job::Forget);
        let list = tauri::async_runtime::spawn_blocking(list_windows).await.ok()?;
        // les pages Chromium visibles sont « réveillées » pendant que l'overlay se prépare
        self.send(Job::Warm(list.iter().filter_map(|w| w["hwnd"].as_i64()).take(12).collect()));
        Some(list)
    }

    /// Éléments d'interface de la fenêtre `hwnd` sous le point, du plus grand au plus petit :
    /// [x, y, l, h, type, n] ; n > 0 pour un élément qui défile (voir scroll_capture).
    pub async fn probe(&self, hwnd: i64, x: f64, y: f64) -> Option<Vec<Value>> {
        let (reply, rx) = oneshot::channel();
        if !self.send(Job::Probe { hwnd, x: x.round() as i32, y: y.round() as i32, reply }) {
            return None;
        }
        tokio::time::timeout(PROBE_TIMEOUT, rx).await.ok()?.ok().flatten()
    }

    /// Capture défilante de l'élément n (donné par probe), visible dans la zone [x, y, l, h] (pixels physiques)
    /// d'un écran à l'échelle `scale`.
    pub async fn scroll_capture(&self, n: i64, area: [i32; 4], scale: f64, progress: impl Fn(f64) + Send + 'static) -> Option<ScrollResult> {
        let (reply, rx) = oneshot::channel();
        if !self.send(Job::Scroll { n, area, scale, progress: Box::new(progress), reply }) {
            return None;
        }
        tokio::time::timeout(SCROLL_TIMEOUT, rx).await.ok()?.ok().flatten()
    }

    /// Arrête la capture défilante en cours : ce qui est déjà capturé est gardé.
    pub fn stop_scroll(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        self.jobs.lock().unwrap().take(); // le fil se termine avec son canal
    }
}
