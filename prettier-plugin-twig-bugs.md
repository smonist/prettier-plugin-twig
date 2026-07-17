# `@zackad/prettier-plugin-twig` — failing edge cases (bug report / PR brief)

**Plugin:** `@zackad/prettier-plugin-twig`
**Version tested:** `0.17.0`
**Repo:** https://github.com/zackad/prettier-plugin-twig
**Prettier:** 3.8.5
**Date:** 2026-07-17

This plugin is a fork of the Melody-based `prettier-plugin-twig-melody`. It fails
on several **valid** Twig constructs. Two classes of failure:

- **Parse crashes** (exit 2, formatting aborts) — annoying but safe; the file is
  left untouched and CI/pre-commit fails loudly.
- **Silent corruption** (exit 0, wrong output) — *dangerous*. The plugin emits
  syntactically or semantically different Twig without any error. These are the
  priority fixes.

All cases below are reproducible with the harness at the end.

---

## Summary

| # | Construct | Class | Result |
|---|-----------|-------|--------|
| 1 | Dynamic element name `<{{ tag }}>…</{{ tag }}>` | parse crash | `ERROR: Expected element start` |
| 2 | Twig tag in attribute position `<el {% if %}…{% endif %}>` | parse crash | `ERROR: Invalid token` / "Twig Tags are not allowed" |
| 3 | String literal with embedded quote + interpolation | **silent corruption** | emits invalid Twig (unescaped quotes) |
| 4 | `??` null-coalesce precedence/associativity | **silent corruption** | drops author parens → deprecation under Twig ≥3.15, different parse under Twig 4 |

---

## Bug 1 — Dynamic element names `<{{ expr }}>`

Twig allows the tag name itself to be an expression, e.g. rendering `h2`/`h3`
or `ol`/`ul` dynamically:

```twig
{% set tag = "h#{level}" %}
<{{ tag }}>{{ text }}</{{ tag }}>
```

**Actual:** `SyntaxError: ERROR: Expected element start`

**Root cause:** `src/melody/melody-parser/Parser.js`, `matchElement()` (~line 318):

```js
if (!(elementName = tokens.nextIf(Types.SYMBOL))) {
    this.error({ title: "Expected element start", ... });
}
const element = new n.Element(elementName.text);
```

The element name is required to be a literal `Types.SYMBOL`. There is no branch
for `Types.EXPRESSION_START` (`{{ … }}`). The matching closing-tag logic further
down also compares `name.text === elementName.text`, assuming a static name.

