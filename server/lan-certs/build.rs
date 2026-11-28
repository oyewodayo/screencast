use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// Embeds the Briefcast Transfer Pro PWA assets from the repo's single source of truth
// (`../../src-tauri/src/services/`) when built inside the repository, falling back to `./pwa/`
// when `server/lan-certs` is copied standalone to the VPS.
fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap()).join("pwa");
    let icons_out = out_dir.join("icons");
    fs::create_dir_all(&icons_out).expect("create OUT_DIR/pwa/icons");

    let repo_services = manifest_dir.join("../../src-tauri/src/services");
    let local_pwa = manifest_dir.join("pwa");

    let files: &[(&str, &str)] = &[
        ("phone_transfer_page.html", "phone_transfer_page.html"),
        ("phone_transfer_manifest.json", "phone_transfer_manifest.json"),
        ("phone_transfer_sw.js", "phone_transfer_sw.js"),
        ("phone_transfer_studio.js", "phone_transfer_studio.js"),
        ("phone_transfer_p2p.js", "phone_transfer_p2p.js"),
        ("phone_transfer_icons/icon-192.png", "icons/icon-192.png"),
        ("phone_transfer_icons/icon-512.png", "icons/icon-512.png"),
        ("phone_transfer_icons/maskable-512.png", "icons/maskable-512.png"),
        ("phone_transfer_icons/logo-96.png", "icons/logo-96.png"),
    ];

    for (src_rel, dst_rel) in files {
        let repo_src = repo_services.join(src_rel);
        let local_src = local_pwa.join(dst_rel);
        let chosen: &Path = if repo_src.exists() {
            println!("cargo:rerun-if-changed={}", repo_src.display());
            &repo_src
        } else if local_src.exists() {
            println!("cargo:rerun-if-changed={}", local_src.display());
            &local_src
        } else {
            panic!(
                "Missing Transfer PWA asset: neither {} nor {} exists",
                repo_src.display(),
                local_src.display()
            );
        };
        let dst = out_dir.join(dst_rel);
        fs::copy(chosen, &dst).unwrap_or_else(|e| {
            panic!("Failed to copy {} -> {}: {e}", chosen.display(), dst.display())
        });
    }
}
