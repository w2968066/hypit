# Deterministic ecommerce template workflow (experimental)

This fork adds `hypit ecommerce` (also `hypit-ecommerce`) for local, personal-use
template compilation and production. Agent reasoning is used when reviewing a template;
production executes a fixed graph and never runs an autonomous reasoning loop.

## Current scope

- Basic: Comfly `gemini-nano-banana-2.1` at **4K** by default; APIMart
  `grok-imagine-1.5-video-ext` at **720p, 9:16**. Actual native fallback dimensions are recorded.
- Advanced: reserved; rejected explicitly until a video-reference Provider is implemented.
- Existing Hypit authoring, Runtime and Providers are unchanged. This experimental command
  has its own local job receipts; it is **not yet** a native Runtime Model/Provider integration.
- No account billing, VLM slot extraction or automatic source-music separation is implemented.
- Template compilation consumes reviewed structured analysis. It does not pretend to
  automatically understand an arbitrary reference video.

## Template-making procedure

1. Probe source media and detect candidate cuts with local media tools.
2. Transcribe spoken Chinese with timestamps. Review recognition errors against the source.
3. Write `analysis.json` following `examples/ecommerce-basic/analysis.json`: retain story,
   roles, speaker order, intended rhythm and physical support relationships. Record original
   visual cuts separately from speech-led production segments when they differ.
4. Abstract the hook, relationship, product evidence and daily payoff as reusable narrative logic.
   Define `overall_focus`, `detail_focus`, `show_action`, roles and dialogue as adaptation slots.
   A cardigan frames the upper body; a non-wearable can be held or used. Category maps are
   optional presets, never a whitelist. `adaptation.slots` and `adaptation.shots` can adapt any
   product with reviewed facts; `ecommerce adapt template.json product.json` lists missing slots.
5. Review the structure, set `reviewed: true`, then compile clips and the original audio mix.
   ASR uncertainty remains explicit in `analysis_status`; review it before production approval.
6. Review a representative garment and non-wearable adaptation, then publish a template version.
   Universal narrative structure does not guarantee every generated shot's visual quality.

## Local use

```sh
node bin/hypit.mjs ecommerce compile analysis.json reference.mp4 new-template
node bin/hypit.mjs ecommerce plan new-template/template.json products/item/product.json new-run
# Or plan all product subfolders. Each needs product.json and its referenced images.
node bin/hypit.mjs ecommerce batch new-template/template.json products batch-output
```

Each product folder supplies `product.json`, image files and factual text slots. Use
`examples/ecommerce-basic/product.example.json` as the input shape. It contains no credentials.
No runtime model is asked to invent fabric composition or performance claims.

### Optional product grill before planning

For a product whose selling points are still unclear, run `grill` before `plan`:

```sh
node bin/hypit.mjs ecommerce grill products/item/product.json
node bin/hypit.mjs ecommerce grill-answer products/item/product.json "your answer to the current question"
# Repeat until the command returns needs_review.
# Revise an earlier answer if needed: grill-answer product.json "better answer" visual_proof
# Map the confirmed points into product.json slots, show the summary to the user, then:
node bin/hypit.mjs ecommerce grill-approve products/item/product.json "user reviewed the selling points and script slots"
```

This turns on `grill_mode` for that product and saves resumable answers in
`product.grill.json`. It asks one question at a time about buyer, reason to ask for the link,
ranked benefits, evidence, visible details, objections, dialogue and forbidden claims.
The agent should probe vague answers before recording them, distinguish visible facts from
unsupported promises, and review the resulting slot wording with the user. If the product
facts change after approval, `plan` requires another review of the changed facts. Changing
render settings or template-specific slot wording does not restart the interview. Products without grill mode
follow the existing flow. The interview belongs to template/product preparation; no model
interview runs inside paid image or video production. See the
[agent interview guide](ecommerce-product-grill.md).

