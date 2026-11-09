# Paper Hangar

Learn to fold paper airplanes step by step, in 3D. Grab the paper and drag it along the orange arrow to fold it, or let **Show me** do it.

**Live:** https://ademiroliveira.github.io/paper-hangar/

This is the web version, built to prove the fold engine and the plane format before the iPhone and iPad apps.

## How it fits together

```
planes/*.plane.json      recipes: one file per plane, written like instructions
        │
packages/crease          the fold engine (TypeScript, no UI): recipe → 3D fold steps
        │
        ├── apps/web               React + HeroUI v3 shell, React Three Fiber renderer
        └── packages/crease-cli    `npx crease`: check, inspect and draw recipes
```

- **The engine never knows about screens.** It turns a recipe into steps; each step is a set of flat paper faces plus rigid motions (rotate these faces about this crease, by this much). The renderer just asks "where is every face at 37% of step 4?"
- **Rendering is automatic.** Fold lines, arrows, the glow on the paper that moves next, camera framing, the drag path under your finger and the hangar thumbnail are all derived from the recipe. There is no artwork or animation to make per plane.
- **The mobile port reuses the engine as-is.** Only the renderer (`@react-three/native`) and the shell (HeroUI Native) change.

## Adding a plane

1. Create `planes/<id>.plane.json`. Add `"$schema": "../packages/crease/plane.schema.json"` at the top and your editor will autocomplete and check it.
2. Run `npx crease check planes/<id>.plane.json`. It folds every step and lists every problem with its step number and a plain reason. `npx crease refs` shows what the next step can point at.
3. Run `npm run dev` and open the hangar. Your plane appears automatically. Check the drawings on its **all steps** page (`#/plane/<id>/steps`). If a fold can't be solved, the card says which step and why, and **See the steps that work** shows every step up to the break.
4. Run `npx crease previews` to draw `planes/previews/<id>.svg`, the one-page view reviewers see in a pull request.
5. Run `npm test`. CI runs the same checks on every push and only deploys if every plane folds and every preview is current.

To have Claude draft a plane for you, ask Claude Code in this repo to "draft a recipe for the Nakamura lock". The [`draft-plane` skill](.claude/skills/draft-plane/SKILL.md) writes the recipe, checks it with the commands below until it folds and matches the real plane, and opens a pull request.

### The `crease` command

| Command | What it does |
| --- | --- |
| `npx crease check <file…>` | Folds every step and runs the physical checks. Lists every problem with its step, kind and reason |
| `npx crease validate <file…>` | Checks the recipe's shape only (JSON, schema, ids, references), without folding |
| `npx crease refs <file> [--step n]` | Everything step n can point at, and where it is now. Defaults to the next step to write |
| `npx crease describe <file> [--step n]` | The paper after step n: size, layers, which side is up, corners, creases. For a finished plane: wingspan, length, body depth, height |
| `npx crease render <file> [--step n] [--png]` | Draws each step, the result of each step, a sheet of all steps and three views of the finished plane into `.crease/renders/<id>/` |
| `npx crease compare <reference> <file>` | Measures two finished planes side by side and passes when they're within 10% |
| `npx crease previews [--check]` | Redraws `planes/previews/` for every recipe, or checks they're current |

Add `--json` to any command for output a script or an agent can read. Positions are in cm on the table: x to the right, y away from you, the same axes as the flat sheet before anything moves.

### Physical checks (every plane, every step)

The engine refuses anything a real sheet of paper couldn't do. These checks run every time a recipe compiles, so a broken plane never reaches the screen: the hangar shows the problem and CI won't deploy.

| Check | Catches |
| --- | --- |
| No tearing | a fold that moves one side of a seam without the other |
| No paper through paper | a layer that stays put while paper underneath it lifts |
| No paper through the table | any part of the motion that dips below the mat (checked through the whole fold, not just the end) |
| Flat folds end flat | layers left tilted after a fold |
| The sheet stays whole | paper lost, gained or split into slivers |
| Unambiguous references | a `crease:` that now lies in more than one place |

The engine is also fuzz-tested: 1,500 random recipes (about 4,600 steps) must each either fold and pass every check, or be rejected with a step number and a plain reason. A failed physical check on a random recipe fails the build as an engine bug.

### The recipe

