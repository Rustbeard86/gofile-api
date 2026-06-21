use std::path::PathBuf;

/// Result type used throughout the crate.
pub type Result<T> = std::result::Result<T, Error>;

/// Errors that can occur while talking to the Gofile API.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The underlying HTTP transport failed (connection, TLS, timeout, ...).
    #[error("HTTP transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// A local file could not be read for upload.
    #[error("failed to read file {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    /// The response body could not be decoded as the expected JSON shape.
    #[error("failed to decode API response: {0}")]
    Decode(#[from] serde_json::Error),

    /// The API responded with a non-`ok` status string in its envelope.
    ///
    /// `status` is the raw value Gofile returned (e.g. `error-notFound`,
    /// `error-notPremium`). `data` carries any payload that accompanied it.
    #[error("Gofile API returned status `{status}`")]
    Api {
        status: String,
        data: serde_json::Value,
    },

    /// The HTTP request itself returned a non-success status code.
    #[error("Gofile API returned HTTP {status}: {body}")]
    HttpStatus {
        status: u16,
        body: String,
    },

    /// Rate limit exceeded (HTTP 429). Back off before retrying.
    #[error("rate limited by Gofile (HTTP 429)")]
    RateLimited,

    /// An operation required an API token but the client was built without one.
    #[error("this operation requires an API token (call `Gofile::new` with your token)")]
    MissingToken,
}
