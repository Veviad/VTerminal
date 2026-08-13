//! Splitting an extracted document into retrievable chunks.
//!
//! Pure: no database, no IO, no app handle. Re-indexing a file years later must
//! produce the same segmentation as the first pass, so everything that varies is a
//! parameter (`ChunkSpec`, stored per bucket) rather than a constant read at call
//! time.
//!
//! **A chunk is a BYTE RANGE over the source text, never a rebuilt string.** That
//! is the whole design, and it makes two properties structural instead of merely
//! tested:
//!
//! 1. Every boundary comes from `char_indices`, so a chunk can never split a
//!    multi-byte character. (The same class of bug as `OutputSplitter`'s
//!    char-boundary hold-back in `provider/local.rs`, which held back a fixed BYTE
//!    count and cut UTF-8 in half.)
//! 2. Overlap is exact and needs no string surgery: chunk N+1 simply *starts
//!    earlier* than chunk N ended. Consecutive chunks are contiguous ranges over
//!    one buffer, so the overlap is literally the same bytes, not a copy that could
//!    drift.
//!
//! It also means the original whitespace survives verbatim — paragraph breaks and
//! code indentation reach the model as the author wrote them, which a
//! split-and-rejoin approach quietly destroys.

use std::ops::Range;

/// Segmentation parameters, stored per bucket in `doc_buckets`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkSpec {
    /// Target characters per chunk, counted in `char`s (not bytes — a German or
    /// CJK document would otherwise get chunks a third the intended size).
    pub target_chars: usize,
    /// Characters of the previous chunk repeated at the start of the next, so a
    /// passage straddling a boundary is still wholly present in one chunk.
    pub overlap_chars: usize,
}

impl Default for ChunkSpec {
    fn default() -> Self {
        Self {
            target_chars: 1000,
            overlap_chars: 150,
        }
    }
}

impl ChunkSpec {
    /// Overlap must stay strictly below target, or the packer cannot make progress:
    /// a flush would rewind the start to at-or-before where the chunk began and the
    /// loop would emit the same range forever. Clamped rather than rejected because
    /// these values can arrive from a hand-edited `docs.db`.
    fn sane(self) -> Self {
        let target = self.target_chars.max(64);
        Self {
            target_chars: target,
            overlap_chars: self.overlap_chars.min(target / 2),
        }
    }
}

/// One page of an extracted PDF. Markdown and plain text arrive as a single
/// pseudo-page with `page: None`.
#[derive(Debug, Clone)]
pub struct SourcePage {
    pub page: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub ord: u32,
    /// The page the chunk STARTS on. A chunk may run past a page break — that is
    /// deliberate, because splitting mid-sentence at every page boundary measurably
    /// hurts retrieval — so this is the citable anchor, not a claim of containment.
    pub page: Option<u32>,
    /// The nearest markdown/HTML heading at or above the chunk's start, as a path
    /// (`"Deploys > Rolling back"`). `None` before the first heading.
    pub heading: Option<String>,
    pub text: String,
}

/// Chunk a document supplied as pages.
///
/// Pages are joined into ONE buffer before chunking rather than chunked
/// independently. Per-page chunking would cut every sentence that straddles a page
/// break and leave a short tail chunk per page — on a 400-page manual that is 400
/// fragments competing in the ranking against real passages.
pub fn chunk_pages(pages: &[SourcePage], spec: ChunkSpec) -> Vec<Chunk> {
    const PAGE_SEP: &str = "\n\n";
    let mut buf = String::new();
    // (byte offset where the page starts in `buf`, page number)
    let mut page_marks: Vec<(usize, Option<u32>)> = Vec::with_capacity(pages.len());
    for page in pages {
        if !buf.is_empty() {
            buf.push_str(PAGE_SEP);
        }
        page_marks.push((buf.len(), page.page));
        buf.push_str(&page.text);
    }
    chunk_buffer(&buf, &page_marks, spec)
}

/// Chunk a document that has no page structure.
pub fn chunk_text(text: &str, spec: ChunkSpec) -> Vec<Chunk> {
    chunk_buffer(text, &[(0, None)], spec)
}