A recipe lists steps. Each step does exactly one thing: `fold`, `folds` (several at once), `flip`, or `pose`.

```json
{
  "$schema": "../packages/crease/plane.schema.json",
  "id": "classic-dart",
  "name": "Classic dart",
  "summary": "The one everyone learns first.",
  "difficulty": 1,
  "paper": "A4",
  "steps": [
    {
      "title": "Crease the middle",
      "text": "Fold in half the long way, then open it again.",
      "fold": { "id": "center", "bring": "edge:left", "to": "edge:right", "unfold": true }
    },
    {
      "title": "Fold the top corners in",
      "folds": [
        { "bring": "corner:top-left", "to": "crease:center", "through": "mid:edge:top" },
        { "bring": "corner:top-right", "to": "crease:center", "through": "mid:edge:top" }
      ]
    },
    { "title": "Turn it over", "flip": true }
  ]
}
```

See [`planes/classic-dart.plane.json`](planes/classic-dart.plane.json) and [`planes/nakamura-lock.plane.json`](planes/nakamura-lock.plane.json) for complete planes.

Three optional fields record where a recipe came from. The steps page shows the first two:

- `"author"`: who designed the plane, when known.
- `"sources"`: `[{ "title": …, "url": …, "note": "what was taken from it" }]`, the pages, books or videos the folds were checked against.
- `"assumptions"`: every guess made while writing it, like reading "about an inch" as 2.5 cm on A4. Reviewers check these.

### Pointing at the paper

The sheet lies in portrait. "Top" is the far edge, where the nose usually ends up.

| Reference | Means |
| --- | --- |
| `corner:top-left`, `corner:bottom-right`, … | a corner of the sheet |
| `edge:top`, `edge:left`, … | an edge of the sheet |
| `crease:<id>` | a crease made by an earlier fold; give that fold an `"id"` |
| `mid:edge:top`, `mid:crease:<id>` | the midpoint of an edge or crease |
| `at:0.5,1` | a point as fractions of the sheet (x across, y up) |

References follow the paper as it folds: `corner:top-left` means that corner wherever it is now.

### Kinds of fold

| You write | The engine finds |
| --- | --- |
| `bring` a point `to` a point | the fold that puts one on the other |
| `bring` a line `to` a line | the fold that lays one line on the other (or halfway between, if they're parallel) |
| `bring` a point `to` a line `through` a point | the fold through that point that lands the first point on the line |
| `along` a line, `move` a point | a fold along an existing line; the side with the point moves |
| `parallel` to a line, `distance` in cm, `move` a point | a fold parallel to that line ("fold the wing down 2.5 cm from the belly") |

Options on a fold:

- `"id"` names the crease, so later steps can use `crease:<id>`.
- `"layers": "top"` folds only the uppermost flap (for example, one wing). The default, `"all"`, folds every layer on the moving side.
- `"unfold": true` folds, presses a crease, and opens it flat again.

Other steps:

- `"flip": true` turns the model over left-to-right. `{ "axis": "short" }` turns it top-to-bottom.
- `"pose": { "type": "flight", "spine": "crease:wing-2", "keel": "crease:center", "wings": ["wing-1", "wing-2"], "dihedral": 6 }` stands the plane up, opens the wings and floats it. When the wings hinge parallel to the keel, add `"nose"`: a point at the front of the plane.
- A mountain fold (away from you) is written as `flip`, then the fold, the way the Nakamura lock folds in half with its folds outside.

Valley folds (toward you) and flips cover most beginner planes.

## Development

Needs Node 22 or newer with npm 11 (`npx npm@11 install` works if your npm is older).

```sh
npm install
npm run dev        # the web app, with every plane in planes/
npm test           # engine tests + every recipe must compile
npm run typecheck
npm run build      # static site in apps/web/dist
```

Pushing to `main` runs the tests and deploys to GitHub Pages (`.github/workflows/deploy.yml`).

## Roadmap

- Mountain folds, inside-reverse folds (tail fins), squash folds and tucks
- An authoring mode: tap points on the paper to define the next fold, preview, export the recipe
- Export each step as a FOLD frame, so models open in other origami tools
- iPhone and iPad apps: Expo + `@react-three/native` + HeroUI Native, reusing `packages/crease`
