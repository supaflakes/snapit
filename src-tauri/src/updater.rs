// Mise à jour automatique : Snapit vérifie au démarrage puis toutes les 6 heures si une nouvelle version est publiée
// sur GitHub (latest.json, signé avec la clé de Snapit). Si oui, une notification le signale et le menu de l'icône
// propose de l'installer : rien n'est téléchargé ni installé sans que l'utilisateur le demande.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{app, t};

const FIRST_CHECK: Duration = Duration::from_secs(30); // sans ralentir le démarrage
const EVERY: Duration = Duration::from_secs(6 * 3600);

static PENDING: Mutex<Option<Update>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);

pub fn start() {
    // ni pendant les tests, ni en développement (la version de développement n'est pas publiée)
    if cfg!(debug_assertions) || crate::selftest::enabled() || crate::measure::enabled() {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(FIRST_CHECK).await;
        if !load_plugin() {
            return;
        }
        loop {
            check().await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Charge le plugin de mise à jour. Il ne l'est qu'au moment de la première vérification : sa préparation (client
/// HTTPS) retarderait l'ouverture de Snapit d'une demi-seconde.
pub fn load_plugin() -> bool {
    static LOADED: Mutex<bool> = Mutex::new(false);
    let mut loaded = LOADED.lock().unwrap();
    if !*loaded {
        *loaded = app().handle.plugin(tauri_plugin_updater::Builder::new().build()).is_ok();
    }
    *loaded
}

async fn check() {
    if PENDING.lock().unwrap().is_some() || !load_plugin() {
        return;
    }
    let Ok(updater) = app().handle.updater() else { return };
    // hors ligne, GitHub indisponible… : on réessaiera plus tard, sans rien afficher
    let Ok(Some(update)) = updater.check().await else { return };
    let version = update.version.clone();
    *PENDING.lock().unwrap() = Some(update);
    crate::refresh_tray();
    crate::notify(&t("update.title", &[("version", &version)]), &t("update.body", &[("version", &version)]));
}

/// Version prête à être installée, proposée dans le menu de l'icône.
pub fn pending_version() -> Option<String> {
    PENDING.lock().unwrap().as_ref().map(|u| u.version.clone())
}

/// Télécharge et installe la mise à jour : les fenêtres de l'éditeur sont d'abord fermées (avec la confirmation
/// habituelle s'il reste des modifications non enregistrées), puis l'installateur remplace Snapit et le relance.
pub fn install() {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let outcome = async {
            let update = PENDING.lock().unwrap().take().ok_or("aucune mise à jour")?;
            let bytes = match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    *PENDING.lock().unwrap() = Some(update);
                    return Err(e.to_string());
                }
            };
            for label in crate::editors::labels() {
                if !crate::editors::close(&label).await {
                    // fermeture annulée : la mise à jour reste proposée
                    *PENDING.lock().unwrap() = Some(update);
                    return Ok(());
                }
            }
            app().quitting.store(true, Ordering::SeqCst);
            // Windows : l'installateur prend le relais et Snapit se ferme
            update.install(bytes).map_err(|e| e.to_string())
        }
        .await;
        INSTALLING.store(false, Ordering::SeqCst);
        if let Err(err) = outcome {
            app().quitting.store(false, Ordering::SeqCst);
            crate::error_box(&t("error.update", &[]), &err);
        }
    });
}
