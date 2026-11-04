use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

fn codex_path() -> String {
    let mut probe = Command::new("codex");
    probe
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        probe.creation_flags(0x08000000);
    }
    if probe.status().is_ok_and(|status| status.success()) {
        return "codex".into();
    }
    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let root = std::path::PathBuf::from(base)
            .join("OpenAI")
            .join("Codex")
            .join("bin");
        if let Ok(entries) = std::fs::read_dir(root) {
            let mut paths: Vec<_> = entries
                .flatten()
                .map(|e| e.path().join("codex.exe"))
                .filter(|p| p.is_file())
                .collect();
            paths.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
            if let Some(path) = paths.last() {
                return path.to_string_lossy().into_owned();
            }
        }
    }
    "codex".into()
}

#[tauri::command]
async fn read_usage() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut command = Command::new(codex_path());
        command.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|_| "No se encontró Codex CLI. Instala Codex o agrégalo al PATH y vuelve a intentarlo.".to_string())?;
        let mut input = child.stdin.take().ok_or("No se pudo abrir la conexión con Codex")?;
        let output = child.stdout.take().ok_or("No se pudo leer la respuesta de Codex")?;
        writeln!(input, "{}", serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_usage_glance","title":"GoutenShadow Codex Usage","version":"0.3.1"}}})).map_err(|_| "No se pudo iniciar Codex".to_string())?;
        input.flush().map_err(|_| "No se pudo iniciar Codex".to_string())?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if value.get("id").and_then(|v| v.as_i64()) == Some(1) {
                        if value.get("error").is_some() { let _ = tx.send(Err("No se pudo inicializar Codex".to_string())); break; }
                        let _ = writeln!(input, "{}", serde_json::json!({"method":"initialized","params":{}}));
                        let _ = writeln!(input, "{}", serde_json::json!({"id":2,"method":"account/rateLimits/read"}));
                        let _ = input.flush();
                    } else if value.get("id").and_then(|v| v.as_i64()) == Some(2) {
                        let result = if value.get("error").is_some() { Err("Codex no pudo consultar los límites. Comprueba tu sesión de ChatGPT en Codex.".to_string()) } else { value.get("result").cloned().ok_or("Respuesta incompleta de Codex".to_string()) };
                        let _ = tx.send(result); break;
                    }
                }
            }
        });
        let result = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| Err("Codex tardó demasiado en responder. Revisa tu conexión y vuelve a intentarlo.".into()));
        let _ = child.kill();
        let _ = child.wait();
        result
    }).await.map_err(|_| "No se pudo ejecutar la consulta".to_string())?
}

fn handle_tray_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    let app = tray.app_handle();
    match event {
        TrayIconEvent::Enter { position, .. } | TrayIconEvent::Move { position, .. } => {
            if let Some(peek) = app.get_webview_window("peek") {
                if !peek.is_visible().unwrap_or(false) {
                    if let Ok(Some(monitor)) = app.monitor_from_point(position.x, position.y) {
                        let mpos = monitor.position();
                        let msize = monitor.size();
                        let size = peek
                            .outer_size()
                            .unwrap_or(tauri::PhysicalSize::new(410, 270));
                        let x = (position.x as i32 - size.width as i32 / 2).clamp(
                            mpos.x,
                            (mpos.x + msize.width as i32 - size.width as i32).max(mpos.x),
                        );
                        let y = if position.y > (mpos.y as f64 + msize.height as f64 / 2.0) {
                            position.y as i32 - size.height as i32 - 20
                        } else {
                            position.y as i32 + 25
                        };
                        let _ = peek.set_position(tauri::PhysicalPosition::new(x, y.max(mpos.y)));
                    }
                    let _ = peek.show();
                }
            }
        }
        TrayIconEvent::Leave { .. } => {
            if let Some(peek) = app.get_webview_window("peek") {
                let _ = peek.hide();
            }
        }
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => {
            if let Some(peek) = app.get_webview_window("peek") {
                let _ = peek.hide();
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        _ => (),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![read_usage])
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let peek = tauri::WebviewWindowBuilder::new(
                app,
                "peek",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("GoutenShadow Codex Usage · Vista rápida")
            .inner_size(410.0, 270.0)
            .decorations(false)
            .resizable(false)
            .visible(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .build()?;
            let _ = peek.set_ignore_cursor_events(true);
            TrayIconBuilder::with_id("dragon")
                .icon(
                    app.default_window_icon()
                        .ok_or("No se encontró el icono")?
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => (),
                })
                .on_tray_icon_event(handle_tray_event)
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar la aplicación");
}
