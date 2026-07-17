# Upstreaming status — bug fixes for `@zackad/prettier-plugin-twig`

Companion to [prettier-plugin-twig-bugs.md](prettier-plugin-twig-bugs.md) (the
validated bug report). This file tracks what is fixed locally, how it maps to
upstream issues, and the steps to get everything merged upstream.

**Upstream repo:** https://github.com/zackad/prettier-plugin-twig
**Base version:** 0.17.0 · Prettier 3.8.5
**Last updated:** 2026-07-17

---

## Current state: all four bugs fixed locally

| Bug | Commit | Tests | Status |
|-----|--------|-------|--------|
| 3 — string literal quote escaping (silent corruption) | `2528e6c` | `tests/Expressions/stringEscaping.twig` | ✅ fixed, verified |
| 4 — author parens dropped (silent corruption) | `3d86f7f` | `tests/Expressions/parenthesesPreservation.twig` | ✅ fixed, verified |
| 1 — dynamic element names `<{{ expr }}>` (parse crash) | `7b723f3` | `tests/Element/dynamicElementName.twig` | ✅ fixed, verified |
| 2 — `{% if %}` in attribute position (parse crash) | `4b9f1ea` | `tests/Element/conditionalAttributes.twig` | ✅ fixed, verified |

Verification per fix: original repro passes (exit 0, correct output), output is
idempotent and re-parseable by the plugin itself, full suite green
(81 tests, 14 files), `npm run lint` and `npm run test-smoke` clean.

Not done: validating printed output against real PHP Twig (needs `composer`
locally, e.g. `brew install composer`, then `composer require twig/twig` in a
scratch dir and a small render script). Optional, but a nice extra proof for
the two corruption PRs.

### Findings beyond the original report (worth mentioning in issues/PRs)

- **Bug 4 is broader than `??`:** the released version also corrupts
  `a - (b - c)` → `a - b - c`, `(a ** b) ** c` → `a ** b ** c` (Twig parses
  `**` right-assoc), `(a ~ b) + c`, and `(c ? 'x' : 'y') + 1` — on *every*
  Twig version. Lead with these examples; they need no Twig-4 context.
- **Bug 2 had a hidden lexer bug:** `{` and `%` are valid attribute-name
  characters per the HTML spec, so `disabled{% endif %}` lexed as one symbol
  `disabled{%`. Fixed in `Lexer.matchSymbol` (a symbol now ends where `{{`,
  `{%` or `{#` starts).
- **Deliberate behavior change (Bug 4):** redundant author parens are no
  longer stripped — `{{ 1 + (2 * 3) }}` stays as written (previously became
  `1 + 2 * 3`; 2 snapshot lines changed in `tests/TwigCodingStandards/`).
  Defensible upstream: the official Twig coding standards show
  `{{ 1 + (2 * 3) }}` as the correct form. Call this out explicitly in the PR.

### Known limitations of the fixes (state them upfront)

- Bug 1: only fully dynamic names (`<{{ expr }}>`, any expression). Mixed
  names like `<h{{ level }}>` or `<{{ type }}l>` are still unsupported
  (see upstream #133 where the maintainer lists these variants).
- Bug 2: only `{% if %}`/`{% elseif %}`/`{% else %}` (incl. nesting) between
  attributes. `{% for %}` and `{% block %}` still error, but now with an
  actionable message. The new `matchAttributeIfBody()` machinery is reusable
  if upstream wants those.
- Bug 2: closing-tag expression of a dynamic element is not compared to the
  opening one; the printer re-emits the opening expression for both.

---

## Upstream issue mapping (checked 2026-07-17)

| Our bug | Upstream | Action |
|---------|----------|--------|
| 1 — dynamic element names | **#60** (original report), **#133** (maintainer's scoping discussion, labeled duplicate) | **Do not open a new issue.** Comment on #133: repro confirmed, fix ready for the fully-dynamic cases, mixed names out of scope. |
| 2 — `{% if %}` in attributes | **#61** is the sibling case (`{% block %}` between attributes), the `if` case is unfiled | **New issue**, cross-reference #61 and note the approach extends to `block`. |
| 3 — string escaping | none found | **New issue.** |
| 4 — paren dropping | none found | **New issue.** |
| — | #137 (conditional *wrapper elements*, unbalanced open/close inside `{% if %}`) | **Not our bug, not fixed by our work.** Do not conflate; mention in the Bug 2 issue only as "related but distinct". |

Repo conventions: no issue templates or CONTRIBUTING.md; titles are plain
symptom sentences; maintainer labels by subsystem (`Parser`, `Printer`, `Bug`).

### Issue structure (per issue)

```markdown
Title: <one-line symptom>

**Plugin:** @zackad/prettier-plugin-twig 0.17.0 · **Prettier:** 3.8.5

### Input            — minimal .twig snippet
### Command          — npx prettier --plugin @zackad/prettier-plugin-twig file.twig
### Expected / Actual — for corruption bugs stress: exit 0, wrong/invalid output
### Why this matters — 1-2 sentences severity framing
### Root cause       — file + line + short explanation (from the bugs doc)

I have a fix with tests ready and will open a PR referencing this issue.
```

Planned titles:

1. "Printer emits invalid Twig: quote characters in string literals are never
   escaped" (severity lead: silent corruption, exit 0)
2. "Printer drops author-written parentheses, changing expression semantics"
   (lead with `a - (b - c)`; `??`/Twig-4 deprecation as second half)
3. "Parser doesn't allow {% if %} tags in attribute position (conditional
   attributes)" (reference #61, mention #137 as distinct)

---

## How to proceed

1. **Housekeeping first:** drop the untracked `package-lock.json` (repo uses
   yarn) and review the uncommitted `yarn.lock` change before branching.
2. **File the three issues** + the #133 comment (drafts per structure above).
3. **Open PRs, one per commit, in this order** (smallest/safest first, matches
   the bugs doc):
   1. `2528e6c` string escaping → "Fixes #<issue-3>"
   2. `3d86f7f` paren preservation → "Fixes #<issue-4>" — flag the
      redundant-parens behavior change prominently
   3. `7b723f3` dynamic element names → "Fixes #60", reference #133 with the
      supported/unsupported matrix
   4. `4b9f1ea` if-in-attributes → "Fixes #<issue-2>", reference #61
   Each commit already contains its fixture tests and a detailed message that
   can serve as the PR description. Branch off upstream `master` per PR
   (`git rebase --onto` or cherry-pick each commit onto a fresh branch), since
   the local `master` also carries the two docs (`prettier-plugin-twig-bugs.md`,
   `UPSTREAMING.md`) which should stay out of the PRs.
4. **If maintainers push back** on the Bug 4 behavior change, the fallback
   discussed in the bugs doc: only drop parens when provably redundant under
   both the Twig 3.x and 4.0 precedence tables — more code, same safety.
5. **Optional:** PHP Twig render-validation of the corruption fixtures
   (see "Not done" above) to attach to PRs 1–2.
