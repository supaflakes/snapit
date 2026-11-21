// Capture par duplication du bureau (DXGI Desktop Duplication) : l'image composée par Windows est copiée
// directement depuis la carte graphique, bien plus vite qu'avec GDI. Les duplications sont ouvertes une fois et
// gardées, sur un fil dédié (les objets Direct3D y restent). En cas d'échec (écran tourné, bureau sécurisé, accès
// perdu…), la capture repasse par GDI.
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::System::Performance::QueryPerformanceCounter;

struct Output {
    rect: RECT,
    rotated: bool,
    output: IDXGIOutput1,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: Option<IDXGIOutputDuplication>,
    staging: Option<ID3D11Texture2D>,
    last_present: i64, // horodatage (QPC) de l'image gardée dans `staging`
    has_frame: bool,
}

struct Request {
    rect: [i32; 4],
    // l'image doit être postérieure à cet instant (QPC) : nos fenêtres viennent d'être retirées de la capture
    after: Option<i64>,
    reply: Sender<Option<Vec<u8>>>,
}

static WORKER: OnceLock<Mutex<Sender<Request>>> = OnceLock::new();

/// Instant présent (QPC), à passer à `grab` après avoir retiré des fenêtres de la capture.
pub fn now() -> i64 {
    let mut t = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut t);
    }
    t
}

fn worker() -> &'static Mutex<Sender<Request>> {
    WORKER.get_or_init(|| {
        let (tx, rx) = channel::<Request>();
        std::thread::Builder::new()
            .name("snapit-dxgi".into())
            .spawn(move || {
                let mut outputs = open_outputs();
                for request in rx {
                    if !outputs.iter().any(|o| same_rect(&o.rect, request.rect)) {
                        outputs = open_outputs(); // écrans ajoutés, retirés ou déplacés : tout est rouvert
                    }
                    let _ = request.reply.send(grab_on(&mut outputs, request.rect, request.after));
                }
            })
            .expect("fil de capture");
        Mutex::new(tx)
    })
}

/// Prépare les duplications à l'avance (au démarrage), pour que la première capture soit rapide.
pub fn warm_up() {
    let _ = worker();
}

/// Pixels BGRA opaques de l'écran [x, y, l, h] (pixels physiques), ou None si DXGI ne sait pas le capturer.
pub fn grab(rect: [i32; 4], after: Option<i64>) -> Option<Vec<u8>> {
    let (tx, rx) = channel();
    worker().lock().unwrap().send(Request { rect, after, reply: tx }).ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

/// Écrans de chaque carte graphique, chacun avec le périphérique Direct3D de sa carte (indispensable sur les
/// portables à deux cartes graphiques).
fn open_outputs() -> Vec<Output> {
    let mut list = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return list };
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            a += 1;
            let mut device = None;
            let mut context = None;
            let created = D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            let (Ok(()), Some(device), Some(context)) = (created, device, context) else { continue };
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                o += 1;
                let Ok(desc) = output.GetDesc() else { continue };
                if !desc.AttachedToDesktop.as_bool() {
                    continue;
                }
                let Ok(output) = output.cast::<IDXGIOutput1>() else { continue };
                let rotated = !matches!(desc.Rotation, DXGI_MODE_ROTATION_IDENTITY | DXGI_MODE_ROTATION_UNSPECIFIED);
                let duplication = output.DuplicateOutput(&device).ok();
                list.push(Output {
                    rect: desc.DesktopCoordinates,
                    rotated,
                    output,
                    device: device.clone(),
                    context: context.clone(),
                    duplication,
                    staging: None,
                    last_present: 0,
                    has_frame: false,
                });
            }
        }
    }
    list
}

fn same_rect(r: &RECT, [x, y, w, h]: [i32; 4]) -> bool {
    r.left == x && r.top == y && r.right - r.left == w && r.bottom - r.top == h
}

fn grab_on(outputs: &mut [Output], [x, y, w, h]: [i32; 4], after: Option<i64>) -> Option<Vec<u8>> {
    let out = outputs.iter_mut().find(|o| same_rect(&o.rect, [x, y, w, h]))?;
    if out.rotated {
        return None; // image tournée : GDI la donne déjà dans le bon sens
    }
    unsafe {
        if out.duplication.is_none() {
            out.duplication = out.output.DuplicateOutput(&out.device).ok();
        }
        let duplication = out.duplication.clone()?;
        let deadline = Instant::now() + Duration::from_millis(150);
        loop {
            let fresh_enough = out.has_frame && after.is_none_or(|t| out.last_present >= t);
            let remaining = deadline.saturating_duration_since(Instant::now());
            // une image déjà gardée suffit : on prend seulement la plus récente s'il y en a une
            let wait = if fresh_enough { 0 } else { remaining.as_millis() as u32 };
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            match duplication.AcquireNextFrame(wait, &mut info, &mut resource) {
                Ok(()) => {
                    let copied = (|| -> Option<()> {
                        // LastPresentTime nul : seule la souris a bougé, l'image n'a pas changé
                        if info.LastPresentTime != 0 || !out.has_frame {
                            let texture: ID3D11Texture2D = resource?.cast().ok()?;
                            if out.staging.is_none() {
                                let mut desc = D3D11_TEXTURE2D_DESC::default();
                                texture.GetDesc(&mut desc);
                                desc.Usage = D3D11_USAGE_STAGING;
                                desc.BindFlags = 0;
                                desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                                desc.MiscFlags = 0;
                                desc.MipLevels = 1;
                                desc.ArraySize = 1;
                                desc.SampleDesc = DXGI_SAMPLE_DESC { Count: 1, Quality: 0 };
                                let mut staging = None;
                                out.device.CreateTexture2D(&desc, None, Some(&mut staging)).ok()?;
                                out.staging = staging;
                            }
                            out.context.CopyResource(out.staging.as_ref()?, &texture);
                            out.has_frame = true;
                            out.last_present = out.last_present.max(info.LastPresentTime);
                        }
                        Some(())
                    })();
                    let _ = duplication.ReleaseFrame();
                    copied?;
                }
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    if fresh_enough {
                        break; // rien de neuf depuis : l'image gardée est l'écran actuel
                    }
                    if Instant::now() >= deadline {
                        return None; // aucune image assez récente : GDI prendra le relais
                    }
                }
                Err(_) => {
                    // accès perdu (changement de mode, bureau sécurisé…) : rouverte à la prochaine capture
                    out.duplication = None;
                    out.staging = None;
                    out.has_frame = false;
                    return None;
                }
            }
            if out.has_frame && after.is_none_or(|t| out.last_present >= t) {
                break;
            }
        }
        read_staging(out, w as usize, h as usize)
    }
}

unsafe fn read_staging(out: &Output, w: usize, h: usize) -> Option<Vec<u8>> {
    let staging = out.staging.as_ref()?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    staging.GetDesc(&mut desc);
    if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.Width as usize != w || desc.Height as usize != h {
        return None; // écran HDR (autre format) ou taille inattendue : GDI s'en charge
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    out.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ok()?;
    let mut pixels = vec![0u8; w * h * 4];
    let src = mapped.pData as *const u8;
    for row in 0..h {
        std::ptr::copy_nonoverlapping(src.add(row * mapped.RowPitch as usize), pixels.as_mut_ptr().add(row * w * 4), w * 4);
    }
    out.context.Unmap(staging, 0);
    for alpha in pixels.iter_mut().skip(3).step_by(4) {
        *alpha = 255;
    }
    Some(pixels)
}
