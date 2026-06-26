#[tauri::command]
fn check_runtime(host: String, tcp_port: u16, udp_port: u16) -> String {
    format!(
        "Tauri invoke 通道正常。下一步将连接聊天服务器: host={}, tcp={}, udp={}",
        host, tcp_port, udp_port
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![check_runtime])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