Completed interviews are also saved as `product.profile.json`. `ecommerce product-info
product.json [question-id]` recalls known information when the user forgets it. Store explicit
product facts in `product.json.facts`; template-specific phrasing belongs in `slots` and
`adaptation`. Draft answers remain drafts and are not silently promoted to verified facts.

Set `COMFLY_API_KEY` and `APIMART_API_KEY` in the process environment using a secure local
credential mechanism. Do not put keys in manifests, prompt files, CLI arguments, Git or logs.
`APIMART_BASE_URL` configures one APIMart origin for image upload, video submission and task
polling together. The source default is `https://api.apimart.ai`; the internal handoff uses
`https://api.apib.ai`, read from the user's current ecvideo production provider configuration.
That same key and previous task were verified through the latter host. No DNS/IP pinning or
TLS-verification downgrade is used. New job receipts preserve their original query endpoint.

```sh
# Paid: only after the user has authorized the planned image scope.
node bin/hypit.mjs ecommerce frames new-run --submit
node bin/hypit.mjs ecommerce review new-run
node bin/hypit.mjs ecommerce inspect new-run frames
# The caller's visual model views the supplied references/previews and writes result.json:
node bin/hypit.mjs ecommerce inspect-result new-run result.json
# Only after the human actually approves these exact images and dialogue:
node bin/hypit.mjs ecommerce approve new-run "actual user approval evidence"
node bin/hypit.mjs ecommerce videos new-run --submit
# For a planned batch, equivalent finite stages preserve each product's receipts:
node bin/hypit.mjs ecommerce batch-frames batch-output --submit
node bin/hypit.mjs ecommerce batch-approve batch-output "actual approval of all product reviews"
node bin/hypit.mjs ecommerce batch-videos batch-output --submit
node bin/hypit.mjs ecommerce batch-assemble batch-output
```

Frames run in dependency order: master scene first, then derived views referencing it.
Approval binds the full plan, input images and actual frame bytes. Editing a file invalidates
approval. Changing a generated parent invalidates descendant input receipts instead of silently
reusing stale children. `retry run-dir image|video id "reason"` creates a new tracked attempt,
archives the old asset, and preserves old receipts. An image retry also schedules dependent
frames/clips. A video retry leaves unrelated successful clips reusable. Unknown/running paid
tasks must be resumed or reconciled before another attempt can be prepared.

Generation receipts are saved **before** each billable POST. A missing response is an unknown
submission, never permission to resubmit. Known tasks resume polling/downloading. Concurrent
calls on a project are blocked by an exclusive lock. After a process crash, verify the process
has stopped before manually clearing its stale lock. Task failures require a new authorized attempt.

Grok accepts 6–15 seconds and up to seven image URLs on this endpoint. It has no documented
video-reference field. A two-second editorial shot still incurs at least six generated seconds.
Voice identity, precise speech timing and perfect product preservation are not guaranteed.
The command never silently truncates speech to claim a successful 15-second result.

After watching and listening, supply `edit.json`:

```json
{
  "reviewed": true,
  "evidence": "Actual review of clips and complete dialogue",
  "shots": [
    {"id": "s1", "start": 0, "duration": 3.16, "dialogue_complete": true}
  ],
  "captions": {"path": "alignment/captions.json", "reviewed": true},
  "music_library": {"path": "D:/MusicLibrary", "gain": 0.18}
}
```

List every shot in plan order. `start` is a trim offset into the generated clip. Duration
comes from the plan unless `duration` supplies a reviewed override. Never shorten a sentence
to force the source runtime; changing edit duration does not resubmit generation jobs.
`music_library` is optional and may point outside the run; a relative path
is resolved from `edit.json`. The command picks one supported audio file from the folder for
each run, copies it into `assembly/`, and records the choice in `assembly/music-selection.json`.
Reassembling the same run reuses that copy. Supported types are MP3, WAV, M4A, AAC, FLAC,
OGG and OPUS. Short tracks loop under the dialogue. You can set
`HYPIT_ECOMMERCE_MUSIC_LIBRARY` as a default folder instead, or keep using the older single
track `music: {"path":"music/instrumental.wav","reviewed_music_only":true,"gain":0.15}`.
The repo includes an ignored `music-library/` folder for personal tracks.
Users select and preprocess their tracks. No mood classifier or automatic music-library curation runs.
The original mixed dialogue track is never reused as music automatically. Separate and
listen to any extracted music before marking it reviewed.