fn chunk_buffer(buf: &str, page_marks: &[(usize, Option<u32>)], spec: ChunkSpec) -> Vec<Chunk> {
    let spec = spec.sane();
    let headings = heading_marks(buf);
    let atoms = atomize(buf, spec.target_chars);

    let mut out: Vec<Chunk> = Vec::new();
    let mut start = 0usize;
    let mut end = 0usize;

    let flush = |start: usize, end: usize, out: &mut Vec<Chunk>| {
        let text = &buf[start..end];
        if text.trim().is_empty() {
            return;
        }
        out.push(Chunk {
            ord: out.len() as u32,
            page: page_at(page_marks, start),
            heading: heading_at(&headings, start),
            text: text.to_string(),
        });
    };

    for atom in atoms {
        // An atom is never longer than `target_chars` (atomize guarantees it), so
        // this can always make progress.
        if end > start && count_chars(&buf[start..atom.end]) > spec.target_chars {
            flush(start, end, &mut out);
            start = rewind(buf, end, spec.overlap_chars);
        }
        end = atom.end;
    }
    flush(start, end, &mut out);
    out
}

/// Partition `buf` into contiguous ranges, each at most `target` chars.
///
/// Paragraph first, then sentence, then a hard character cut — the standard ladder,
/// but note the ranges PARTITION the buffer: separators are absorbed into the
/// preceding atom rather than discarded, which is what lets a packed chunk be a
/// single slice of the original.
fn atomize(buf: &str, target: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    for para in split_keeping_separators(buf, "\n\n") {
        if count_chars(&buf[para.clone()]) <= target {
            out.push(para);
            continue;
        }
        for sentence in split_sentences(buf, para.clone()) {
            if count_chars(&buf[sentence.clone()]) <= target {
                out.push(sentence);
                continue;
            }
            // A single sentence over the target: a minified line, a base64 blob, a
            // table row. Cut on char boundaries and move on — snapping back to a word
            // boundary where one is close enough, so the next atom does not open
            // mid-word.
            let mut at = sentence.start;
            while at < sentence.end {
                let hard = advance(buf, at, target).min(sentence.end);
                let stop = if hard < sentence.end {
                    snap_back_to_word(buf, at, hard)
                } else {
                    hard
                };
                out.push(at..stop);
                at = stop;
            }
        }
    }
    if out.is_empty() && !buf.is_empty() {
        out.push(0..buf.len());
    }
    out
}

/// Split on `sep`, keeping the separator attached to the end of each piece so the
/// pieces partition the input.
fn split_keeping_separators(buf: &str, sep: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < buf.len() {
        match buf[at..].find(sep) {
            Some(rel) => {
                let stop = at + rel + sep.len();
                out.push(at..stop);
                at = stop;
            }
            None => {
                out.push(at..buf.len());
                break;
            }
        }
    }
    out
}

/// Sentence boundaries: `.`/`!`/`?` followed by whitespace. Deliberately naive —
/// this only runs on paragraphs already too long to keep whole, where a
/// mis-split at "e.g." costs nothing a reader or a ranker would notice.
fn split_sentences(buf: &str, range: Range<usize>) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = range.start;
    let slice = &buf[range.clone()];
    let mut prev_terminator: Option<usize> = None;
    for (rel, ch) in slice.char_indices() {
        let abs = range.start + rel;
        if let Some(t_end) = prev_terminator.take() {
            if ch.is_whitespace() {
                out.push(start..t_end);
                start = t_end;
            }
        }
        if matches!(ch, '.' | '!' | '?') {
            prev_terminator = Some(abs + ch.len_utf8());
        }
    }
    if start < range.end {
        out.push(start..range.end);
    }
    out
}

/// Byte offset `n` chars forward of `from`, clamped to the end of `buf`.
fn advance(buf: &str, from: usize, n: usize) -> usize {
    buf[from..]
        .char_indices()
        .nth(n)
        .map(|(i, _)| from + i)
        .unwrap_or(buf.len())
}

