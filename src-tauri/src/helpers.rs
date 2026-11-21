// Processus auxiliaire piloté par des lignes de texte sur son entrée et sa sortie standard (le hook clavier,
// voir keyhook.rs).
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::win::CREATE_NO_WINDOW;

/// Processus assistant : une ligne par message dans chaque sens. Se ferme quand on ferme son entrée standard.
pub struct LineProcess {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pub pid: u32,
}

impl LineProcess {
    /// Démarre le processus ; `on_line` reçoit chaque ligne (dans un fil dédié), `on_exit` est appelé à sa fin.
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
