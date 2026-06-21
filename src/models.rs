//! Response and request types for the Gofile API.
//!
//! Gofile is in BETA and may add or rename fields. To stay forward-compatible,
//! the strongly-typed structs below capture the documented fields and keep an
//! `extra` map (via `#[serde(flatten)]`) holding anything unrecognised, so new
//! fields are never silently dropped.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The standard `{ "status": "...", "data": ... }` envelope every endpoint
/// wraps its payload in.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Envelope<T> {
    pub status: String,
    // A missing `data` key deserializes to `None` (serde special-cases Option).
    pub data: Option<T>,
}

/// Result of a successful file upload.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// Identifier of the uploaded file.
    #[serde(alias = "fileId")]
    pub id: Option<String>,
    /// Name the file was stored under.
    #[serde(alias = "fileName")]
    pub name: Option<String>,
    /// Identifier of the folder the file landed in. Reuse this (together with
    /// `guest_token` for guest uploads) to add more files to the same folder.
    pub parent_folder: Option<String>,
    /// Public download page for the content.
    pub download_page: Option<String>,
    /// Short code segment of the download page URL.
    pub code: Option<String>,
    /// MD5 checksum computed by the server.
    pub md5: Option<String>,
    /// Token of the guest account created when uploading without a token.
    /// `None` for authenticated uploads.
    pub guest_token: Option<String>,
    /// Any additional fields returned by the API.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Result of creating a folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFolder {
    /// Identifier of the new folder.
    #[serde(alias = "folderId")]
    pub id: Option<String>,
    /// Name of the new folder.
    #[serde(alias = "folderName")]
    pub name: Option<String>,
    /// Identifier of the parent folder.
    pub parent_folder: Option<String>,
    /// Folder type, typically `"folder"`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Result of creating a direct link.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectLink {
    /// Identifier of the direct link (needed to update or delete it).
    pub id: Option<String>,
    /// The direct download URL.
    pub direct_link: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Account identifier wrapper returned by `/accounts/getid`.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountId {
    pub id: String,
}

/// Detailed account information returned by `/accounts/{accountId}`.
///
/// The big per-day `stats_history` and `ip_traffic` maps are left as raw JSON;
/// the fields you'll actually reach for (root folder, tier, quotas, current
/// usage) are typed.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    /// Account ID.
    pub id: String,
    /// Registered email address.
    pub email: Option<String>,
    /// Account tier, e.g. `"guest"`, `"standard"`, `"premium"`.
    pub tier: Option<String>,
    /// Premium kind when applicable, e.g. `"subscription"`.
    pub premium_type: Option<String>,
    /// The account's API token (the same credential used to authenticate).
    pub token: Option<String>,
    /// The permanent root folder ID — the base for every upload and folder.
    pub root_folder: Option<String>,
    /// Account creation time (Unix seconds).
    pub create_time: Option<i64>,
    /// Subscription provider, e.g. `"patreon"`.
    pub subscription_provider: Option<String>,
    /// Subscription end time (Unix seconds).
    pub subscription_end_date: Option<i64>,
    /// Direct-traffic allowance, in bytes.
    pub subscription_limit_direct_traffic: Option<i64>,
    /// Storage allowance, in bytes.
    pub subscription_limit_storage: Option<i64>,
    /// Snapshot of current usage (file/folder counts, storage, traffic).
    pub stats_current: Option<AccountStats>,
    /// Per-day historical stats, keyed `year -> month -> day`. Large; raw JSON.
    pub stats_history: Option<serde_json::Value>,
    /// Per-day IP traffic totals, keyed `year -> month -> day`. Large; raw JSON.
    pub ip_traffic: Option<serde_json::Value>,
    /// Geo/ASN info about the IP that made the request. Raw JSON.
    pub ipinfo: Option<serde_json::Value>,
    /// Any additional fields returned by the API.
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// A usage snapshot, as found in [`AccountInfo::stats_current`] and in each
/// day of the history map. All byte counts are raw bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStats {
    pub folder_count: Option<i64>,
    pub file_count: Option<i64>,
    /// Bytes currently stored.
    pub storage: Option<i64>,
    /// Bytes served via generated direct links.
    pub traffic_direct_generated: Option<i64>,
    /// Bytes served via direct (request) downloads.
    pub traffic_req_downloaded: Option<i64>,
    /// Bytes served via the web download pages.
    pub traffic_web_downloaded: Option<i64>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Attributes that can be modified through the content update endpoint.
///
/// Note: only `Name` is valid for files; the rest apply to folders only.
#[derive(Debug, Clone)]
pub enum ContentAttribute {
    /// Content name (files & folders).
    Name(String),
    /// Download page description (folders only).
    Description(String),
    /// Comma-separated tags (folders only).
    Tags(String),
    /// Public access status (folders only).
    Public(bool),
    /// Expiration date as a Unix timestamp (folders only).
    Expiry(i64),
    /// Access password (folders only).
    Password(String),
}

impl ContentAttribute {
    /// The `attribute` key as expected by the API.
    pub(crate) fn key(&self) -> &'static str {
        match self {
            ContentAttribute::Name(_) => "name",
            ContentAttribute::Description(_) => "description",
            ContentAttribute::Tags(_) => "tags",
            ContentAttribute::Public(_) => "public",
            ContentAttribute::Expiry(_) => "expiry",
            ContentAttribute::Password(_) => "password",
        }
    }

    /// The `attributeValue` payload, serialised per the documented format.
    pub(crate) fn value(&self) -> serde_json::Value {
        match self {
            ContentAttribute::Name(v)
            | ContentAttribute::Description(v)
            | ContentAttribute::Tags(v)
            | ContentAttribute::Password(v) => serde_json::Value::String(v.clone()),
            // Documented as a boolean *string* ("true"/"false").
            ContentAttribute::Public(v) => serde_json::Value::String(v.to_string()),
            // Documented as a Unix timestamp; send as a string for safety.
            ContentAttribute::Expiry(v) => serde_json::Value::String(v.to_string()),
        }
    }
}

/// Restrictions that can be attached to a direct link.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectLinkOptions {
    /// Unix timestamp when the link should expire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire_time: Option<i64>,
    /// IP addresses permitted to use the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ips_allowed: Option<Vec<String>>,
    /// Domains permitted to embed/access the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains_allowed: Option<Vec<String>>,
    /// Domains blocked from embedding/accessing the link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains_blocked: Option<Vec<String>>,
    /// `username:password` pairs required for basic auth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<Vec<String>>,
}
