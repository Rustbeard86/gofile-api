//! # gofile-api
//!
//! An asynchronous Rust client for the [Gofile](https://gofile.io) REST API,
//! built for automating uploads to a (paid) Gofile account.
//!
//! ## Quick start
//!
//! ```no_run
//! use gofile_api::{Gofile, ContentAttribute};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), gofile_api::Error> {
//!     // Token from https://gofile.io/myprofile
//!     let gofile = Gofile::new("YOUR_API_TOKEN");
//!
//!     // Find your root folder.
//!     let account_id = gofile.account_id().await?;
//!     let account = gofile.account_info(&account_id).await?;
//!     let root = account["rootFolder"].as_str().unwrap_or_default();
//!
//!     // Make a folder and upload into it.
//!     let folder = gofile.create_folder(root, Some("backups"), Some(false)).await?;
//!     let folder_id = folder.id.clone().unwrap();
//!
//!     let result = gofile.upload_file_to("./archive.zip", Some(&folder_id)).await?;
//!     println!("Uploaded: {:?}", result.download_page);
//!
//!     // Rename it.
//!     if let Some(file_id) = result.id {
//!         gofile
//!             .update_content(&file_id, ContentAttribute::Name("release.zip".into()))
//!             .await?;
//!     }
//!     Ok(())
//! }
//! ```
//!
//! ## Notes
//!
//! - Most endpoints require a **premium account**. Free/guest accounts can only
//!   upload, create folders, rename, and delete content.
//! - The API is in BETA; unknown response fields are preserved in the `extra`
//!   map on each typed response rather than being dropped.
//! - File uploads are streamed from disk, so large files don't get buffered
//!   into memory.

mod client;
mod error;
mod models;
mod region;

pub use client::{Gofile, GofileBuilder};
pub use error::{Error, Result};
pub use models::{
    AccountId, ContentAttribute, CreatedFolder, DirectLink, DirectLinkOptions, UploadResult,
};
pub use region::UploadRegion;