**Fix direction:** allow the element name to be an expression. Accept
`EXPRESSION_START … EXPRESSION_END` in place of the SYMBOL, store it on the
`Element` node (e.g. `element.dynamicName`), print it back as `<{{ expr }}>`, and
relax the closing-tag matcher so a dynamic open pairs with a dynamic close
(or don't attempt name-equality matching when either side is dynamic).

---

## Bug 2 — Twig tags in attribute position (conditional attributes)

Conditionally emitting whole attributes is idiomatic Twig:

```twig
<button {% if disabled %}disabled{% endif %}>x</button>
<a href="{{ url }}"{% if target %} target="{{ target }}"{% endif %}>x</a>
<button {% if active %}class="on"{% else %}class="off"{% endif %}>x</button>
```

**Actual:** `SyntaxError: ERROR: Invalid token` — advice: *"A tag must consist of
attributes or expressions. Twig Tags are not allowed."*

**Root cause:** `src/melody/melody-parser/Parser.js`, `matchAttributes()`
(~lines 443–457). The attribute loop handles exactly three token kinds:

```js
} else if (tokens.nextIf(Types.EXPRESSION_START)) {     // {{ … }}
    element.attributes.push(this.matchExpression());
    tokens.expect(Types.EXPRESSION_END);
} else if ((twigComment = tokens.nextIf(Types.COMMENT))) { // {# … #}
    …
} else {
    this.error({ title: "Invalid token",
        advice: "A tag must consist of attributes or expressions. Twig Tags are not allowed." });
}
```

There is no branch for `Types.TAG_START` (`{% … %}`), so any `{% if %}`,
`{% for %}`, etc. between attributes throws.

**Fix direction:** add a `Types.TAG_START` branch in `matchAttributes` that
parses the block tag (reuse the core `if`/`for` tag parsers) with the body
parsed *in attribute context* — i.e. the tag's children are attributes, not
element children. The printer then needs to render an `{% if %}` whose branches
contain attributes. This is the largest of the four fixes because it touches
parser, AST, and printer, but it's also the single most common real-world
pattern.

---

## Bug 3 — String literals: embedded quotes + interpolation → invalid output ⚠️

This is **silent data corruption**. Given a string that contains the quote
character and an interpolation (`#{…}`):

```twig
{% set t = x ? " target=\"#{x}\"" : '' %}
```

**Expected (unchanged, or an equivalent valid rewrite):**
```twig
{% set t = x ? " target=\"#{x}\"" : '' %}
```

**Actual (exit 0, no error):**
```twig
{% set t = x ? " target="#{x}"" : '' %}
```

The `\"` escapes are dropped, producing a double-quoted string containing bare
double quotes — **invalid Twig**. This silently breaks the template; you only
find out when the page 500s.

A simpler variant merely restyles quotes (safe but worth noting): `" target=\"foo\""`
→ `' target="foo"'`.

**Root cause:** `src/print/StringLiteral.js`:

```js
const getQuoteChar = (s, options) => {
    if (containsUnmaskedSingleQuote(s)) return '"';
    if (containsUnmaskedDoubleQuote(s)) return "'";
    return quoteChar(options);
};
…
const quote = overridingQuoteChar ? overridingQuoteChar : getQuoteChar(node.value, options);
return quote + node.value + quote;   // <-- never escapes `quote` inside node.value
```

Two problems:
1. `printStringLiteral` wraps `node.value` in the chosen quote **without ever
   escaping occurrences of that quote inside the value.** It relies entirely on
   `getQuoteChar` picking the *other* quote to avoid escaping.
2. That avoidance strategy is bypassed for interpolated strings.
   `printInterpolatedString` in `src/print/BinaryExpression.js` sets
   `STRING_NEEDS_QUOTES = false` on the node (so each literal fragment prints
   **bare**, `getQuoteChar` never runs) and then wraps the joined fragments in
   hardcoded `'"'` characters. So a fragment like ` target="` lands inside
   `"`-quotes with its `"` unescaped, and no escaping compensates.
   (Note: `OVERRIDE_QUOTE_CHAR` is *not* involved here — it is only ever set in
   `src/print/Declaration.js` for doctype declarations.)

**Fix direction:** two touch points. In `printStringLiteral`, escape unescaped
occurrences of the final `quote` char in `node.value` before concatenation. In
`printInterpolatedString`, the hardcoded `"` wrapper is fine *only if* the
literal fragments get embedded `"` escaped — since fragments print bare there,
the escaping must happen on that path too (e.g. keep quotes needed, pass an
override quote char down, and escape against it in `printStringLiteral`).

---

## Bug 4 — dropped author parens: deprecated on Twig ≥3.15, wrong parse on Twig 4 ⚠️

Also **silent corruption** (on Twig 4), semantic this time. The plugin removes
author-written grouping parentheses:

```twig
{% set x = (a ?? b) == c ? 'y' : 'z' %}
```

**Actual (exit 0):**
```twig
{% set x = a ?? b == c ? 'y' : 'z' %}
```

Whether this changes meaning depends on the relative precedence of `??` and `==`
— and **Twig announced a change in 3.15 that takes effect in 4.0**.

From Twig 3.x (`src/Extension/CoreExtension.php`):

```php
new BinaryOperatorExpressionParser(NullCoalesceBinary::class, '??', 300,
    InfixAssociativity::Right, new PrecedenceChange('twig/twig', '3.15', 5), …),
new BinaryOperatorExpressionParser(EqualBinary::class, '==', 20),
```

`PrecedenceChange('twig/twig', '3.15', 5)` means: announced in 3.15, new
precedence **5** effective in **Twig 4.0**. Per the Twig deprecation docs:
*"Using `??` without explicit parentheses to clarify precedence triggers a
deprecation as of Twig 3.15 (in Twig 4.0, `??` will have the lowest
precedence)."*

- Twig **3.x** (incl. ≥3.15): `??` precedence **300** (binds tighter than `==`)
  → `a ?? b == c` ≡ `(a ?? b) == c` → dropping the parens keeps the meaning,
  **but** on ≥3.15 the reformatted template now triggers a deprecation warning
  the author's original code did not.
- Twig **4.0**: `??` precedence **5** (binds looser than `==`=20) →
  `a ?? b == c` ≡ `a ?? (b == c)` → the plugin's output **parses differently**.
  Corruption.

Separately, Twig 3.x already registers `??` as **Right**-associative; the
plugin says LEFT. From `src/melody/melody-extension-core/operators.js`:

```js
export const BinaryNullCoalesceExpression = createBinaryOperatorNode({
    text: "??",
    type: "BinaryNullCoalesceExpression",
    precedence: 300,          // matches Twig 3.x; Twig 4.0 will be 5
    associativity: LEFT       // Twig (all versions) is Right
});
```

This table feeds `otherNeedsParentheses()` in
`src/print/BinaryExpression.js`, which decides paren elision purely from
precedence numbers — so with `??`=300 it considers `(a ?? b)` redundant inside a
`==` and drops the parens. That reconstruction is what breaks: the precedence
table cannot be simultaneously right for Twig 3.x and 4.0, so any elision of
author parens around `??`/`~` is unsafe for one of them.

Note the same file/table: `~` (concat) is `precedence: 40` in the plugin
(matches Twig 3.x), but Twig 4.0 moves it to **27**
(`PrecedenceChange('twig/twig','3.15',27)`, deprecation on 3.15+ when mixed
with `+`/`-` unparenthesized). The whole operator table deserves an audit
against the announced Twig 4 values.

**Fix direction:**
- Primary fix: **preserve author-written parentheses** rather than
  reconstructing them from the precedence table. That is correct on every Twig
  version and also stops emitting newly-deprecated code on 3.15+.
- Do **not** simply swap the table to the Twig 4 values (`??` → 5, `~` → 27) —
  the plugin parses with these precedences too, so that would misparse
  unparenthesized input written for Twig 3.x, which is what most users run
  today. Fix the LEFT→Right associativity mismatch for `??`, though.
- If paren elision is kept at all, make `otherNeedsParentheses` conservative:
  only drop parens when redundant under **both** the 3.x and 4.0 tables, and
  account for associativity at equal precedence (a right-assoc operator needs
  parens on its left operand at equal precedence, and vice-versa).
- Longer term, a plugin option selecting the target Twig version's precedence
  set (parse + print) would allow correct behavior on both sides of 4.0.

---

## Reproduction harness

Run from a checkout that has the plugin installed. `--ignore-path /dev/null`
bypasses any local `.prettierignore`; `--plugin` loads the plugin by name.

```bash
D=$(mktemp -d)

# Bug 1 — dynamic element name (parse crash)
printf '<{{ tag }}>hi</{{ tag }}>\n' > "$D/1.twig"
# Bug 2 — conditional attribute (parse crash)
printf '<button {%% if a %%}disabled{%% endif %%}>x</button>\n' > "$D/2.twig"
printf '<a href="{{ u }}" {%% if t %%}target="{{ t }}"{%% endif %%}>x</a>\n' > "$D/2b.twig"
# Bug 3 — string quote/escape corruption (exit 0, WRONG output)
printf "{%% set t = x ? \" target=\\\\\"#{x}\\\\\"\" : '' %%}\n" > "$D/3.twig"
# Bug 4 — ?? parens dropped (exit 0; deprecated on Twig >=3.15, WRONG on Twig 4)
printf "{%% set x = (a ?? b) == c ? 'y' : 'z' %%}\n" > "$D/4.twig"

for f in "$D"/*.twig; do
  echo "===== $(basename "$f") ====="; cat "$f"; echo "--- prettier ---"
  npx prettier --ignore-path /dev/null --plugin @zackad/prettier-plugin-twig "$f"
  echo "[exit $?]"; echo
done
```

Expected: `1.twig`, `2.twig`, `2b.twig` crash (exit 2). `3.twig` and `4.twig`
"succeed" (exit 0) but emit changed/invalid Twig — those are the corruption bugs.

## Suggested PR order

1. **Bug 3** (string escaping) — smallest, self-contained in `StringLiteral.js`,
   prevents invalid output.
2. **Bug 4** (paren preservation + `??` associativity fix) — focused change in
   `otherNeedsParentheses`; leave the 3.x precedence table in place.
3. **Bug 1** (dynamic tag names) — parser + Element printer.
4. **Bug 2** (Twig tags as attributes) — largest; parser + AST + printer.

Add fixture pairs (`input.twig` / `output.twig`) for each under the plugin's
test suite; the harness snippets above are ready-made inputs.
