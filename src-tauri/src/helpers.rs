// Assistants natifs C# (src/native/*.cs), repris tels quels de la version Electron en attendant leur portage en
// Rust : compilés au premier lancement avec le compilateur du .NET Framework fourni avec Windows, une fois par
// version de leur source, puis pilotés par des lignes de texte sur leur entrée et leur sortie standard.
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::win::CREATE_NO_WINDOW;

pub const REGIONS_SOURCE: &str = include_str!("../../src/native/regions.cs");
// UI Automation et les types WPF qu'il utilise, et GDI+ pour la capture défilante
pub const REGIONS_REFERENCES: &[&str] = &[r"WPF\UIAutomationClient.dll", r"WPF\UIAutomationTypes.dll", r"WPF\WindowsBase.dll", "System.Drawing.dll"];

fn framework_dir() -> Option<PathBuf> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
    ["Framework64", "Framework"]
        .iter()
        .map(|f| Path::new(&windir).join("Microsoft.NET").join(f).join("v4.0.30319"))
        .find(|dir| dir.join("csc.exe").exists())
}

/// Compile l'assistant s'il ne l'est pas encore pour cette version de sa source ; renvoie son exécutable.
pub fn build_helper(dir: &Path, name: &str, source: &str, references: &[&str]) -> Result<PathBuf, String> {
    let hash = sha1_smol::Sha1::from(source).digest().to_string();
    let exe = dir.join(format!("{name}-{}.exe", &hash[..10]));
    if exe.exists() {
        return Ok(exe);
    }
    let framework = framework_dir().ok_or("csc.exe introuvable")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let src = dir.join(format!("{name}.cs"));
    std::fs::write(&src, source).map_err(|e| e.to_string())?;
    let mut args = vec!["/nologo".to_string(), "/optimize".into(), "/target:exe".into(), format!("/out:{}", exe.display())];
    args.extend(references.iter().map(|r| format!("/r:{}", framework.join(r).display())));
    args.push(src.display().to_string());
    let out = Command::new(framework.join("csc.exe")).args(&args).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stdout).into());
    }
    // supprime les versions précédentes de l'assistant
    if let Ok(items) = std::fs::read_dir(dir) {
        for item in items.flatten() {
            let file = item.file_name().to_string_lossy().to_string();
            if file.starts_with(&format!("{name}-")) && file.ends_with(".exe") && item.path() != exe {
                let _ = std::fs::remove_file(item.path());
            }
        }
    }
    Ok(exe)
}

/// Processus assistant : une ligne par message dans chaque sens. Se ferme quand on ferme son entrée standard.
pub struct LineProcess {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pub pid: u32,
}

impl LineProcess {
    /// Démarre l'assistant ; `on_line` reçoit chaque ligne (dans un fil dédié), `on_exit` est appelé à sa fin.
    pub fn spawn(exe: &Path, on_line: impl Fn(String) + Send + 'static, on_exit: impl FnOnce() + Send + 'static) -> Result<Arc<Self>, String> {
        Self::spawn_with(exe, &[], on_line, on_exit)
    }

