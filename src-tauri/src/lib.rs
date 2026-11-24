mod acoustid;
mod export;
mod media;
mod settings;
mod util;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(export::ExportState::default())
        .invoke_handler(tauri::generate_handler![
            media::check_tools,
            media::probe,
            media::thumbnail,
            media::make_proxy,
            acoustid::identify,
            export::export,
            export::cancel_export,
            settings::load_settings,
            settings::save_settings,
            settings::get_api_key,
            settings::set_api_key,
            util::reveal,
            util::open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gigreel");
}