/// Byte offset `n` chars back from `end`, never at or before `0`, always on a char
/// boundary. This is the overlap seed, and therefore where the NEXT chunk starts.
///
/// Snaps FORWARD to the next word boundary, which is what stops a chunk opening
/// mid-word. Measured on a real table-dense PDF, 70 of 81 chunks began with a word
/// fragment (`"ly-equivalent prices are billed annual…"`) before this: pdf.js yields
/// few paragraph breaks, so almost every chunk boundary came from this rewind.
/// Retrieval never cared — FTS5 tokenizes on word boundaries and the overlap keeps the
/// context whole — but every passage shown to the user and quoted to the model opened
/// mid-word.
///
/// Forward rather than back is deliberate: it can only shorten the overlap, so the
/// `target + overlap` ceiling still holds. It also cannot stall the packer, because the
/// result stays strictly below `end` (see the bound below).
fn rewind(buf: &str, end: usize, n: usize) -> usize {
    if n == 0 {
        return end;
    }
    let head = &buf[..end];
    let total = count_chars(head);
    if total <= n {
        return 0;
    }
    let at = head
        .char_indices()
        .nth(total - n)
        .map(|(i, _)| i)
        .unwrap_or(0);

    // Never consume more than half the overlap looking for a word boundary: past that
    // the overlap has stopped being useful, and a run of `n/2` non-space characters is
    // a token that has no boundary to find (a hash, a URL, CJK text with no spaces).
    let limit = advance(buf, at, n / 2).min(end);
    match buf[at..limit].find(char::is_whitespace) {
        // +1 char past the whitespace, so the chunk starts ON the word rather than on
        // the space before it.
        Some(rel) => advance(buf, at + rel, 1).min(end),
        None => at,
    }
}

/// The last word boundary at or before `hard`, or `hard` itself when there is none
/// close enough.
///
/// Used only for the hard-cut ladder in `atomize`, where there is no paragraph or
/// sentence break to fall back on. The window is a fraction of the atom so a
/// boundary-free run (base64, a long hash) still cuts at exactly `target` rather than
/// collapsing to a tiny atom — and `> from` guarantees forward progress, without which
/// the surrounding `while` loop would spin.
fn snap_back_to_word(buf: &str, from: usize, hard: usize) -> usize {
    let window = (hard - from) / 6; // ~15% of the atom
    let earliest = hard.saturating_sub(window).max(from + 1);
    match buf[earliest..hard]
        .char_indices()
        .rfind(|(_, c)| c.is_whitespace())
    {
        Some((rel, c)) => {
            let after = earliest + rel + c.len_utf8();
            if after > from && after <= hard {
                after
            } else {
                hard
            }
        }
        None => hard,
    }
}

fn count_chars(s: &str) -> usize {
    s.chars().count()
}

fn page_at(marks: &[(usize, Option<u32>)], offset: usize) -> Option<u32> {
    marks
        .iter()
        .rev()
        .find(|(at, _)| *at <= offset)
        .and_then(|(_, page)| *page)
}

/// (byte offset, level, title) for every markdown ATX heading, in order.
fn heading_marks(buf: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut at = 0usize;
    for line in buf.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) {
            let rest = &trimmed[hashes..];
            if rest.starts_with(' ') || rest.starts_with('\t') {
                let title = rest.trim().trim_end_matches('#').trim().to_string();
                if !title.is_empty() {
                    out.push((at + indent, hashes, title));
                }
            }
        }
        at += line.len();
    }
    out
}

