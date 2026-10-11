fn main() {
    // screencapturekit's Swift bridge needs the system Swift runtime at load
    // time. The crate emits this rpath itself, but link args from a
    // dependency's build script never reach our binaries, so without it the
    // app aborts on launch with "Library not loaded: libswift_Concurrency".
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}
