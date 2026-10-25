# Mother–daughter product-link template

Provisional sample for the fork's `hypit ecommerce` command. Read
`docs/guide/ecommerce-basic.md` before use. The source video and user reference image are
intentionally not committed.

Place your approved reference image at `reference.png` and copy `product.example.json`
to `product.json` in a product directory. Edit factual slots to match your actual product.
The sample's cardigan adapts lower-body product shots to upper-body framing and hand gestures.
Other categories need reviewed focus maps and product-appropriate prompt masters.

`analysis.json` separates source visual-cut candidates from speech-led generation boundaries.
The first prototype uses ASR-derived speech boundaries to avoid splitting words across generated
clips; it does not claim frame-exact reproduction. Transcript wording and music separation remain
review items. Do not use the original audio mix as an instrumental track.

The basic and advanced tiers are distinct: this basic sample supplies images to Grok, not reference
video. The compiler retains reference clips for later advanced-mode implementation.
