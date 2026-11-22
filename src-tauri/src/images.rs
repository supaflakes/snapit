// Encodage des images (PNG, miniatures JPEG) et presse-papiers.
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{DynamicImage, ImageEncoder, RgbaImage};

use crate::library::{THUMB_HEIGHT, THUMB_WIDTH};

/// PNG rapide à produire (la capture doit s'ouvrir vite ; l'éditeur réenregistre ensuite l'image annotée).
pub fn encode_png(image: &RgbaImage) -> Vec<u8> {
    let mut out = Vec::new();
    let encoder = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Up);
    let _ = encoder.write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8);
    out
}

pub fn encode_jpeg(image: &DynamicImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let rgb = image.to_rgb8();
    let _ = JpegEncoder::new_with_quality(&mut out, quality).encode_image(&rgb);
    out
}

/// Miniature de la galerie (l'éditeur la régénère ensuite à chaque modification).
pub fn thumbnail_jpeg(image: &RgbaImage) -> Vec<u8> {
    let ratio = (THUMB_WIDTH as f64 / image.width() as f64).min(THUMB_HEIGHT as f64 / image.height() as f64).min(1.0);
    let w = ((image.width() as f64 * ratio).round() as u32).max(1);
    let h = ((image.height() as f64 * ratio).round() as u32).max(1);
    let thumb = image::imageops::thumbnail(image, w, h);
    encode_jpeg(&DynamicImage::ImageRgba8(thumb), 85)
}

pub fn data_url(mime: &str, data: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data))
}

/// Octets d'une URL data: (ou de base64 brut).
pub fn from_data_url(text: &str) -> Option<Vec<u8>> {
    let text = text.find(',').map_or(text, |i| &text[i + 1..]);
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// Met l'image dans le presse-papiers, en PNG (déjà encodé : arboard réencoderait l'image, lentement, en
/// occupant le processeur pendant que l'éditeur affiche la capture) et en bitmap (CF_DIBV5) pour les autres
/// applications.
pub fn write_clipboard(image: &RgbaImage, png: &[u8]) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::Graphics::Gdi::{BITMAPV5HEADER, BI_BITFIELDS};
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::System::Memory::*;
    use windows::Win32::System::Ole::CF_DIBV5;

    // copie dans un bloc de mémoire global, remis au presse-papiers (qui en devient propriétaire)
    unsafe fn put(format: u32, size: usize, fill: impl FnOnce(&mut [u8])) -> Result<(), String> {
        let memory: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, size).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(memory) as *mut u8;
        if ptr.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err("GlobalLock".into());
        }
        fill(std::slice::from_raw_parts_mut(ptr, size));
        let _ = GlobalUnlock(memory);
        if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
            let _ = GlobalFree(Some(memory));
            return Err("SetClipboardData".into());
        }
        Ok(())
    }

    let (w, h) = (image.width() as usize, image.height() as usize);
    let header = BITMAPV5HEADER {
        bV5Size: std::mem::size_of::<BITMAPV5HEADER>() as u32,
        bV5Width: w as i32,
        bV5Height: h as i32, // de bas en haut : Word ne colle pas les images de hauteur négative
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5SizeImage: (w * h * 4) as u32,
        bV5RedMask: 0x00ff0000,
        bV5GreenMask: 0x0000ff00,
        bV5BlueMask: 0x000000ff,
        bV5AlphaMask: 0xff000000,
        bV5CSType: 0x7352_4742, // LCS_sRGB
        bV5Intent: 4,           // LCS_GM_IMAGES
        ..Default::default()
    };
    let header_bytes = unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, std::mem::size_of::<BITMAPV5HEADER>()) };
    unsafe {
        // un autre programme peut tenir le presse-papiers un instant
        let mut opened = false;
        for _ in 0..20 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !opened {
            return Err("presse-papiers occupé".into());
        }
        let result = (|| {
            EmptyClipboard().map_err(|e| e.to_string())?;
            // PNG d'abord : beaucoup d'applications prennent le premier format proposé
            put(RegisterClipboardFormatW(w!("PNG")), png.len(), |out| out.copy_from_slice(png))?;
            let stride = w * 4;
            put(CF_DIBV5.0 as u32, header_bytes.len() + stride * h, |out| {
                out[..header_bytes.len()].copy_from_slice(header_bytes);
                let dst = &mut out[header_bytes.len()..];
                for (y, row) in image.as_raw().chunks_exact(stride).enumerate() {
                    let line = &mut dst[(h - 1 - y) * stride..(h - y) * stride];
                    for (d, s) in line.chunks_exact_mut(4).zip(row.chunks_exact(4)) {
                        d[0] = s[2];
                        d[1] = s[1];
                        d[2] = s[0];
                        d[3] = s[3];
                    }
                }
            })
        })();
        let _ = CloseClipboard();
        result
    }
}

pub fn write_clipboard_png(png: &[u8]) -> Result<(), String> {
    let image = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
    write_clipboard(&image, png)
}

pub fn read_clipboard() -> Option<RgbaImage> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let data = clipboard.get_image().ok()?;
    RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
}
