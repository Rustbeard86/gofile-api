//! Tauri backend for the Gofile desktop manager.
//!
//! Every command is a thin wrapper around the `gofile-api` crate. The
//! authenticated client is held in managed state and cloned out before each
//! network call so requests don't serialise behind a held lock.

use std::sync::Arc;

use gofile_api::{ContentAttribute, DirectLinkOptions, Gofile};
use serde_json::{json, Value};
use tauri::{Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct AppState {
    client: Option<Gofile>,
    account_id: Option<String>,
}

type Shared = Arc<Mutex<AppState>>;

/// Pull the connected client out of state, or return a friendly error.
async fn client_of(state: &State<'_, Shared>) -> Result<Gofile, String> {
    state
        .lock()
        .await
        .client
        .clone()
        .ok_or_else(|| "Not connected. Enter your API token and connect first.".to_string())
}

async fn account_id_of(state: &State<'_, Shared>) -> Result<String, String> {
    state
        .lock()
        .await
        .account_id
        .clone()
        .ok_or_else(|| "Not connected.".to_string())
}

fn to_attribute(attribute: &str, value: String) -> Result<ContentAttribute, String> {
    Ok(match attribute {
        "name" => ContentAttribute::Name(value),
        "description" => ContentAttribute::Description(value),
        "tags" => ContentAttribute::Tags(value),
        "public" => ContentAttribute::Public(value == "true" || value == "1"),
        "expiry" => ContentAttribute::Expiry(
            value
                .parse()
                .map_err(|_| "expiry must be a Unix timestamp".to_string())?,
        ),
        "password" => ContentAttribute::Password(value),
        other => return Err(format!("unknown attribute: {other}")),
    })
}

// ----- connection ---------------------------------------------------------

#[tauri::command]
async fn connect(token: String, state: State<'_, Shared>) -> Result<Value, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token is empty.".into());
    }
    let client = Gofile::new(token);
    let id = client.account_id().await.map_err(|e| e.to_string())?;
    let info = client.account_info(&id).await.map_err(|e| e.to_string())?;
    {
        let mut s = state.lock().await;
        s.client = Some(client);
        s.account_id = Some(id);
    }
    serde_json::to_value(info).map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_account(state: State<'_, Shared>) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let id = account_id_of(&state).await?;
    let info = client.account_info(&id).await.map_err(|e| e.to_string())?;
    serde_json::to_value(info).map_err(|e| e.to_string())
}

#[tauri::command]
async fn disconnect(state: State<'_, Shared>) -> Result<(), String> {
    let mut s = state.lock().await;
    s.client = None;
    s.account_id = None;
    Ok(())
}

// ----- browsing -----------------------------------------------------------

#[tauri::command]
async fn root_folder(state: State<'_, Shared>) -> Result<String, String> {
    client_of(&state)
        .await?
        .root_folder_id()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_folder(content_id: String, state: State<'_, Shared>) -> Result<Value, String> {
    client_of(&state)
        .await?
        .get_content(&content_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_contents(
    content_id: String,
    query: String,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    client_of(&state)
        .await?
        .search(&content_id, &query)
        .await
        .map_err(|e| e.to_string())
}

// ----- mutations ----------------------------------------------------------

#[tauri::command]
async fn create_folder(
    parent_folder_id: String,
    folder_name: Option<String>,
    public: Option<bool>,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let folder = client_of(&state)
        .await?
        .create_folder(&parent_folder_id, folder_name.as_deref(), public)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(folder).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_content(
    content_id: String,
    attribute: String,
    value: String,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let attr = to_attribute(&attribute, value)?;
    client_of(&state)
        .await?
        .update_content(&content_id, attr)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_contents(
    content_ids: Vec<String>,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let refs: Vec<&str> = content_ids.iter().map(String::as_str).collect();
    client_of(&state)
        .await?
        .delete_contents(&refs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn move_contents(
    content_ids: Vec<String>,
    dest_folder_id: String,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let refs: Vec<&str> = content_ids.iter().map(String::as_str).collect();
    client_of(&state)
        .await?
        .move_contents(&refs, &dest_folder_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn copy_contents(
    content_ids: Vec<String>,
    dest_folder_id: String,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let refs: Vec<&str> = content_ids.iter().map(String::as_str).collect();
    client_of(&state)
        .await?
        .copy_contents(&refs, &dest_folder_id)
        .await
        .map_err(|e| e.to_string())
}

// ----- uploads ------------------------------------------------------------

#[tauri::command]
async fn upload_files(
    paths: Vec<String>,
    folder_id: Option<String>,
    concurrency: Option<usize>,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let results = client
        .upload_files(&paths, folder_id.as_deref(), concurrency.unwrap_or(4))
        .await;

    let report: Vec<Value> = paths
        .iter()
        .zip(results.into_iter())
        .map(|(path, res)| match res {
            Ok(u) => json!({
                "path": path,
                "ok": true,
                "result": serde_json::to_value(u).unwrap_or(Value::Null),
            }),
            Err(e) => json!({ "path": path, "ok": false, "error": e.to_string() }),
        })
        .collect();

    Ok(Value::Array(report))
}

// ----- direct links -------------------------------------------------------

#[tauri::command]
async fn create_direct_link(
    content_id: String,
    options: Option<DirectLinkOptions>,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    let opts = options.unwrap_or_default();
    let link = client_of(&state)
        .await?
        .create_direct_link(&content_id, &opts)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(link).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_direct_link(
    content_id: String,
    direct_link_id: String,
    state: State<'_, Shared>,
) -> Result<Value, String> {
    client_of(&state)
        .await?
        .delete_direct_link(&content_id, &direct_link_id)
        .await
        .map_err(|e| e.to_string())
}

// ----- account ------------------------------------------------------------

#[tauri::command]
async fn reset_token(state: State<'_, Shared>) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let id = account_id_of(&state).await?;
    client.reset_token(&id).await.map_err(|e| e.to_string())
}

// ----- token persistence --------------------------------------------------

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn save_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json!({ "token": token }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty()))
}

#[tauri::command]
fn clear_token(app: tauri::AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            refresh_account,
            disconnect,
            root_folder,
            list_folder,
            search_contents,
            create_folder,
            update_content,
            delete_contents,
            move_contents,
            copy_contents,
            upload_files,
            create_direct_link,
            delete_direct_link,
            reset_token,
            save_token,
            load_token,
            clear_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Gofile Manager");
}
