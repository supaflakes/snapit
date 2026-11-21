use std::{env, fs, path::PathBuf, process::Command};

// Les traductions viennent de src/i18n.js, partagé avec les pages : on les exporte en JSON pour le code Rust.
fn export_i18n() {
    let source = PathBuf::from("../src/i18n.js");
    println!("cargo:rerun-if-changed={}", source.display());
    let script = "const I=require(process.argv[1]);process.stdout.write(JSON.stringify(I.STRINGS))";
    let absolute = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join(&source);
    let output = Command::new("node")
        .args(["-e", script, &absolute.to_string_lossy()])
        .output()
        .expect("node est nécessaire pour exporter les traductions");
    assert!(output.status.success(), "export des traductions : {}", String::from_utf8_lossy(&output.stderr));
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("i18n.json");
    fs::write(out, output.stdout).unwrap();
}

fn main() {
    export_i18n();
    println!("cargo:rerun-if-changed=../src/bridge.js");
    tauri_build::build()
}
