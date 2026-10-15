# Data sources and licences

Generated 2026-10-15T19:24:40.790Z from `src/lib/licence/datasets.ts`.

Datasets: 16 · shippable: 13 · share-alike or copyleft: 9 · offline-only: 3

## Shippable in a commercial build

| Dataset | Licence | Commercial | Share-alike | Copyleft |
|---|---|---|---|---|
| CEFR-J Vocabulary Profile v1.5 (Open Language Profiles) | © Tono Laboratory, TUFS — free for research and commercial use with citation | yes | no | no |
| Octanove Vocabulary Profile C1/C2 v1.0 | CC BY-SA 4.0 | yes | yes | no |
| wordfreq 3.1.1 | code Apache-2.0; data CC BY-SA 4.0 | yes | yes | no |
| kaikki.org English Wiktextract | CC BY-SA 4.0 + GFDL | yes | yes | no |
| DWDS-Lemmadatenbank | CC BY-SA 4.0 | yes | yes | no |
| Leipzig Corpora Collection | CC BY 4.0 | yes | no | no |
| kaikki.org German Wiktextract | CC BY-SA 4.0 + GFDL | yes | yes | no |
| German CEFR wordlist (ph98) | MIT (repository) — but the `rate` column derives from CC BY-SA data | yes | yes | no |
| CC-CEDICT | CC BY-SA 4.0 | yes | yes | no |
| Frank Richter's ding / Beolingus de-en | GPL-3+ | yes | yes | yes |
| WikDict en–de | CC BY-SA (site: 4.0; FreeDict build: 3.0) | yes | yes | no |
| Tatoeba sentence pairs | CC BY 2.0 FR (a subset is additionally CC0 1.0) | yes | no | no |
| Flowwing seed glosses | CC0-1.0 | yes | no | no |

### Attribution strings (reproduce these verbatim in the product)

- **CEFR-J Vocabulary Profile v1.5 (Open Language Profiles)** — The CEFR-J Wordlist, Version 1.5. Compiled by Yukio Tono, Tokyo University of Foreign Studies.
- **Octanove Vocabulary Profile C1/C2 v1.0** — Octanove Vocabulary Profile C1/C2 v1.0, Octanove Labs.
- **wordfreq 3.1.1** — Robyn Speer
- **kaikki.org English Wiktextract** — Wiktextract (Tatu Ylonen) derived from Wiktionary contributors.
- **DWDS-Lemmadatenbank** — DWDS — Digitales Wörterbuch der deutschen Sprache (BBAW).
- **Leipzig Corpora Collection** — Leipzig Corpora Collection, Universität Leipzig.
- **kaikki.org German Wiktextract** — Wiktextract (Tatu Ylonen) derived from Wiktionary contributors.
- **German CEFR wordlist (ph98)** — ph98/german-cefr-wordlist; frequency column derived from hermitdave/FrequencyWords.
- **CC-CEDICT** — CC-CEDICT (MDBG / community contributors).
- **Frank Richter's ding / Beolingus de-en** — Copyright (c) Frank Richter 1995–2024. Licensed under the GNU General Public License.
- **WikDict en–de** — WikDict, Karl Bartel; derived from Wiktionary via DBnary.
- **Tatoeba sentence pairs** — Tatoeba contributors (see sentences_detailed.csv for per-sentence usernames).
- **Flowwing seed glosses** — Written for Flowwing; no attribution required.

## Offline calibration only — never committed, shipped, or imported

- **Goethe-Institut Wortlisten A1/A2/B1 (+ DTZ, telc)** — © Goethe-Institut — all rights reserved; written consent required for any use. The PDFs state that saving and network distribution require prior written consent, explicitly including intranets. DWDS republishes them as CSV/JSON (dwds.de/api/lemma/goethe/A1.csv) but the copyright is unchanged. NEVER commit, ship, or write these to the database.
- **DeReWo (IDS Mannheim)** — CC BY-NC 3.0 — commercial use expressly not permitted. Rejected: best-constructed German frequency file, worst licence. Its POS lineage is TreeTagger, itself free for research/evaluation only — so no TreeTagger in production either.
- **Existing LLM-generated Chinese glosses (translate.py)** — UNVERIFIED — vendor terms on persisting translations not yet checked. The 8,653 Chinese glosses in the CEFR wordbank were produced by persisting Minimax MT output. Most MT vendors restrict storing translations to build a dataset. Treat as internal-only and replace with CC-CEDICT-derived glosses.

## Combining rules

Share-alike and copyleft data must stay in its own collection. Merging licensed gloss text
into a collection with proprietary text makes the whole collection an adaptation that must
itself be licensed under the same terms. Rebuild merged lookup views at startup instead of
materialising one combined lexicon.
