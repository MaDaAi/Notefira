use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

fn secret_entry(name: &str) -> Result<keyring::Entry, String> {
    if name.is_empty() || name.len() > 100 {
        return Err("Invalid secret name".into());
    }
    keyring::Entry::new("com.notefira.app", name).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    match secret_entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    secret_entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    match secret_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only web and e-mail links are allowed".into());
    }
    webbrowser::open(&url).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn take_opened_files(state: tauri::State<'_, LaunchFiles>) -> Vec<String> {
    let mut files = state.0.lock().expect("launch-file mutex poisoned");
    std::mem::take(&mut *files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LaunchFiles::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            open_external,
            take_opened_files
        ])
        .setup(|app| {
            let launch_files: Vec<String> = std::env::args()
                .skip(1)
                .filter(|arg| arg.ends_with(".notefira") || arg.ends_with(".pdf"))
                .collect();
            *app.state::<LaunchFiles>().0.lock().expect("launch-file mutex poisoned") = launch_files;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Notefira");
}

