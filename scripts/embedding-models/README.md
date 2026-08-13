# Veviad E5 embedding artifacts

The app never converts or compiles a model on a user's machine. The two E5 cards
remain visibly unavailable until release CI publishes Veviad-owned Q8_0 GGUFs.

The checked-in manifest pins the official `intfloat` source revisions and
Safetensors hashes. Publication fills the four nullable artifact fields only after
all of these checks pass on Apple Silicon:

1. Convert the pinned official Safetensors revision in an isolated release job.
2. Produce Q8_0 with the release-pinned llama.cpp converter; users never run it.
3. Compare a multilingual golden corpus with Sentence Transformers from the same
   revision: exact `query: ` / `passage: ` prefixes, attention-mask mean pooling,
   L2 normalization, 512-token truncation, batch/padding invariance, dimensions,
   finite vectors, cosine tolerances, and retrieval ranking.
4. Run the GGUF through VTerminal's llama.cpp host on the release architecture.
5. Record the actual byte size and SHA-256, sign the artifact with Veviad's model
   release key, publish it, and only then change the manifest status to `published`.

A release job must fail if `status` is `published` while a URL, size, SHA-256, or
signature is null. Community conversions are not valid substitutes.
