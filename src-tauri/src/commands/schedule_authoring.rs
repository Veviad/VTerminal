//! Model-assisted creation returns a draft to the editor. It has no save/arm path.

use tauri::{State, Wry};

#[tauri::command(rename_all = "snake_case")]
pub async fn scheduled_action_ai_generate(
    app: tauri::AppHandle<Wry>,
    ai_state: State<'_, crate::agent::AiState>,
    request_id: String,
    requirements: String,
    terminal_context: Option<String>,
) -> Result<crate::scheduled::types::ScheduledActionInput, String> {
    if !crate::commands::settings::read_bool(&app, crate::scheduled::SETTING_ENABLED, false) {
        return Err(
            "scheduled actions are switched off — enable them in Settings → Schedules".into(),
        );
    }
    if requirements.trim().is_empty()
        || requirements.chars().count() > crate::runbooks::authoring::MAX_REQUIREMENTS_CHARS
    {
        return Err("describe the task in 1–8000 characters".into());
    }
    if terminal_context.as_deref().is_some_and(|context| {
        context.chars().count() > crate::runbooks::authoring::MAX_CONTEXT_CHARS
    }) {
        return Err("terminal context exceeds 24000 characters".into());
    }
    let model = crate::commands::ai::active_model(&app);
    let resolved = crate::commands::ai::resolve_provider_for_model(&app, model).await?;
    let cancel = ai_state.register(&request_id);
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string());
    let started = std::time::Instant::now();
    log::info!("generating scheduled task with {}", resolved.model.label);
    let authored = crate::scheduled::authoring::author_schedule(
        resolved.provider.as_ref(),
        &requirements,
        terminal_context.as_deref(),
        resolved.effort,
        cancel,
        &timezone,
        &chrono::Local::now().to_rfc3339(),
    )
    .await;
    ai_state.finish(&request_id);
    log::info!(
        "scheduled task generation finished in {}ms (success={})",
        started.elapsed().as_millis(),
        authored.is_ok()
    );
    authored
}
