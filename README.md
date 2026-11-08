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
apps/web                 React + HeroUI v3 shell, React Three Fiber renderer
```

- **The engine never knows about screens.** It turns a recipe into steps; each step is a set of flat paper faces plus rigid motions (rotate these faces about this crease, by this much). The renderer just asks "where is every face at 37% of step 4?"
- **Rendering is automatic.** Fold lines, arrows, the glow on the paper that moves next, camera framing, the drag path under your finger and the hangar thumbnail are all derived from the recipe. There is no artwork or animation to make per plane.
- **The mobile port reuses the engine as-is.** Only the renderer (`@react-three/native`) and the shell (HeroUI Native) change.

## Adding a plane

1. Create `planes/<id>.plane.json`. Add `"$schema": "../packages/crease/plane.schema.json"` at the top and your editor will autocomplete and check it.
2. Run `npm run dev` and open the hangar. Your plane appears automatically. If a fold can't be solved, its card says which step and why, and **See the steps that work** shows every step up to the break.
3. Check the drawings on the plane's **all steps** page (`#/plane/<id>/steps`): every step drawn from the recipe, with fold lines and arrows.
4. Run `npm test`. CI runs the same checks on every push and only deploys if every plane folds.

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

See [`planes/classic-dart.plane.json`](planes/classic-dart.plane.json) for a complete plane.

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

Options on a fold:

- `"id"` names the crease, so later steps can use `crease:<id>`.
- `"layers": "top"` folds only the uppermost flap (for example, one wing). The default, `"all"`, folds every layer on the moving side.
- `"unfold": true` folds, presses a crease, and opens it flat again.

Other steps:

- `"flip": true` turns the model over left-to-right. `{ "axis": "short" }` turns it top-to-bottom.
- `"pose": { "type": "flight", "spine": "crease:wing-2", "keel": "crease:center", "wings": ["wing-1", "wing-2"], "dihedral": 6 }` stands the plane up, opens the wings and floats it.

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
