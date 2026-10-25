# Deterministic ecommerce template workflow (experimental)

This fork adds `hypit ecommerce` (also `hypit-ecommerce`) for local, personal-use
template compilation and production. Agent reasoning is used when reviewing a template;
production executes a fixed graph and never runs an autonomous reasoning loop.

## Current scope

- Basic: Comfly `gemini-nano-banana-2.1`, APIMart `grok-imagine-1.5-video-ext`.
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
4. Define category-specific `overall_focus`, `detail_focus` and `show_action` slots.
   A cardigan must frame the upper body, whereas trousers frame the lower body. Keep product
   features, voice direction, reference roles and scene constraints in authored masters.
5. Review the structure, set `reviewed: true`, then compile clips and the original audio mix.
   ASR uncertainty remains explicit in `analysis_status`; review it before production approval.
6. Test a representative product, review frames and clips, then publish a template version.
   Do not market an untested category as supported. The supplied sample is provisional.

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

Set `COMFLY_API_KEY` and `APIMART_API_KEY` in the process environment using a secure local
credential mechanism. Do not put keys in manifests, prompt files, CLI arguments, Git or logs.

```sh
# Paid: only after the user has authorized the planned image scope.
node bin/hypit.mjs ecommerce frames new-run --submit
node bin/hypit.mjs ecommerce review new-run
# Only after the human actually approves these exact images and dialogue:
node bin/hypit.mjs ecommerce approve new-run "actual user approval evidence"
node bin/hypit.mjs ecommerce videos new-run --submit
```

Frames run in dependency order: master scene first, then derived views referencing it.
Approval binds the full plan, input images and actual frame bytes. Editing a file invalidates
approval. Changing a generated parent invalidates descendant input receipts instead of silently
reusing stale children. To regenerate, create a separate attempt directory; retain earlier receipts.

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
    {"id": "s1", "start": 0, "dialogue_complete": true}
  ],
  "music": {"path": "music/instrumental.wav", "reviewed_music_only": true, "gain": 0.15}
}
```

List every shot in plan order. `start` is a trim offset into the generated clip. Duration
comes from the plan. `music` is optional; the original mixed dialogue track is never reused as
music automatically. Separate and listen to any extracted music before marking it reviewed.

```sh
node bin/hypit.mjs ecommerce assemble new-run edit.json
node --test test/ecommerce.test.mjs
```

FFmpeg must be on PATH, or set `HYPIT_ECOMMERCE_FFMPEG` to the executable. Assembly encodes to
720×1280, 30 fps and AAC, then joins the normalized clips. Cropping/color changes are not
advertised as a guarantee against platform similarity detection.

## Contracts and remaining work

Comfly multipart: `POST https://ai.comfly.org/v1/images/edits?async=true`, repeated `image`
parts; status `GET /v1/images/tasks/{id}`. APIMart image upload goes directly to the selected
provider, then `POST /v1/videos/generations`; status `GET /v1/tasks/{id}`. Keys are never sent
to output CDN URLs. Output bytes must identify as PNG/MP4. Unknown statuses and success without
outputs fail explicitly. Submission is never automatically retried.

Sources: [Comfly multipart](https://gpt-best.apifox.cn/api-420646219),
[Comfly task results](https://gpt-best.apifox.cn/api-356258956),
[APIMart Grok](https://docs.apimart.ai/en/api-reference/videos/grok-imagine/generation).

Still required for a production release: native Runtime integration, safe per-shot retry UX,
full batch execution and reporting, automatic analysis with reviewed schemas, validated multi-category
fixtures, independently reviewed audio separation, robust output codec inspection and full
distribution regression tests. Current tests are targeted contract/recovery tests, not proof of
generated visual quality or provider pricing.
