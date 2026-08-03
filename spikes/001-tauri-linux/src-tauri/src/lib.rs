#[tauri::command]
fn runtime_label() -> &'static str {
    "Tauri 2 native boundary active"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![runtime_label])
        .run(tauri::generate_context!())
        .expect("failed to run Motion Tauri spike");
}
