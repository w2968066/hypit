# Ecommerce operating decisions and sample lessons

These are the user's accepted operating choices. Carry them into future agent sessions.

- Personal use through an agent and this fork; no ecvideo account/billing integration now.
- Ask API versus native separately for images and videos before first production; reuse settled
  choices. If API is chosen: Comfly Nano Banana 2.1, default 4K; APIMart Grok basic,
  default 720p and 9:16. Keep basic and future reference-video advanced routes distinct.
- Use native image/video generation as a fallback only when the user explicitly allows it and the calling environment actually
  exposes that capability. Report actual output dimensions; native image generation may not
  meet a 4K request. A native video tool is not assumed to exist.
- A template owns a general narrative: curiosity about origin, explanation, peer interest,
  visible evidence and daily payoff. All products adapt roles, actions, detail focus and words
  to this logic. Clothing categories are examples, not the boundary of the template.
- Retain scene and character anchors across images and clips. If trousers become a cardigan,
  move evidence shots to the upper body. If the product is not worn, adapt interaction and
  proof shots to holding or using it. Retain necessary support surfaces when changing scenery.
- Optional visual checks use the caller's model to inspect actual media. A speed-focused user
  may turn them off. Failed shots get local replacement attempts; unrelated outputs are retained.
- Users curate and preprocess their music libraries. Draw one track per run and save the choice;
  do not add automatic mood screening or excessive music controls.
- An optional product interview asks one meaningful question at a time and probes vague claims.
  Read known information first. Completed information becomes a reusable product profile;
  recall it for the user and ask only about missing or changed facts.

The mother–daughter cardigan sample established these practical lessons:

1. The user's product request was 4K; never silently substitute a 2K default. Preserve the
   requested API route and record each actual fallback route and dimension.
2. A good first frame does not guarantee the video preserves garment pattern or anatomy.
   Optional checks cover both stills and sampled generated footage.
3. One generated ending omitted its final phrase. Review actual speech and replace only that
   clip; retain complete dialogue even when the final runtime exceeds the reference.
4. Caption spelling comes from confirmed dialogue, while timing comes from actual speech.
   Local ASR confused 开衫/开山 and 菱格/铃格; never burn raw recognition errors as product text.
5. Low captions were covered by the platform UI. Use the provided safe margins and inspect
   long phrases in wide, close and final shots. Right buttons and the shopping/description area
   need space. Platform overlays vary, so margins remain configurable.
6. The reference had mixed dialogue/music. Do not overlay that mixed track as clean music.
   Prefer the user's prepared library; source separation is an explicit optional preparation.
7. In the interview, 140 meant child height, while stock sizes were 130–170. Keep height,
   clothing size and school stage distinct. Do not infer an age solely from height, and do not
   repeat facts the user has already clarified.
8. A test ended after the first interview answer. Keep partial facts as draft information;
   stopping a test is not confirmation of unanswered selling points or final approval.

New production decisions: first-use optional grill reminder; a finite product×template×repeat
matrix; upfront unattended authorization; script-only API production with visual checks explicitly
off; real hook capability checks when native/model inspection is selected; persistent call caps,
STOP boundaries, receipt-safe resume, failure isolation and product-folder exports. Local ASR
checks content coverage and sentence endings before automatic caption/trim approval. This is
a machine policy, not a fabricated human review. See ecommerce-unattended.md for limits.
