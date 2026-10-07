# Fuzzing the importer

`cargo fuzz` on the `.amlsteps` importer, a release check (`releases/<version>.md`). It needs
Rust nightly and `cargo-fuzz` (`rustup toolchain install nightly --profile minimal`, then
`cargo +nightly install cargo-fuzz --locked`).

On Windows the fuzzer needs the address sanitizer's DLL from Visual Studio's C++ tools on the
`PATH` (without it the program exits with `0xc0000135`): the `VC\Tools\MSVC\<version>\bin\Hostx64\x64`
folder of the Visual Studio 2022 Build Tools.

From `apps/desktop/src-tauri/crates/library`:

```
cargo +nightly fuzz run import fuzz/corpus/import fuzz/seeds -- -max_total_time=600
```

`fuzz/seeds/guide.amlsteps` is the shared test guide (`packages/core/test-vectors/guide-v1`) as an
`.amlsteps` file, so the fuzzer starts from something the importer accepts. A crash is saved under
`fuzz/artifacts/import/`; fix it, and add the file to the library's archive tests.

29/09/2026: 61,844 runs in ten minutes, 457 inputs in the corpus, no crash.
02/10/2026 (1.0.0): 53,304 runs in ten minutes, 508 inputs in the corpus, no crash.
07/10/2026 (1.0.0 rebuilt): 54,853 runs in ten minutes, 524 inputs in the corpus, no crash.
