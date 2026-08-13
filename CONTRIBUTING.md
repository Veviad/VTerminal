# Contributing to VTerminal

Thanks for helping improve VTerminal.

## Before you start

- Search existing issues before opening a new one.
- Open an issue before beginning a substantial feature, architectural change, or
  security-sensitive refactor so the approach can be agreed first.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Small fixes and documentation improvements can go directly to a pull request.

## Development

VTerminal requires macOS on Apple Silicon, Node.js 20 or newer, the Rust toolchain
pinned by `rust-toolchain.toml`, and the Xcode command-line tools. Install `cmake`
when building with the `local-llm` feature.

```sh
npm install
npm test
npm run build
```

Run the Rust checks from `src-tauri`:

```sh
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Changes to local inference must also pass the `local-llm` Clippy and test commands
documented in the README. CI is the authoritative check for the macOS build.

## Pull requests

- Keep each pull request focused and explain the user-visible effect.
- Add or update tests for behavior changes.
- Update documentation when commands, settings, or supported behavior changes.
- Do not commit secrets, credentials, generated build output, or model files.
- Resolve review conversations and keep the branch current with `main`.
- Expect review from the repository code owner before merge.

## Developer Certificate of Origin

Every human-authored commit must include a `Signed-off-by` trailer certifying that
you have the right to submit the contribution under this repository's GPL-3.0
license. This follows the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Create signed-off commits with:

```sh
git commit -s
```

The trailer's name and email must match the commit author. If a commit is missing
the trailer, amend it and force-push your pull-request branch. Dependabot commits
are exempt from this check.

## License

By contributing, you agree that your contribution is licensed under GPL-3.0, as
described in [LICENSE](LICENSE).
