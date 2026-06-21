//! Minimal upload example.
//!
//! Run with:
//!
//! ```text
//! GOFILE_TOKEN=xxxx cargo run --example upload -- ./path/to/file
//! ```

use std::env;

use gofile_api::Gofile;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = env::var("GOFILE_TOKEN").expect("set GOFILE_TOKEN");
    let path = env::args().nth(1).expect("usage: upload <file>");

    let gofile = Gofile::new(token);
    let res = gofile.upload_file(&path).await?;

    println!("id:           {:?}", res.id);
    println!("name:         {:?}", res.name);
    println!("parentFolder: {:?}", res.parent_folder);
    println!("downloadPage: {:?}", res.download_page);

    Ok(())
}
