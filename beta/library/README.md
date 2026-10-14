# Scene library

Reusable scenes, authored by Beta in this repository. One folder is one
scene. The manifest that the editor's gallery and the `beta-slides` skill
read is generated from these folders by `scripts/build-beta-library.mjs` and
uploaded to the deck store. It is never committed and never published to a
public origin.

## A scene folder

```
beta/library/<id>/
  scene.json    name, version, description, kind, steps, props, presets
  index.html    the scene's page (a runtime scene)
  still.svg     what the slide shows where no frame runs
```

- `<id>` is lower case, digits and hyphens, starting with a letter.
- `version` is a whole number. Raise it whenever the scene changes; a deck
  keeps the copy it was given, and the number says which.
- `index.html` follows the scene contract in the `beta-slides` skill: it
  listens for `bento:init` before it trusts any state, says `bento:ready`, and
  draws its defaults on its own. At most 256 KB.
- `still.svg` is a picture: no script, no `foreignObject`, no handlers, no
  links out. At most 64 KB.
- `props` are settings, with the shell's three kinds: `text`, `number`,
  `color`. A setting the shell has no control for rides on `text` or `number`
  with a `format` hint: `bool`, `latlon`, `select:a|b|c`,
  `range:min:max:step`.
- `presets` name sets of values. There is at least one; the gallery opens on
  the first. A preset lists only what differs from the defaults.

A web scene (`"kind": "web"`) has a `url` instead of `index.html`. The url is
`https` and its host is one of `WEB_HOSTS` in `scripts/lib/beta-library.mjs`.

## The manifest

```json
{ "format": "beta/library", "v": 1, "scenes": [
  { "id": "counter", "version": 1, "name": "Counter", "description": "…",
    "kind": "runtime", "steps": 0,
    "props": [{ "key": "to", "label": "Count to", "kind": "number", "default": 1250000 }],
    "presets": [{ "name": "Whole number", "values": {} }],
    "html": "<!doctype html>…", "still": "<svg …>", "stillType": "image/svg+xml" }
] }
```

`html` and `still` are raw text, the shape the splice tool's `applyScene`
takes. A web scene carries `url` and `view` (its still) and no `html`. Scenes
are sorted by id.

## Commands

```sh
node scripts/build-beta-library.mjs --check    # validate; runs in CI
node scripts/build-beta-library.mjs            # write beta/library/.out/library.json
node scripts/build-beta-library.mjs --upload   # and PUT it to the store (service token)
```

The store serves the uploaded manifest at `/library/library.json` to a
signed-in person, at `/api/harness/library.json` to the service token and at
`/api/publish/library.json` to an agent's grant.

## The two scenes here

- `counter`: one number that counts up, with a label.
- `map`: one place on a coordinate grid, a wide view and a step closer. It
  draws meridians, parallels and a marker. It has no basemap.
