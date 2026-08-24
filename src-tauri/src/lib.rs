// `get_settings` builds the whole settings object in one `json!` literal, and
// serde_json expands that recursively — one key per level. The default limit of
// 128 is reached at the current key count, so adding a setting fails to compile
// with a recursion error pointing at whichever key happens to be last.
#![recursion_limit = "256"]

pub mod agent;
mod app_exit;
mod commands;
pub mod credentials;
mod database;
pub mod docs;
pub mod knowledge;
pub mod models;
pub mod provider;
mod pty;
#[cfg(target_os = "macos")]
mod restart;
pub mod runbooks;
mod ssh_config;
#[cfg(target_os = "windows")]
mod windows_fs;

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
    // Normal quits deliberately use `_exit` below to skip llama.cpp's unsafe
    // static destructors. Remember an updater restart request so the final Exit
    // event can spawn the executable from the newly installed bundle first.
    let restarting = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let restart_event = std::sync::Arc::clone(&restarting);
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_exit::macos_menu);
    builder
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            std::fs::create_dir_all(&app_data)?;
            #[cfg(target_os = "windows")]
            crate::windows_fs::initialize_app_data_security(&app_data)
                .map_err(std::io::Error::other)?;
            let credential_store = credentials::CredentialStoreState::system();
            credentials::initialize(app.handle(), &credential_store);
            app.manage(credential_store);
            let conn = database::init(&app_data).map_err(std::io::Error::other)?;
            // Bundled examples are recoverable app assets, not a prerequisite
            // for opening the terminal. Seed them eagerly and let Runbooks list
            // retry reconciliation if the filesystem was temporarily unavailable.
            if let Err(error) = commands::runbooks::initialize_builtin_sources(&app_data, &conn) {
                log::warn!("initialize built-in runbooks failed: {error}");
            }
            app.manage(database::DbState(std::sync::Mutex::new(conn)));
            app.manage(app_exit::AppExitCoordinator::default());
            // Document buckets live in their OWN database file, opened lazily — the
            // handle is registered here but nothing touches the disk until a
            // `docs_*` command runs, so the default (flag-off) install has no
            // `docs.db` at all. See `docs::db` for why the file is separate.
            app.manage(docs::db::DocsDb::new(app_data.clone()));
            app.manage(knowledge::ingest::KnowledgeJobRunnerState::default());
            app.manage(pty::PtyManager::default());
            app.manage(agent::AiState::default());
            app.manage(agent::ApprovalState::default());
            app.manage(agent::AgentPermissionState::default());
            app.manage(agent::PtyExecState::default());
            app.manage(agent::SteerState::default());
            app.manage(models::DownloadState::default());
            app.manage(commands::updates::UpdateState::default());
            app.manage(std::sync::Arc::new(
                commands::runbooks::RunbookCommandState::new(app_data.clone()),
            ));
            #[cfg(feature = "local-llm")]
            {
                if let Ok(resources) = app.path().resource_dir() {
                    provider::local::configure_backend_modules(resources.join("llama-backends"));
                }
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
                app.manage(knowledge::local::EmbeddingHost::with_gate(
                    std::sync::Arc::clone(&gate.0),
                ));
                app.manage(gate);
            }
            #[cfg(not(feature = "local-llm"))]
            app.manage(knowledge::local::EmbeddingHost);

            if let Err(error) = knowledge::ingest::resume_pending_jobs(app.handle()) {
                log::warn!("resume knowledge ingestion jobs failed: {error}");
            }

            // Regenerate the platform shell integration on every start so script
            // upgrades take effect (versioned header check inside).
            if let Err(e) = commands::shell_integration::ensure_platform_integration(app.handle()) {
                log::warn!("shell integration setup failed: {e}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == app_exit::QUIT_MENU_ID {
                if let Err(error) = app_exit::request_quit(app, app_exit::QuitOrigin::Menu) {
                    log::error!("could not coordinate menu quit: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep the webview alive while it serializes terminal buffers.
                // The backend clean-commit command owns the eventual app exit.
                api.prevent_close();
                if let Err(error) =
                    app_exit::request_quit(window.app_handle(), app_exit::QuitOrigin::WindowClose)
                {
                    log::error!("could not coordinate window close: {error}");
                }
            } else if let tauri::WindowEvent::Destroyed = event {
                // Last-resort teardown for a non-preventable platform exit.
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
            // application updates
            commands::updates::update_check,
            commands::updates::update_download,
            commands::updates::update_cancel,
            commands::updates::update_apply,
            commands::updates::app_restart,
            app_exit::app_quit_begin,
            app_exit::app_quit_commit,
            app_exit::app_quit_force,
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
            commands::ssh_hosts::ssh_hosts_set_password,
            commands::ssh_hosts::ssh_hosts_write_password,
            commands::ssh_hosts::ssh_hosts_delete,
            commands::ssh_hosts::ssh_hosts_touch,
            commands::ssh_hosts::ssh_hosts_scan_config,
            commands::ssh_hosts::ssh_hosts_import,
            commands::ssh_hosts::ssh_wsl_identity_root,
            commands::ssh_hosts::ssh_wsl_path_from_host,
            // workspace / session restore
            commands::workspace::workspace_restore,
            commands::workspace::workspace_snapshot,
            commands::workspace::workspace_scrollback,
            commands::workspace::workspace_mark_healthy,
            commands::workspace::workspace_mark_clean_exit,
            commands::workspace::workspace_mark_running,
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
            // terminal-independent Chat workspace
            commands::chat::chat_list,
            commands::chat::chat_get,
            commands::chat::chat_save,
            commands::chat::chat_set_archived,
            commands::chat::chat_update_title,
            commands::chat::chat_delete,
            commands::chat_ai::chat_start,
            commands::chat_ai::ai_name_chat,
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
            // unified knowledge and embedding models
            commands::knowledge::knowledge_connections_list,
            commands::knowledge::knowledge_connections_create,
            commands::knowledge::knowledge_connections_update,
            commands::knowledge::knowledge_connections_set_api_key,
            commands::knowledge::knowledge_connections_delete,
            commands::knowledge::knowledge_connections_refresh,
            commands::knowledge::knowledge_buckets_list,
            commands::knowledge::knowledge_buckets_create,
            commands::knowledge::knowledge_buckets_delete,
            commands::knowledge::knowledge_search,
            commands::knowledge::knowledge_search_detailed,
            commands::knowledge::knowledge_embedding_catalog,
            commands::knowledge::knowledge_embedding_profile_create_cloud,
            commands::knowledge::knowledge_qdrant_import_remove,
            commands::knowledge::knowledge_documents_list,
            commands::knowledge::knowledge_document_delete,
            commands::knowledge::knowledge_document_update,
            commands::knowledge::knowledge_document_ingest,
            commands::knowledge::knowledge_bucket_embed,
            commands::knowledge::knowledge_bucket_semantic_enable,
            commands::knowledge::knowledge_qdrant_turbo_quant_set,
            commands::knowledge::knowledge_jobs_list,
            commands::knowledge::knowledge_jobs_cancel,
            commands::knowledge::knowledge_jobs_retry,
            commands::knowledge_cli::knowledge_cli_install,
            commands::knowledge_cli::knowledge_cli_status,
            commands::embedding_models::knowledge_embedding_model_download,
            commands::embedding_models::knowledge_embedding_model_cancel,
            commands::embedding_models::knowledge_embedding_model_delete,
            commands::embedding_models::knowledge_embedding_model_status,
            // reusable runbooks (experimental; every command gated on runbooks_enabled)
            commands::runbooks::runbooks_import,
            commands::runbooks::runbooks_refresh,
            commands::runbooks::runbooks_list,
            commands::runbooks::runbooks_remove,
            commands::runbooks::runbooks_restore_builtins,
            commands::runbooks::runbooks_drafts_list,
            commands::runbooks::runbooks_draft_create,
            commands::runbooks::runbooks_draft_get,
            commands::runbooks::runbooks_draft_save,
            commands::runbooks::runbooks_draft_validate,
            commands::runbooks::runbooks_ai_generate,
            commands::runbooks::runbooks_draft_publish,
            commands::runbooks::runbooks_draft_discard,
            commands::runbooks::runbooks_get_definition,
            commands::runbooks::runbooks_start,
            commands::runbooks::runbooks_get,
            commands::runbooks::runbooks_resume,
            commands::runbooks::runbooks_cancel,
            commands::runbooks::runbooks_respond_approval,
            commands::runbooks::runbooks_decide,
            commands::runbooks::runbooks_claim_terminal_dispatch,
            commands::runbooks::runbooks_submit_terminal_result,
            commands::runbooks::runbooks_submit_manual,
            commands::runbooks::runbooks_history,
            commands::runbooks::runbooks_delete,
            commands::runbooks::runbooks_report,
            commands::runbooks::runbooks_evidence_read,
            commands::runbooks::runbooks_export,
            commands::runbooks::runbooks_export_package,
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
            commands::ai::agent_set_permission_mode,
            commands::ai::agent_steer,
            commands::ai::submit_command_result,
            commands::settings::remember_command_policy_rule,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
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
            match event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    if code == Some(tauri::RESTART_EXIT_CODE) {
                        restart_event.store(true, std::sync::atomic::Ordering::Release);
                    } else if !app
                        .state::<app_exit::AppExitCoordinator>()
                        .allows_requested_exit()
                    {
                        // tauri-runtime checks this synchronously after callback.
                        api.prevent_exit();
                        if let Err(error) =
                            app_exit::request_quit(app, app_exit::QuitOrigin::ExitRequested)
                        {
                            log::error!("could not coordinate requested exit: {error}");
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Exit => {
                    if restarting.load(std::sync::atomic::Ordering::Acquire) {
                        match restart::relaunch_updated_app() {
                            Ok(()) => unsafe { libc::_exit(0) },
                            Err(error) => {
                                // Let Tauri's built-in restart path recover.
                                log::error!("could not relaunch the updated app: {error}");
                            }
                        }
                    } else {
                        // Dock Quit/OS termination can bypass preventable exit.
                        if let Err(error) = app.state::<pty::PtyManager>().kill_all_verified() {
                            log::error!(
                                "best-effort terminal cleanup on direct exit failed: {error}"
                            );
                        }
                        unsafe { libc::_exit(0) };
                    }
                }
                _ => {}
            }
        });
}
