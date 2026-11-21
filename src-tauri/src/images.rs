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

/// JPEG directement depuis des pixels BGRA (capture d'écran), avec l'encodeur SIMD de jpeg-encoder.
pub fn encode_jpeg_bgra(bgra: &[u8], width: u16, height: u16, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2); // couleurs à demi-résolution (4:2:0)
    let _ = encoder.encode(bgra, width, height, jpeg_encoder::ColorType::Bgra);
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

pub fn write_clipboard(image: &RgbaImage) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData { width: image.width() as usize, height: image.height() as usize, bytes: image.as_raw().into() })
        .map_err(|e| e.to_string())
}

pub fn write_clipboard_png(png: &[u8]) -> Result<(), String> {
    let image = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
    write_clipboard(&image)
}

pub fn read_clipboard() -> Option<RgbaImage> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let data = clipboard.get_image().ok()?;
    RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
}
