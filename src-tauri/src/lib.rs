pub mod agent;
mod commands;
mod database;
pub mod docs;
pub mod models;
pub mod provider;
mod pty;
mod ssh_config;

use tauri::Manager;

fn parse_log_level(level: &str) -> log::LevelFilter {
    match level {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        _ => log::LevelFilter::Info,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered FIRST. Two instances would each hold their own
        // SQLite connection and race last-write-wins on the session snapshot,
        // so the second launch focuses the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(parse_log_level(
                    &std::env::var("VTERMINAL_LOG").unwrap_or_default(),
                ))
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "{} [{}] [{}] {}",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                        record.level(),
                        record.target(),
                        message
                    ))
                })
                .max_file_size(10 * 1024 * 1024)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("vterminal".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let conn = database::init(&app_data).map_err(std::io::Error::other)?;
            app.manage(database::DbState(std::sync::Mutex::new(conn)));
            // Document buckets live in their OWN database file, opened lazily — the
            // handle is registered here but nothing touches the disk until a
            // `docs_*` command runs, so the default (flag-off) install has no
            // `docs.db` at all. See `docs::db` for why the file is separate.
            app.manage(docs::db::DocsDb::new(app_data.clone()));
            app.manage(pty::PtyManager::default());
            app.manage(agent::AiState::default());
            app.manage(agent::ApprovalState::default());
            app.manage(agent::PtyExecState::default());
            app.manage(agent::SteerState::default());
            app.manage(models::DownloadState::default());
            #[cfg(feature = "local-llm")]
            {
                // ONE permit shared by the chat host and the vision sidecar. Two
                // resident models with a semaphore each would mean two concurrent
                // generations and four large allocations — see `InferenceGate`.
                let gate = provider::InferenceGate::default();
                app.manage(provider::local::ModelHost::with_gate(
                    std::sync::Arc::clone(&gate.0),
                ));
                app.manage(provider::vision::VisionHost::with_gate(
                    std::sync::Arc::clone(&gate.0),
                ));
                app.manage(gate);
            }

            // Regenerate the shell-integration zdotdir on every start so script
            // upgrades take effect (versioned header check inside).
            if let Err(e) = commands::shell_integration::ensure_zdotdir(app.handle()) {
                log::warn!("shell integration setup failed: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Kill all shells on app exit — no orphan zsh processes.
            if let tauri::WindowEvent::Destroyed = event {
                let manager = window.state::<pty::PtyManager>();
                let drained: Vec<pty::session::PtySession> = manager
                    .sessions
                    .lock()
                    .map(|mut sessions| sessions.drain().map(|(_, s)| s).collect())
                    .unwrap_or_default();
                for session in drained {
                    session.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::get_model_effort,
            commands::settings::set_model_effort,
            commands::settings::get_system_info,
            // pty
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_ack,
            commands::pty::pty_kill,
            commands::pty::pty_list,
            // shell integration
            commands::shell_integration::shell_integration_status,
            // history
            commands::history::history_record,
            commands::history::history_recent,
            commands::history::history_search,
            commands::history::history_clear,
            // ssh hosts
            commands::ssh_hosts::ssh_hosts_list,
            commands::ssh_hosts::ssh_hosts_get,
            commands::ssh_hosts::ssh_hosts_create,
            commands::ssh_hosts::ssh_hosts_update,
            commands::ssh_hosts::ssh_hosts_delete,
            commands::ssh_hosts::ssh_hosts_touch,
            commands::ssh_hosts::ssh_hosts_scan_config,
            commands::ssh_hosts::ssh_hosts_import,
            // workspace / session restore
            commands::workspace::workspace_restore,
            commands::workspace::workspace_snapshot,
            commands::workspace::workspace_scrollback,
            commands::workspace::workspace_mark_healthy,
            commands::workspace::workspace_clear,
            // session archive
            commands::archive::archive_list,
            commands::archive::archive_get,
            commands::archive::archive_scrollback,
            commands::archive::archive_transcript,
            commands::archive::archive_put,
            commands::archive::archive_put_many,
            commands::archive::archive_delete,
            commands::archive::archive_clear,
            commands::archive::archive_prune,
            // attachments
            commands::attachments::attachment_put,
            commands::attachments::attachment_read,
            // document buckets (experimental; every command gated on docs_enabled)
            commands::docs::docs_buckets_list,
            commands::docs::docs_bucket_create,
            commands::docs::docs_bucket_rename,
            commands::docs::docs_bucket_delete,
            commands::docs::docs_bucket_reindex,
            commands::docs::docs_scan,
            commands::docs::docs_files_list,
            commands::docs::docs_files_needing_work,
            commands::docs::docs_file_remove,
            commands::docs::docs_file_failed,
            commands::docs::docs_refresh_states,
            commands::docs::docs_read_source,
            commands::docs::docs_put_text,
            commands::docs::docs_search,
            commands::docs::docs_destroy,
            // vision sidecar
            commands::vision::vision_catalog,
            commands::vision::vision_download,
            commands::vision::vision_load,
            commands::vision::vision_unload,
            commands::vision::vision_status,
            commands::vision::vision_delete,
            commands::vision::vision_describe,
            // models
            commands::models::models_catalog,
            commands::models::models_download,
            commands::models::models_cancel_download,
            commands::models::models_list_local,
            commands::models::models_delete,
            commands::models::model_load,
            commands::models::model_unload,
            commands::models::model_status,
            // remote inference servers
            commands::remote_servers::remote_servers_list,
            commands::remote_servers::remote_servers_create,
            commands::remote_servers::remote_servers_update,
            commands::remote_servers::remote_servers_delete,
            commands::remote_servers::remote_servers_set_api_key,
            commands::remote_servers::remote_servers_set_models,
            commands::remote_servers::remote_servers_probe,
            // ai
            commands::ai::ai_suggest,
            commands::ai::ai_explain,
            commands::ai::ai_ask,
            commands::ai::ai_name_session,
            commands::ai::ai_cancel,
            commands::ai::agent_start,
            commands::ai::respond_to_approval,
            commands::ai::agent_steer,
            commands::ai::submit_command_result,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Leave the process BEFORE libc runs C++ static destructors.
            //
            // llama.cpp's Metal backend keeps its devices in a static
            // `vector<unique_ptr<ggml_metal_device>>`, and freeing a device
            // asserts that every Metal buffer was released first:
            //
            //     GGML_ASSERT([rsets->data count] == 0);   ggml-metal-device.m
            //
            // With a model resident at quit — the normal case — that assert
            // fires inside `__cxa_finalize_ranges`, and `ggml_abort` raises
            // SIGABRT: macOS then reports "VTerminal quit unexpectedly" on an
            // app the user closed deliberately. Unloading the model here would
            // not be enough, because an in-flight generation still holds an
            // `Arc<LlamaModel>` and its KV buffers.
            //
            // Nothing durable is lost. Every write is already committed when
            // its command returns (SQLite statements, explicit `store.save()`),
            // and tao's own path ends in `std::process::exit`, which runs no
            // Rust destructors either — only the atexit/static-destructor phase
            // is skipped. `cleanup_before_exit`, which Tauri calls right after
            // this callback, just clears in-memory resource tables.
            //
            // `RunEvent::Exit` covers both quit paths: tao's event loop, and
            // AppKit's `-[NSApplication terminate:]`, which reaches it through
            // `applicationWillTerminate` before calling `exit()` itself.
            if let tauri::RunEvent::Exit = event {
                unsafe { libc::_exit(0) };
            }
        });
}
