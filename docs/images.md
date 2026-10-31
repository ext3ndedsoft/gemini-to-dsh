# Images

The bridge can answer with a picture instead of prose. This page covers how a
sentence becomes a file, and how to point that at a different service later without
touching anything else.

## What the client sees

A turn that draws returns text and a path:

```
Generated an image.

![generated image](C:/Users/you/.dsh/images/img-2026-10-31T01-25-07-6e7e36.jpg)
```

That is deliberate. A chat client cannot render the base64 the model actually
returns, and a turn that "succeeded" with no text is indistinguishable from a broken
one — so the bridge writes the bytes to disk and hands back markdown pointing at an
absolute path. DSH renders it; any other client shows a clickable path, which is
still better than nothing.

Non-streaming callers also get a machine-readable `images` array:

```json
{ "images": [{ "path": "C:/Users/you/.dsh/images/img-....jpg", "type": "image" }] }
```

## Why words work on every model

`lib/images.js` checks the last user message before the normal path runs:

- the request already names an image model (`*-image`, or `AG_IMAGE_MODEL`) → route `direct`;
- otherwise, if the sentence asks for a picture → route `auto`, and the request is
  re-pointed at the image model;
- otherwise → `null`, and nothing changes.

That is why "нарисуй кота" works while the profile says `gemini-3.8-flash`. The
matcher is a verb plus a noun, in Russian and English, and it is deliberately shy:

| Routed | Not routed |
| --- | --- |
| «нарисуй кота», «сгенерируй изображение заката» | «что на этой картинке», «опиши фото» |
| `draw a fox`, `generate an image of a lighthouse` | `describe the photo`, `what is in this image` |
| «перерисуй это в акварель» (with an attachment) | «напиши сортировку», `make a tool that lists files` |

Reading wins when both are present: an attached image plus a reading verb stays on
the text model, which already understands pictures. `AG_IMAGE_AUTO=0` removes the
whole `auto` branch — then only naming the model draws.

## The transport

The image model is called over the same Cloud Code endpoint as everything else, in
streaming mode, with tools stripped (they make it return nothing). Two quirks are
handled in code and are worth knowing before you debug anything:

- the finished picture is sent more than once, re-encoded, so bytes differ while the
  picture does not. Byte hashes miss that; images whose decoded size is within 2% of
  each other are treated as one, and the first is kept.
- a prompt that produced only a picture leaves `parts` empty. Without the fallback
  sentence, the turn would close with `stop` and no content.

Typical latency is 10–25 seconds for one 1024×1024-ish JPEG. That is the model, not
the route; it draws and encodes before the first byte arrives, so there is nothing
to stream until it is done.

## Swapping the provider

Everything downstream of `generate()` only sees `{ files, text }`:

```js
export async function generate(body, { signal, model } = {}) {
  // ... call whatever service ...
  return { files: ['/abs/path.png'], text: 'optional prose from the model' };
}
```

So an API-key provider is a replacement of that one function in `lib/images.js` —
the routing, the file layout, the markdown answer and the OpenAI response shape stay
exactly as they are. Three realistic shapes:

**Gemini API with a key.** Same request shape, different host and auth:

```js
const res = await fetch(
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal,
  }
);
```

then read `candidates[0].content.parts[].inlineData` — identical to what the code
already parses, so only the URL and headers change.

**OpenAI-style images endpoint.** `POST /v1/images/generations` returns `b64_json`
or a URL; base64 goes straight into `saveImage(mime, data)`, a URL needs one `fetch`
and then the same call.

**Anything local** (ComfyUI, Automatic1111, a diffusers server): they all return
either base64 or a path — both end at `saveImage`.

Keep three things when you swap: write the file before returning, keep the absolute
path (clients resolve relative links against the repository, not the user's disk),
and return `text` as `''` rather than `undefined` when the service has nothing to say.

## Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `AG_IMAGE_MODEL` | `gemini-3.1-flash-image` | Model id passed to the upstream |
| `AG_IMAGE_DIR` | `~/.dsh/images` | Created on first write, recursively |
| `AG_IMAGE_AUTO` | `1` | `0` disables routing by words |

`AG_IMAGE_MODEL` also teaches `isImageModel`: a request that names it goes straight
to drawing, whatever the intent check would have said.

## Trying it without a chat client

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'authorization: Bearer local-bridge' \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"draw a paper boat in a puddle"}]}'
```

The response carries the path; `ls ~/.dsh/images` shows the file. The unit suite
(`npm run test:images`) covers the matcher and the file handling without network.