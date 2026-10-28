# Mother–daughter product-link template

Legacy template example: existing compiled copies remain usable. Before compiling a new version, inspect the source and add `shots[].direction` as described in [the direction contract](../../docs/guide/ecommerce-direction.md). Do not infer source evidence from the old prompt alone.

Provisional sample for the fork's `hypit ecommerce` command. Read
`docs/guide/ecommerce-basic.md` before use. The source video and user reference image are
intentionally not committed.

Place your approved reference image at `reference.png` and copy `product.example.json`
to `product.json` in a product directory. Edit factual slots to match your actual product.
For an optional one-question-at-a-time selling-point interview, run
`hypit ecommerce grill product.json` before planning; see the guide for answer and review steps.
At assembly, point `edit.json` at a `music_library` folder to draw one song per product run.
The sample's cardigan adapts lower-body product shots to upper-body framing and hand gestures.
The narrative is reusable across products: adapt role actions, proof shots and dialogue slots;
category maps are optional presets. Use `ecommerce adapt` to find missing adaptation information.

`analysis.json` separates source visual-cut candidates from speech-led generation boundaries.
The first prototype uses ASR-derived speech boundaries to avoid splitting words across generated
clips; it does not claim frame-exact reproduction. Transcript wording and music separation remain
review items. Do not use the original audio mix as an instrumental track.

The basic and advanced tiers are distinct: this basic sample supplies images to Grok, not reference
video. The compiler retains reference clips for later advanced-mode implementation.
