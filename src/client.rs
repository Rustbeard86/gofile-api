use std::path::Path;

use reqwest::multipart::{Form, Part};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::error::{Error, Result};
use crate::models::{
    AccountId, AccountInfo, ContentAttribute, CreatedFolder, DirectLink, DirectLinkOptions,
    Envelope, UploadResult,
};
use crate::region::UploadRegion;

const DEFAULT_API_BASE: &str = "https://api.gofile.io";

/// Asynchronous client for the Gofile API.
///
/// Construct it with your API token (from <https://gofile.io/myprofile>) via
/// [`Gofile::new`]. The token is sent as a `Bearer` credential on every request.
///
/// ```no_run
/// # async fn run() -> Result<(), gofile_api::Error> {
/// use gofile_api::Gofile;
///
/// let gofile = Gofile::new("YOUR_API_TOKEN");
/// let res = gofile.upload_file("./report.pdf").await?;
/// println!("Download page: {:?}", res.download_page);
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct Gofile {
    http: reqwest::Client,
    token: Option<String>,
    api_base: String,
    region: UploadRegion,
}

impl Gofile {
    /// Create a client authenticated with the given API token.
    pub fn new(token: impl Into<String>) -> Self {
        Self::builder().token(token).build()
    }

    /// Create an unauthenticated (guest) client. Only [`Gofile::upload_file`]
    /// and the other upload helpers work without a token; everything else
    /// returns [`Error::MissingToken`].
    pub fn guest() -> Self {
        Self::builder().build()
    }

    /// Start building a customised client (custom reqwest client, region, base URL).
    pub fn builder() -> GofileBuilder {
        GofileBuilder::default()
    }

    /// The configured default upload region.
    pub fn region(&self) -> UploadRegion {
        self.region
    }

    // ----- Uploads -------------------------------------------------------

    /// Upload a file from disk to your root folder (or a new public folder for
    /// guest clients). The file is streamed, not buffered into memory.
    pub async fn upload_file(&self, path: impl AsRef<Path>) -> Result<UploadResult> {
        self.upload_file_to(path, None).await
    }

    /// Upload a file from disk into a specific folder.
    pub async fn upload_file_to(
        &self,
        path: impl AsRef<Path>,
        folder_id: Option<&str>,
    ) -> Result<UploadResult> {
        self.upload_file_with(path, folder_id, self.region).await
    }

    /// Upload a file from disk with full control over destination folder and
    /// region.
    pub async fn upload_file_with(
        &self,
        path: impl AsRef<Path>,
        folder_id: Option<&str>,
        region: UploadRegion,
    ) -> Result<UploadResult> {
        let path = path.as_ref();
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload.bin".to_string());

        let file = tokio::fs::File::open(path).await.map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let len = file
            .metadata()
            .await
            .map_err(|source| Error::Io {
                path: path.to_path_buf(),
                source,
            })?
            .len();

        let mime = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();

        let stream = tokio_util::io::ReaderStream::new(file);
        let body = reqwest::Body::wrap_stream(stream);
        let part = Part::stream_with_length(body, len)
            .file_name(file_name)
            .mime_str(&mime)?;

        self.upload_part(part, folder_id, region).await
    }

    /// Upload many files concurrently into the same folder.
    ///
    /// A single file is bounded by one connection's throughput to the upload
    /// region, so on a fat pipe (multi-gigabit) the way to keep the link busy
    /// is to push several files at once. `concurrency` caps how many uploads
    /// run in parallel; 4–8 is a sensible starting point.
    ///
    /// Results come back in the same order as `paths`. A failure on one file
    /// does not abort the others — that slot holds the error.
    pub async fn upload_files<P: AsRef<Path>>(
        &self,
        paths: &[P],
        folder_id: Option<&str>,
        concurrency: usize,
    ) -> Vec<Result<UploadResult>> {
        use futures_util::stream::{self, StreamExt};

        let region = self.region;
        stream::iter(paths.iter().enumerate())
            .map(|(idx, path)| async move {
                (idx, self.upload_file_with(path, folder_id, region).await)
            })
            .buffer_unordered(concurrency.max(1))
            .collect::<Vec<_>>()
            .await
            .into_iter()
            // Restore input order; buffer_unordered yields as uploads finish.
            .fold(
                {
                    let mut v: Vec<Option<Result<UploadResult>>> = Vec::new();
                    v.resize_with(paths.len(), || None);
                    v
                },
                |mut acc, (idx, res)| {
                    acc[idx] = Some(res);
                    acc
                },
            )
            .into_iter()
            .map(|slot| slot.expect("every index is filled exactly once"))
            .collect()
    }

