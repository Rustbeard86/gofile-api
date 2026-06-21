# gofile-api

An asynchronous Rust client for the [Gofile](https://gofile.io) REST API,
focused on automating uploads to a paid Gofile account.

## Features

- Streamed file uploads (large files are not buffered into memory)
- Upload from a path or from in-memory bytes
- Choose a regional upload proxy for better throughput
- Folder create / update / move / copy / delete / search / import
- Direct link create / delete
- Account ID + info lookup
- Forward-compatible types: unknown response fields are preserved in `extra`
  (the API is in BETA)

## Install

```toml
[dependencies]
gofile-api = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

## Usage

```rust,no_run
use gofile_api::{Gofile, ContentAttribute, UploadRegion};

#[tokio::main]
async fn main() -> Result<(), gofile_api::Error> {
    // Token from https://gofile.io/myprofile
    let gofile = Gofile::new("YOUR_API_TOKEN");

    // Simple upload to your root folder.
    let res = gofile.upload_file("./archive.zip").await?;
    println!("Download page: {:?}", res.download_page);

    // Upload into a specific folder, from a chosen region.
    let res = gofile
        .upload_file_with("./big.iso", Some("FOLDER_ID"), UploadRegion::EuropeParis)
        .await?;
    println!("File id: {:?}", res.id);

    // Rename it afterwards.
    if let Some(id) = res.id {
        gofile
            .update_content(&id, ContentAttribute::Name("renamed.iso".into()))
            .await?;
    }
    Ok(())
}
```

### Saturating a fast connection

A single upload is bound by one connection's throughput to the chosen region,
so one file won't fill a multi-gigabit link no matter what. To keep a fat pipe
busy, upload several files at once and let the closest region (the default,
`UploadRegion::Auto`) route them:

```rust,no_run
# async fn run(gofile: gofile_api::Gofile) -> Result<(), gofile_api::Error> {
let paths = ["a.bin", "b.bin", "c.bin", "d.bin"];
// 6 in flight at a time; results come back in input order.
let results = gofile.upload_files(&paths, Some("FOLDER_ID"), 6).await;
for r in results {
    match r {
        Ok(u)  => println!("ok: {:?}", u.download_page),
        Err(e) => eprintln!("failed: {e}"),
    }
}
# Ok(()) }
```

Gofile has no chunked or resumable single-file upload, so for one big file the
only levers are region (use `Auto`) and the streamed body — both handled for
you.

Upload raw bytes you already have in memory:

```rust,no_run
# async fn run(gofile: gofile_api::Gofile) -> Result<(), gofile_api::Error> {
let data = b"hello world".to_vec();
let res = gofile.upload_bytes(data, "note.txt", None).await?;
# Ok(()) }
```

See `examples/upload.rs` for a runnable example.

## Notes

- Most endpoints require a **premium account**. Free/guest accounts can only
  upload, create folders, rename, and delete content.
- Respect Gofile's rate limits — repeatedly hitting `429` can get your IP
  banned. The client surfaces `429` as `Error::RateLimited` so you can back off.

## License

MIT OR Apache-2.0