    pub fn spawn_with(exe: &Path, args: &[&str], on_line: impl Fn(String) + Send + 'static, on_exit: impl FnOnce() + Send + 'static) -> Result<Arc<Self>, String> {
        let mut child = Command::new(exe)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("sortie indisponible")?;
        let process = Arc::new(LineProcess { stdin: Mutex::new(child.stdin.take()), pid: child.id(), child: Mutex::new(Some(child)) });
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let line = line.trim().to_string();
                if !line.is_empty() {
                    on_line(line);
                }
            }
            on_exit();
        });
        Ok(process)
    }

    pub fn write(&self, line: &str) -> bool {
        let mut stdin = self.stdin.lock().unwrap();
        let Some(pipe) = stdin.as_mut() else { return false };
        let ok = pipe.write_all(line.as_bytes()).and_then(|_| pipe.flush()).is_ok();
        if !ok {
            *stdin = None;
        }
        ok
    }

    pub fn stop(&self) {
        self.stdin.lock().unwrap().take(); // l'assistant se ferme de lui-même
        if let Some(mut child) = self.child.lock().unwrap().take() {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.kill();
                }
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------- zones

const WINDOWS_TIMEOUT: Duration = Duration::from_millis(500); // au-delà, la capture se fait sans détection
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const SCROLL_TIMEOUT: Duration = Duration::from_secs(20); // sans nouvelles de la capture défilante

/// Assistant « zones » (regions.cs) : fenêtres visibles, éléments d'interface sous la souris (UI Automation),
/// capture défilante.
pub struct Regions {
    dir: PathBuf,
    process: Mutex<Option<Arc<LineProcess>>>,
    starting: Mutex<bool>,
    pending: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Value>>>>,
    seq: AtomicU64,
}

impl Regions {
    pub fn new(dir: PathBuf) -> Arc<Self> {
        Arc::new(Regions { dir, process: Mutex::new(None), starting: Mutex::new(false), pending: Default::default(), seq: AtomicU64::new(0) })
    }

    pub fn running(&self) -> bool {
        self.process.lock().unwrap().is_some()
    }

    pub fn pid(&self) -> Option<u32> {
        self.process.lock().unwrap().as_ref().map(|p| p.pid)
    }

    /// Compile (au premier lancement) et démarre l'assistant, en arrière-plan.
    pub fn start(self: &Arc<Self>) {
        {
            let mut starting = self.starting.lock().unwrap();
            if *starting || self.running() {
                return;
            }
            *starting = true;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let _ = me.launch();
            *me.starting.lock().unwrap() = false;
        });
    }

    fn launch(self: &Arc<Self>) -> Result<(), String> {
        let exe = build_helper(&self.dir, "regions", REGIONS_SOURCE, REGIONS_REFERENCES)?;
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let pending = self.pending.clone();
        let pending_exit = self.pending.clone();
        let me = Arc::downgrade(self);
        let process = LineProcess::spawn(
            &exe,
            move |line| {
                if line == "ready" {
                    let _ = ready_tx.send(());
                    return;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else { return };
                let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
                if let Some(tx) = pending.lock().unwrap().get(&id) {
                    let _ = tx.send(message);
                }
            },
            move || {
                if let Some(me) = me.upgrade() {
                    me.process.lock().unwrap().take();
                }
                pending_exit.lock().unwrap().clear(); // demandes restées sans réponse : abandonnées
            },
        )?;
        if ready_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            process.stop();
            return Err("assistant muet".into());
        }
        *self.process.lock().unwrap() = Some(process);
        Ok(())
    }

    /// Envoie une demande ; `on_progress` reçoit les messages d'avancement, qui repoussent chacun le délai.
    async fn request(self: &Arc<Self>, command: impl FnOnce(u64) -> String, timeout: Duration, on_progress: Option<&(dyn Fn(f64) + Sync)>) -> Option<Value> {
        let process = self.process.lock().unwrap().clone();
        let Some(process) = process else {
            self.start(); // arrêté ou pas encore prêt : disponible pour la prochaine capture
            return None;
        };
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.pending.lock().unwrap().insert(id, tx);
        let result = async {
            if !process.write(&command(id)) {
                return None;
            }
            loop {
                let message = tokio::time::timeout(timeout, rx.recv()).await.ok().flatten()?;
                match (message.get("progress").and_then(Value::as_f64), on_progress) {
                    (Some(value), Some(progress)) => progress(value),
                    _ => return Some(message),
                }
            }
        }
        .await;
        self.pending.lock().unwrap().remove(&id);
        result
    }

    /// Fenêtres visibles, de la plus haute à la plus basse.
    pub async fn windows(self: &Arc<Self>) -> Option<Vec<Value>> {
        let message = self.request(|id| format!("windows {id}\n"), WINDOWS_TIMEOUT, None).await?;
        message.get("windows")?.as_array().cloned()
    }

    /// Éléments d'interface de la fenêtre `hwnd` sous le point, du plus grand au plus petit.
    pub async fn probe(self: &Arc<Self>, hwnd: i64, x: f64, y: f64) -> Option<Vec<Value>> {
        let message = self.request(|id| format!("at {id} {hwnd} {} {}\n", x.round(), y.round()), PROBE_TIMEOUT, None).await?;
        message.get("chain")?.as_array().cloned()
    }

    /// Capture défilante de l'élément n, visible dans la zone [x, y, l, h] (pixels physiques) : l'image assemblée
    /// est enregistrée dans `file`. Renvoie { width, height, end }.
    pub async fn scroll_capture(self: &Arc<Self>, n: i64, [x, y, w, h]: [i32; 4], scale: f64, file: &Path, on_progress: &(dyn Fn(f64) + Sync)) -> Option<Value> {
        let file = file.display().to_string();
        let message = self.request(|id| format!("scroll {id} {n} {scale} {x} {y} {w} {h} {file}\n"), SCROLL_TIMEOUT, Some(on_progress)).await?;
        message.get("done").cloned()
    }

    /// Arrête la capture défilante en cours : ce qui est déjà capturé est gardé.
    pub fn stop_scroll(&self) {
        if let Some(p) = self.process.lock().unwrap().as_ref() {
            p.write("stop\n");
        }
    }

    pub fn stop(&self) {
        if let Some(p) = self.process.lock().unwrap().take() {
            p.stop();
        }
    }
}
