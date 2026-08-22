//! Binding generator entry point. Invoked by the Android build to emit Kotlin
//! bindings from the compiled library, e.g.:
//!
//!   cargo run --bin uniffi-bindgen -- generate \
//!     --library target/<triple>/release/libnotifier.so \
//!     --language kotlin --out-dir <android module>/java
fn main() {
    uniffi::uniffi_bindgen_main()
}
