# GLib 0.18.5 security backport

This is the crates.io `glib` 0.18.5 source archive with SHA-256
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
`src/variant_iter.rs` backports [gtk-rs commit b5a4071](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34)
for [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
The patch passes the foreign function a mutable reference to its output
pointer so the optimizer preserves the write.

Tauri's GTK 3 dependencies require `glib` 0.18, and the first upstream
release containing the fix is 0.20. Remove this patch once those dependencies
can resolve a fixed upstream version.
