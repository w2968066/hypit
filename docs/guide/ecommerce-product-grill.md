# Optional product grill for agent operators

Run `hypit ecommerce grill product.json` when the user asks to explore selling points before
production. This is an interview during product preparation, not a model loop in the video
generation pipeline.

Ask the returned question **one at a time**. Read the current product JSON and supplied product
images and `product.profile.json` first; `product-info` recalls saved answers. Approved product
facts are reused across templates. Only missing or changed information needs a question.
If the user says only “好看”, “质量好”, “很保暖” or a similar broad claim, ask what
can actually be seen, measured or documented. Press on contradictions and buying objections;
do not invent fabric, performance, certification or sales claims. The `probe` field is a prompt
for follow-up, not another mandatory question to dump on the user.

When the answer is concrete enough, summarize it faithfully and record the distilled wording:

```sh
node bin/hypit.mjs ecommerce grill-answer products/item/product.json "specific answer"
```

The next question appears in the command result. The session resumes from `product.grill.json`
after a restart. Revise an answer with `grill-answer product.json "new wording" question_id`.
Do not conflate height, clothing size and school stage: in the live test, 140 meant child
height while available sizes were 130–170. Ask only the ambiguity that changes product or
casting decisions; never infer age from height. If the user ends a test, retain partial answers
as drafts and stop the interview.
After the eighth answer, show the user a short brief: target buyer, ranked selling points,
evidence for each, the upper/lower-body details the video can show, objections, safe dialogue,
and claims to avoid. Then map approved points into the existing `slots` in `product.json`.
Only after actual review, run `grill-approve` with review evidence. Planning checks that the
approved product has not changed. A user may leave grill mode off and plan directly.
`grill-approve` also writes `product.profile.json`; render settings and a new template's slot
wording do not erase this knowledge. `product-info product.json` provides recall and lists gaps.

This follows the structured, resumable one-question-at-a-time interview pattern described by
[grill-me](https://github.com/stevegsax/grill-me); it is tailored to ecommerce product evidence
and the template's shot focus.