```sh
node bin/hypit.mjs ecommerce assemble new-run edit.json
node --test test/ecommerce.test.mjs
```

FFmpeg must be on PATH, or set `HYPIT_ECOMMERCE_FFMPEG` to the executable. Assembly encodes to
720×1280, 30 fps and AAC, then joins the normalized clips. Cropping/color changes are not
advertised as a guarantee against platform similarity detection.

## Captions, model checks and native fallback

Captions default on. `ecommerce align run-dir edit.json` runs local faster-whisper once against
the actual reviewed trims and writes draft ASR/timings to `alignment/captions.json`. Configure
`HYPIT_ECOMMERCE_PYTHON` if necessary (that Python needs faster-whisper). The agent checks the
recognized dialogue, corrects errors from the authored script and marks timings reviewed.
Assembly accepts reviewed JSON cues or SRT and burns captions into the final video; safe margins
at 720×1280 default to left 42, right 145, bottom 315, font size 38. These come from the user's
supplied Douyin interface example. `captions.safe_area` overrides them for a different interface.
Explicit `edit.captions: false` skips captions.
Templates with no dialogue default to `audio_mode: music_only`, disable spoken captions and
skip ASR. A music-only assembly requires an explicitly selected track or user music library.
Silent generated clips are given a silent audio bed during normalization so they can be
joined and mixed with music. Song vocals in source audio never become a dialogue script.

Visual model checks default on. `quality run-dir off` opts out for speed and incurs no visual
review work; `quality run-dir on` enables them again. `inspect run-dir frames|videos` prepares
references and previews; the calling agent's available visual model must actually view them,
then save digest, stage and an item list (`id`, boolean `passed`, array `findings`, textual
`evidence`) through `inspect-result`. Failed checks block the next stage. Three samples per
video screen for product drift, clothing/body intersections, malformed limbs and scene support;
they are not exhaustive frame-by-frame proof. No standalone VLM API is silently called.

API generation is primary. A missing API configuration or known terminal failure produces a
`native_fallback_required` request with the prompt, reference paths and requested settings.
The caller checks its current tools for native image/video generation, uses it if available,
then runs `native-import run-dir image|video id local-file "actual generation evidence"`.
If no matching native capability exists, report that limitation and retain the task. Native
outputs are probed and their actual resolution/duration recorded; there is no fake 4K claim or
silent image upscaling. Uncertain API submissions remain protected from automatic resubmission.

See [fixed operating decisions and sample lessons](ecommerce-decisions.md).

## Contracts and remaining work

Comfly multipart: `POST https://ai.comfly.org/v1/images/edits?async=true`, repeated `image`
parts; status `GET /v1/images/tasks/{id}`. APIMart image upload goes directly to the selected
provider, then `POST /v1/videos/generations`; status `GET /v1/tasks/{id}`. Keys are never sent
to output CDN URLs. Output bytes must identify as PNG/MP4. Unknown statuses and success without
outputs fail explicitly. Submission is never automatically retried.

Sources: [Comfly multipart](https://gpt-best.apifox.cn/api-420646219),
[Comfly task results](https://gpt-best.apifox.cn/api-356258956),
[APIMart Grok](https://docs.apimart.ai/en/api-reference/videos/grok-imagine/generation).

Still required for a production release: native Runtime integration, a graphical batch review UI,
automatic reference-video analysis with reviewed schemas, broader real-product quality evaluation,
and full distribution regression tests. Current tests are targeted contract/recovery tests, not proof of
generated visual quality or provider pricing.
