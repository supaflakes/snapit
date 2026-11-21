// Traductions : les mêmes que les pages (src/i18n.js), exportées en JSON à la compilation (build.rs).
use std::collections::HashMap;
use std::sync::OnceLock;

type Strings = HashMap<String, HashMap<String, String>>;

fn strings() -> &'static Strings {
    static STRINGS: OnceLock<Strings> = OnceLock::new();
    STRINGS.get_or_init(|| serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/i18n.json"))).unwrap_or_default())
}

/// Langue effective : celle des paramètres, sinon celle du système (français ou anglais).
pub fn resolve(language: &str) -> String {
    if strings().contains_key(language) {
        return language.to_string();
    }
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if locale.starts_with("fr") { "fr".into() } else { "en".into() }
}

pub fn t(lang: &str, key: &str, params: &[(&str, &str)]) -> String {
    let all = strings();
    let mut text = all
        .get(lang)
        .and_then(|s| s.get(key))
        .or_else(|| all.get("fr").and_then(|s| s.get(key)))
        .cloned()
        .unwrap_or_else(|| key.to_string());
    for (name, value) in params {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

/// « Shift+PrintScreen » → « Maj+Impr. écran »
pub fn format_accelerator(lang: &str, accelerator: &str) -> String {
    if accelerator.is_empty() {
        return String::new();
    }
    let has = |key: &str| strings().get(lang).is_some_and(|s| s.contains_key(key));
    accelerator
        .split('+')
        .map(|part| {
            let key = format!("key.{part}");
            if has(&key) { t(lang, &key, &[]) } else { part.to_string() }
        })
        .collect::<Vec<_>>()
        .join("+")
}
