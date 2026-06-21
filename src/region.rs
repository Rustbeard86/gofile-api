//! Regional upload endpoints.

/// Upload proxy region. Choosing the one closest to you can improve throughput.
///
/// The default, [`UploadRegion::Auto`], lets Gofile pick the closest region.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UploadRegion {
    /// Automatic (closest region) — `upload.gofile.io`.
    #[default]
    Auto,
    /// Europe (Paris) — `upload-eu-par.gofile.io`.
    EuropeParis,
    /// North America (Phoenix) — `upload-na-phx.gofile.io`.
    NorthAmericaPhoenix,
    /// Asia Pacific (Singapore) — `upload-ap-sgp.gofile.io`.
    AsiaSingapore,
    /// Asia Pacific (Hong Kong) — `upload-ap-hkg.gofile.io`.
    AsiaHongKong,
    /// Asia Pacific (Tokyo) — `upload-ap-tyo.gofile.io`.
    AsiaTokyo,
    /// South America (São Paulo) — `upload-sa-sao.gofile.io`.
    SouthAmericaSaoPaulo,
}

impl UploadRegion {
    /// The host name for this region.
    pub fn host(self) -> &'static str {
        match self {
            UploadRegion::Auto => "upload.gofile.io",
            UploadRegion::EuropeParis => "upload-eu-par.gofile.io",
            UploadRegion::NorthAmericaPhoenix => "upload-na-phx.gofile.io",
            UploadRegion::AsiaSingapore => "upload-ap-sgp.gofile.io",
            UploadRegion::AsiaHongKong => "upload-ap-hkg.gofile.io",
            UploadRegion::AsiaTokyo => "upload-ap-tyo.gofile.io",
            UploadRegion::SouthAmericaSaoPaulo => "upload-sa-sao.gofile.io",
        }
    }

    /// The full `https://.../uploadfile` URL for this region.
    pub fn upload_url(self) -> String {
        format!("https://{}/uploadfile", self.host())
    }
}
