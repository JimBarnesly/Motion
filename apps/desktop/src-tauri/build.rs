use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();
    let policy_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("../../../packages/core/src/attachment-policy.ts");
    println!("cargo:rerun-if-changed={}", policy_path.display());
    let source = fs::read_to_string(&policy_path).expect("shared attachment policy");
    let expression = source.lines().find_map(|line| line.strip_prefix("export const MAX_ATTACHMENT_BYTES = "))
        .and_then(|value| value.strip_suffix(';')).expect("MAX_ATTACHMENT_BYTES declaration");
    let bytes = expression.split('*').map(|part| part.trim().parse::<usize>().expect("numeric attachment policy factor")).product::<usize>();
    let output = PathBuf::from(env::var("OUT_DIR").expect("build output")).join("attachment_policy.rs");
    fs::write(output, format!("pub const MAX_ATTACHMENT_BYTES: usize = {bytes};\n")).expect("generated attachment policy");
}