/// The heading path in effect at `offset`: the nearest heading at or before it,
/// prefixed by its ancestors. `## B` under `# A` reads `"A > B"`.
fn heading_at(marks: &[(usize, usize, String)], offset: usize) -> Option<String> {
    let idx = marks.iter().rposition(|(at, _, _)| *at <= offset)?;
    let (_, level, ref title) = marks[idx];
    let mut path = vec![title.clone()];
    let mut want = level;
    for (_, l, t) in marks[..idx].iter().rev() {
        if *l < want {
            path.push(t.clone());
            want = *l;
            if want == 1 {
                break;
            }
        }
    }
    path.reverse();
    Some(path.join(" > "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(target: usize, overlap: usize) -> ChunkSpec {
        ChunkSpec {
            target_chars: target,
            overlap_chars: overlap,
        }
    }

    /// The invariant the byte-range design exists to guarantee, over text that is
    /// nothing but multi-byte characters: German umlauts (2 bytes), CJK (3), em
    /// dashes (3), and a ZWJ emoji family (25 bytes across 7 codepoints) — the
    /// widest sequence likely to appear in a real document.
    ///
    /// Two distinct failures are covered. A boundary off a char boundary makes
    /// `&buf[start..end]` **panic inside `chunk_text`**, so it never reaches an
    /// assertion — the test body being entered at all is the first check. The
    /// `overlap == 0` case then adds a real assertion: the chunks must partition the
    /// source exactly, which catches boundaries that are *valid* but drop or
    /// duplicate characters.
    #[test]
    fn never_splits_a_multibyte_character() {
        let text = "Rückgängig machen — 日本語のテキスト — 👨‍👩‍👧‍👦 family. ".repeat(40);
        // Deliberately including sizes that land mid-character if counted as bytes.
        for target in [64usize, 65, 66, 100, 137, 512] {
            let partitioned: String = chunk_text(&text, spec(target, 0))
                .iter()
                .map(|c| c.text.as_str())
                .collect();
            assert_eq!(
                partitioned, text,
                "target {target} did not partition multi-byte text exactly"
            );

            for overlap in [1usize, 7, 31] {
                let chunks = chunk_text(&text, spec(target, overlap));
                assert!(!chunks.is_empty(), "target {target} produced nothing");
                // Every chunk is a real slice of the source, not a rebuilt string.
                for c in &chunks {
                    assert!(
                        text.contains(c.text.as_str()),
                        "chunk is not a contiguous slice of the source"
                    );
                }
            }
        }
    }

    /// The overlap is a genuine SUFFIX of the previous chunk, at most `overlap_chars`
    /// long.
    ///
    /// Deliberately weaker than "exactly the last `overlap_chars` characters", which is
    /// what this asserted before `rewind` learned to snap forward to a word boundary.
    /// Snapping can only shorten the overlap, never lengthen or move it, so a suffix
    /// check still catches the failure the strict version was written for — an
    /// off-by-one or a misplaced rewind, either of which breaks the suffix relation
    /// outright rather than merely shortening it.
    #[test]
    fn the_overlap_is_a_suffix_of_the_previous_chunk() {
        let text = (0..400)
            .map(|i| format!("Sentence number {i} carries enough words to matter. "))
            .collect::<String>();
        let overlap = 60usize;
        let chunks = chunk_text(&text, spec(500, overlap));
        assert!(chunks.len() > 3, "expected several chunks");

        for pair in chunks.windows(2) {
            let (prev, next) = (&pair[0], &pair[1]);
            // The repeated span is however much of `next`'s head also ends `prev`.
            let shared = (1..=overlap.min(next.text.chars().count()))
                .filter(|n| {
                    let head: String = next.text.chars().take(*n).collect();
                    prev.text.ends_with(&head)
                })
                .max();
            let shared = shared.unwrap_or_else(|| {
                panic!(
                    "chunk shares no suffix with its predecessor\n  prev tail: {:?}\n  next head: {:?}",
                    prev.text.chars().rev().take(70).collect::<String>(),
                    next.text.chars().take(70).collect::<String>()
                )
            });
            assert!(
                shared <= overlap,
                "overlap of {shared} exceeds the configured {overlap}"
            );
            // And it must not have collapsed to nothing useful: half the configured
            // overlap is the floor `rewind` is allowed to trade away for a boundary.
            assert!(
                shared >= overlap / 2,
                "overlap shrank to {shared} of {overlap} — the word-boundary snap should \
                 give up after half"
            );
        }
    }

    /// The finding this fix exists for. A table-dense PDF gives pdf.js almost no
    /// paragraph breaks, so every boundary comes from the overlap rewind or a hard cut —
    /// and 70 of 81 chunks from a real 25-page document opened with a word fragment.
    ///
    /// The fixture reproduces that shape: one enormous run of words with no paragraph
    /// break and no sentence punctuation, so neither earlier rung of the ladder applies.
    ///
    /// **The word lengths must VARY.** A first attempt used uniform `token0000` +
    /// space — exactly 10 characters — and every `(target, overlap)` pair happened to be
    /// a multiple of 10, so the rewind landed on a word boundary by arithmetic luck and
    /// the test passed with the fix disabled. Ragged lengths and a target/overlap pair
    /// that shares no factor with them are what make it real.
    #[test]
    fn chunks_start_on_word_boundaries() {
        let lengths = [3usize, 7, 4, 11, 5, 9, 2, 13, 6, 8];
        let words: Vec<String> = (0..1200)
            .map(|i| "abcdefghijklm"[..lengths[i % lengths.len()]].to_string() + &i.to_string())
            .collect();
        let text = words.join(" ");

        for (target, overlap) in [(307usize, 41usize), (503, 61), (997, 149)] {
            let chunks = chunk_text(&text, spec(target, overlap));
            assert!(chunks.len() > 3, "expected several chunks");

            let fragments: Vec<&str> = chunks
                .iter()
                .map(|c| c.text.as_str())
                .filter(|t| !words.iter().any(|w| t.starts_with(w.as_str())))
                .collect();
            assert!(
                fragments.is_empty(),
                "at target {target}/{overlap}, {} chunk(s) open mid-word: {:?}",
                fragments.len(),
                fragments
                    .iter()
                    .map(|t| t.chars().take(24).collect::<String>())
                    .collect::<Vec<_>>()
            );
        }
    }

    /// A run with no whitespace at all — a hash, a base64 payload, unspaced CJK — has no
    /// word boundary to find. It must still chunk at the target rather than collapsing
    /// into tiny atoms or spinning.
    #[test]
    fn a_boundary_free_run_still_cuts_at_the_target() {
        let text = "a".repeat(20_000);
        let chunks = chunk_text(&text, spec(1000, 150));
        assert!(chunks.len() > 15, "got {} chunks", chunks.len());
        for c in &chunks {
            assert!(
                c.text.chars().count() <= 1150,
                "chunk of {} chars exceeds target + overlap",
                c.text.chars().count()
            );
        }
        // No chunk may degenerate to a sliver: that would mean the snap-back window ate
        // the whole atom on text it should have left alone.
        let smallest = chunks.iter().map(|c| c.text.chars().count()).min().unwrap();
        assert!(smallest > 100, "smallest chunk is {smallest} chars");
    }

    #[test]
    fn zero_overlap_produces_disjoint_chunks() {
        let text = "alpha beta gamma delta epsilon zeta eta theta ".repeat(30);
        let chunks = chunk_text(&text, spec(200, 0));
        let rejoined: String = chunks.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(
            rejoined.trim(),
            text.trim(),
            "with no overlap the chunks must partition the source exactly"
        );
    }

    /// A single enormous line — a minified bundle, a base64 payload, one long table
    /// row — has no paragraph or sentence boundary to split on. It must still chunk
    /// rather than emit one 50k-char chunk that blows the tool-result budget.
    #[test]
    fn a_single_enormous_line_still_chunks() {
        let text = "x".repeat(50_000);
        let chunks = chunk_text(&text, spec(1000, 100));
        assert!(chunks.len() > 40, "got {} chunks", chunks.len());
        for c in &chunks {
            assert!(
                c.text.chars().count() <= 1000 + 100,
                "chunk of {} chars exceeds target + overlap",
                c.text.chars().count()
            );
        }
    }

    #[test]
    fn no_chunk_exceeds_target_plus_overlap() {
        let text = (0..200)
            .map(|i| format!("Paragraph {i}. It has two sentences of moderate length here.\n\n"))
            .collect::<String>();
        let (target, overlap) = (700usize, 120usize);
        for c in chunk_text(&text, spec(target, overlap)) {
            assert!(
                c.text.chars().count() <= target + overlap,
                "chunk of {} chars exceeds {} + {}",
                c.text.chars().count(),
                target,
                overlap
            );
        }
    }

    #[test]
    fn empty_and_whitespace_input_produce_no_chunks() {
        assert!(chunk_text("", ChunkSpec::default()).is_empty());
        assert!(chunk_text("   \n\n  \t\n", ChunkSpec::default()).is_empty());
    }

    #[test]
    fn ords_are_dense_and_ascending() {
        let text = "word ".repeat(2000);
        let chunks = chunk_text(&text, spec(300, 40));
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.ord, i as u32);
        }
    }

    /// A chunk is citable: it reports the page it starts on, so a result can say
    /// "runbook.pdf p.12". Attribution follows the START, which is why a chunk that
    /// runs past a page break still names the page a reader should open.
    #[test]
    fn pages_are_attributed_from_the_chunk_start() {
        let pages: Vec<SourcePage> = (1..=6)
            .map(|p| SourcePage {
                page: Some(p),
                text: format!("Page {p} content. ").repeat(30),
            })
            .collect();
        let chunks = chunk_pages(&pages, spec(400, 50));
        assert!(chunks.len() >= 6);
        assert_eq!(chunks[0].page, Some(1), "first chunk starts on page 1");

        // Pages must be non-decreasing, and every page must be cited at least once.
        let seen: Vec<u32> = chunks.iter().filter_map(|c| c.page).collect();
        assert!(
            seen.windows(2).all(|w| w[0] <= w[1]),
            "page attribution went backwards: {seen:?}"
        );
        for p in 1..=6u32 {
            assert!(seen.contains(&p), "page {p} was never cited: {seen:?}");
        }
    }

    /// A page boundary is not a chunk boundary. Joining pages before chunking is a
    /// deliberate quality choice, and this pins it: per-page chunking would leave a
    /// short tail chunk for every page.
    #[test]
    fn a_chunk_may_span_a_page_break() {
        let pages = vec![
            SourcePage {
                page: Some(1),
                text: "The rollback procedure begins".into(),
            },
            SourcePage {
                page: Some(2),
                text: "and completes on the next page.".into(),
            },
        ];
        let chunks = chunk_pages(&pages, spec(1000, 0));
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].text.contains("begins"));
        assert!(chunks[0].text.contains("completes"));
        assert_eq!(chunks[0].page, Some(1));
    }

    #[test]
    fn headings_build_a_path() {
        let text = "\
# Deploys

Some intro text about deploying things to production.

## Rolling back

To revert a release, run the rollback script and wait.

### Edge cases

Occasionally the lock file survives a crash.
";
        let chunks = chunk_text(text, spec(60, 0));
        let headings: Vec<Option<String>> = chunks.iter().map(|c| c.heading.clone()).collect();
        assert!(
            headings.contains(&Some("Deploys".into())),
            "got {headings:?}"
        );
        assert!(
            headings.contains(&Some("Deploys > Rolling back".into())),
            "got {headings:?}"
        );
        assert!(
            headings.contains(&Some("Deploys > Rolling back > Edge cases".into())),
            "got {headings:?}"
        );
    }

    #[test]
    fn text_before_the_first_heading_has_none() {
        let text = "Front matter with no heading yet.\n\n# Later\n\nBody.";
        let chunks = chunk_text(text, spec(40, 0));
        assert_eq!(chunks[0].heading, None);
    }

    /// A `#` that is not a heading — a shell comment, a CSS id, a Rust attribute —
    /// must not become one, or every code-heavy document grows a nonsense outline.
    #[test]
    fn a_hash_without_a_space_is_not_a_heading() {
        let text = "#!/bin/zsh\n#no-space\n#000000\n\nBody text follows here.";
        let chunks = chunk_text(text, ChunkSpec::default());
        assert_eq!(chunks[0].heading, None, "got {:?}", chunks[0].heading);
    }

    /// Overlap at or above target would rewind the start to where the chunk began
    /// and loop forever. `sane()` clamps it; without the clamp this test hangs
    /// rather than fails, which is exactly why the clamp is not left to callers.
    #[test]
    fn overlap_at_or_above_target_is_clamped_and_still_terminates() {
        let text = "some reasonably long body text to force several chunks ".repeat(50);
        for overlap in [1000usize, 5000, usize::MAX / 2] {
            let chunks = chunk_text(&text, spec(200, overlap));
            assert!(!chunks.is_empty());
            assert!(chunks.len() < 10_000, "runaway: {} chunks", chunks.len());
        }
    }

    /// A realistic manual: the count should be roughly source-length / target,
    /// inflated by overlap. Pinning the order of magnitude catches a regression that
    /// makes chunks tiny (one per sentence) or enormous (one per page).
    #[test]
    fn a_long_manual_chunks_proportionally() {
        let pages: Vec<SourcePage> = (1..=400)
            .map(|p| SourcePage {
                page: Some(p),
                text: format!(
                    "Chapter section {p}. Each page carries a few paragraphs of prose \
                     describing configuration, defaults, and the occasional caveat.\n\n\
                     A second paragraph on page {p} adds detail worth retrieving.\n\n"
                ),
            })
            .collect();
        let total: usize = pages.iter().map(|p| p.text.chars().count()).sum();
        let chunks = chunk_pages(&pages, ChunkSpec::default());
        let lower = total / 1000;
        let upper = total / 1000 * 3;
        assert!(
            (lower..=upper).contains(&chunks.len()),
            "{} chunks for {total} chars is outside {lower}..={upper}",
            chunks.len()
        );
    }
}
