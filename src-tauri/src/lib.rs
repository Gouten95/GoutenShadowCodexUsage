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
        writeln!(input, "{}", serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_usage_glance","title":"GoutenShadow Codex Usage","version":env!("CARGO_PKG_VERSION")}}})).map_err(|_| "No se pudo iniciar Codex".to_string())?;
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

#[tauri::command]
fn set_floating_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("floating")
        .ok_or("No se encontró la ventana flotante")?;
    if visible {
        window.show()
    } else {
        window.hide()
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_floating_compact(
    app: tauri::AppHandle,
    compact: bool,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("floating")
        .ok_or("No se encontró la ventana flotante")?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let (min_width, min_height, default_width, default_height) = if compact {
        (160.0_f64, 100.0_f64, 260.0_f64, 155.0_f64)
    } else {
        (300.0_f64, 215.0_f64, 410.0_f64, 270.0_f64)
    };
    let width = width
        .filter(|v| v.is_finite())
        .unwrap_or(default_width)
        .clamp(min_width, 1200.0);
    let height = height
        .filter(|v| v.is_finite())
        .unwrap_or(default_height)
        .clamp(min_height, 900.0);
    window
        .set_min_size(Some(tauri::LogicalSize::new(min_width, min_height)))
        .map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    if let Some(monitor) = monitor {
        let origin = monitor.position();
        let bounds = monitor.size();
        let scale = monitor.scale_factor();
        let w = (width * scale).ceil() as i32;
        let h = (height * scale).ceil() as i32;
        let x = position
            .x
            .clamp(origin.x, (origin.x + bounds.width as i32 - w).max(origin.x));
        let y = position.y.clamp(
            origin.y,
            (origin.y + bounds.height as i32 - h).max(origin.y),
        );
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn adjust_floating_size(app: tauri::AppHandle, compact: bool, delta: i32) -> Result<(), String> {
    let window = app
        .get_webview_window("floating")
        .ok_or("No se encontró la ventana flotante")?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let step = delta.clamp(-1, 1) as f64;
    set_floating_compact(
        app,
        compact,
        Some(size.width as f64 / scale + step * 25.0),
        Some(size.height as f64 / scale + step * 15.0),
    )
}

#[cfg(target_os = "windows")]
fn remove_native_border(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
    };
    if let Ok(hwnd) = window.hwnd() {
        let square: u32 = 1; // CSS controls the rounded corners.
        let no_border: u32 = 0xffff_fffe;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as _,
                (&square as *const u32).cast(),
                std::mem::size_of_val(&square) as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_BORDER_COLOR as _,
                (&no_border as *const u32).cast(),
                std::mem::size_of_val(&no_border) as u32,
            );
        }
    }
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
        .invoke_handler(tauri::generate_handler![
            read_usage,
            set_floating_visible,
            set_floating_compact,
            adjust_floating_size
        ])
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
            let floating_window = tauri::WebviewWindowBuilder::new(
                app,
                "floating",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("GoutenShadow Codex Usage · Ventana flotante")
            .inner_size(410.0, 270.0)
            .min_inner_size(160.0, 100.0)
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .visible(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .build()?;
            #[cfg(target_os = "windows")]
            remove_native_border(&floating_window);
            #[cfg(not(target_os = "windows"))]
            let _ = floating_window;

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