    /// Upload raw bytes already held in memory.
    pub async fn upload_bytes(
        &self,
        bytes: impl Into<Vec<u8>>,
        file_name: impl Into<String>,
        folder_id: Option<&str>,
    ) -> Result<UploadResult> {
        let file_name = file_name.into();
        let mime = mime_guess::from_path(&file_name)
            .first_or_octet_stream()
            .to_string();
        let part = Part::bytes(bytes.into())
            .file_name(file_name)
            .mime_str(&mime)?;
        self.upload_part(part, folder_id, self.region).await
    }

    async fn upload_part(
        &self,
        part: Part,
        folder_id: Option<&str>,
        region: UploadRegion,
    ) -> Result<UploadResult> {
        let mut form = Form::new().part("file", part);
        if let Some(folder) = folder_id {
            form = form.text("folderId", folder.to_string());
        }

        let mut req = self.http.post(region.upload_url()).multipart(form);
        req = self.authorize(req);
        let resp = req.send().await?;
        decode(resp).await
    }

    // ----- Folders & content ---------------------------------------------

    /// Create a folder under `parent_folder_id`.
    ///
    /// Requires an API token.
    pub async fn create_folder(
        &self,
        parent_folder_id: &str,
        folder_name: Option<&str>,
        public: Option<bool>,
    ) -> Result<CreatedFolder> {
        let mut body = json!({ "parentFolderId": parent_folder_id });
        if let Some(name) = folder_name {
            body["folderName"] = json!(name);
        }
        if let Some(p) = public {
            body["public"] = json!(p);
        }
        let resp = self
            .authorize(self.http.post(self.api_url("/contents/createFolder")))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Update a single attribute of a file or folder.
    ///
    /// Requires an API token.
    pub async fn update_content(
        &self,
        content_id: &str,
        attribute: ContentAttribute,
    ) -> Result<serde_json::Value> {
        let body = json!({
            "attribute": attribute.key(),
            "attributeValue": attribute.value(),
        });
        let resp = self
            .authorize(self.http.put(self.api_url(&format!("/contents/{content_id}/update"))))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Permanently delete the given content IDs (files and/or folders).
    ///
    /// Requires an API token.
    pub async fn delete_contents(&self, content_ids: &[&str]) -> Result<serde_json::Value> {
        let body = json!({ "contentsId": content_ids.join(",") });
        let resp = self
            .authorize(self.http.delete(self.api_url("/contents")))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Retrieve a folder's metadata and contents.
    ///
    /// Requires an API token. Only folder IDs are accepted; file details are
    /// nested inside the parent folder's listing.
    pub async fn get_content(&self, content_id: &str) -> Result<serde_json::Value> {
        let resp = self
            .authorize(self.http.get(self.api_url(&format!("/contents/{content_id}"))))
            .send()
            .await?;
        decode(resp).await
    }

    /// Copy content IDs into a destination folder.
    pub async fn copy_contents(
        &self,
        content_ids: &[&str],
        dest_folder_id: &str,
    ) -> Result<serde_json::Value> {
        let body = json!({
            "contentsId": content_ids.join(","),
            "folderId": dest_folder_id,
        });
        let resp = self
            .authorize(self.http.post(self.api_url("/contents/copy")))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Move content IDs into a destination folder.
    pub async fn move_contents(
        &self,
        content_ids: &[&str],
        dest_folder_id: &str,
    ) -> Result<serde_json::Value> {
        let body = json!({
            "contentsId": content_ids.join(","),
            "folderId": dest_folder_id,
        });
        let resp = self
            .authorize(self.http.put(self.api_url("/contents/move")))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Import content IDs into your account's root folder.
    pub async fn import_contents(&self, content_ids: &[&str]) -> Result<serde_json::Value> {
        let body = json!({ "contentsId": content_ids.join(",") });
        let resp = self
            .authorize(self.http.post(self.api_url("/contents/import")))
            .json(&body)
            .send()
            .await?;
        decode(resp).await
    }

    /// Recursively search a folder for files/folders matching `query` by name
    /// or tag.
    pub async fn search(
        &self,
        content_id: &str,
        query: &str,
    ) -> Result<serde_json::Value> {
        let resp = self
            .authorize(self.http.get(self.api_url("/contents/search")))
            .query(&[("contentId", content_id), ("searchedString", query)])
            .send()
            .await?;
        decode(resp).await
    }

    // ----- Direct links ---------------------------------------------------

    /// Create a direct link to content. For folders, Gofile generates a ZIP.
    pub async fn create_direct_link(
        &self,
        content_id: &str,
        options: &DirectLinkOptions,
    ) -> Result<DirectLink> {
        let resp = self
            .authorize(
                self.http
                    .post(self.api_url(&format!("/contents/{content_id}/directlinks"))),
            )
            .json(options)
            .send()
            .await?;
        decode(resp).await
    }

    /// Delete a direct link.
    pub async fn delete_direct_link(
        &self,
        content_id: &str,
        direct_link_id: &str,
    ) -> Result<serde_json::Value> {
        let resp = self
            .authorize(self.http.delete(
                self.api_url(&format!("/contents/{content_id}/directlinks/{direct_link_id}")),
            ))
            .send()
            .await?;
        decode(resp).await
    }

    // ----- Account --------------------------------------------------------

    /// Get the account ID associated with the configured token.
    ///
    /// Requires an API token.
    pub async fn account_id(&self) -> Result<String> {
        let resp = self
            .authorize(self.http.get(self.api_url("/accounts/getid")))
            .send()
            .await?;
        let id: AccountId = decode(resp).await?;
        Ok(id.id)
    }

    /// Get detailed information about an account, including its root folder ID,
    /// tier, quotas, and current usage.
    pub async fn account_info(&self, account_id: &str) -> Result<AccountInfo> {
        let resp = self
            .authorize(self.http.get(self.api_url(&format!("/accounts/{account_id}"))))
            .send()
            .await?;
        decode(resp).await
    }

    /// Convenience: resolve the token's account and return its root folder ID.
    ///
    /// Equivalent to calling [`Gofile::account_id`] then [`Gofile::account_info`]
    /// and reading `root_folder`. Requires an API token.
    pub async fn root_folder_id(&self) -> Result<String> {
        let id = self.account_id().await?;
        let info = self.account_info(&id).await?;
        info.root_folder.ok_or_else(|| Error::Api {
            status: "missing-rootFolder".to_string(),
            data: serde_json::Value::Null,
        })
    }

    // ----- internals ------------------------------------------------------

    fn api_url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    fn authorize(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) => req.bearer_auth(t),
            None => req,
        }
    }
}

/// Builder for [`Gofile`].
#[derive(Debug, Default)]
pub struct GofileBuilder {
    token: Option<String>,
    api_base: Option<String>,
    region: UploadRegion,
    http: Option<reqwest::Client>,
}

impl GofileBuilder {
    /// Set the API token.
    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    /// Override the API base URL (default `https://api.gofile.io`). Useful for
    /// testing against a mock server.
    pub fn api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = Some(base.into());
        self
    }

    /// Set the default upload region.
    pub fn region(mut self, region: UploadRegion) -> Self {
        self.region = region;
        self
    }

    /// Supply a preconfigured reqwest client (timeouts, proxy, etc.).
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http = Some(client);
        self
    }

    /// Build the client.
    pub fn build(self) -> Gofile {
        Gofile {
            http: self.http.unwrap_or_default(),
            token: self.token,
            api_base: self.api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_string()),
            region: self.region,
        }
    }
}

/// Read a Gofile envelope response, mapping the wrapper status and HTTP status
/// codes into [`Error`].
async fn decode<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T> {
    let status = resp.status();
    if status.as_u16() == 429 {
        return Err(Error::RateLimited);
    }

    let text = resp.text().await?;

    if !status.is_success() {
        // Try to surface the API's status string if the body is an envelope.
        if let Ok(env) = serde_json::from_str::<Envelope<serde_json::Value>>(&text) {
            return Err(Error::Api {
                status: env.status,
                data: env.data.unwrap_or(serde_json::Value::Null),
            });
        }
        return Err(Error::HttpStatus {
            status: status.as_u16(),
            body: text,
        });
    }

    let env: Envelope<T> = serde_json::from_str(&text)?;
    if env.status != "ok" {
        // Re-parse data loosely so the caller still gets the payload.
        let data = serde_json::from_str::<Envelope<serde_json::Value>>(&text)
            .ok()
            .and_then(|e| e.data)
            .unwrap_or(serde_json::Value::Null);
        return Err(Error::Api {
            status: env.status,
            data,
        });
    }

    env.data.ok_or_else(|| Error::Api {
        status: "ok-but-no-data".to_string(),
        data: serde_json::Value::Null,
    })
}
