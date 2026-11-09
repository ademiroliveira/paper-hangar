/** A point in flat sheet coordinates, in centimetres. (0,0) is the bottom-left corner, y runs toward the nose. */
export type Vec2 = [number, number];

export type PaperSpec = 'A4' | 'Letter' | { width: number; height: number };

/**
 * One fold. Describe it the way you'd say it out loud:
 *  - { bring: "corner:top-left", to: "crease:center", through: "mid:edge:top" }
 *  - { bring: "edge:left", to: "edge:right" }
 *  - { along: "crease:center", move: "corner:bottom-left" }
 *  - { parallel: "crease:center", distance: 2.5, move: "corner:bottom-left" }
 */
export interface FoldSpec {
  /** Name for the crease this fold makes, so later steps can point at it as `crease:<id>`. */
  id?: string;
  /** The point or line that moves. */
  bring?: string;
  /** Where it lands: a point or a line. */
  to?: string;
  /** A point the fold must pass through (needed when bringing a point onto a line). */
  through?: string;
  /** Fold along an existing line instead of solving for one. */
  along?: string;
  /** With `along` or `parallel`: a point on the side that moves. */
  move?: string;
  /** Fold along a line parallel to this one, `distance` cm away on the side of `move`. */
  parallel?: string;
  /** With `parallel`: how far from that line, in cm. */
  distance?: number;
  /** `top` folds only the uppermost flap; `all` (default) folds every layer on the moving side. */
  layers?: 'all' | 'top';
  /** Fold, press a crease, then open it flat again. */
  unfold?: boolean;
}

export interface FlipSpec {
  /** `long` (default) turns the model over left-to-right; `short` turns it over top-to-bottom. */
  axis?: 'long' | 'short';
}

export interface PoseSpec {
  type: 'flight';
  /** The line the wings hinge on, usually the wing crease. */
  spine: string;
  /** The bottom fold of the body. */
  keel: string;
  /** Ids of the folds that made the wings. */
  wings: string[];
  /** Upward tilt of the wings in degrees. Default 6. */
  dihedral?: number;
  /** A point at the front of the plane. Needed when the spine runs parallel to the keel; otherwise the nose is where they meet. */
  nose?: string;
}

export interface StepSpec {
  title: string;
  text?: string;
  fold?: FoldSpec;
  /** Several folds that happen at the same time (for example, both corners). */
  folds?: FoldSpec[];
  flip?: boolean | FlipSpec;
  pose?: PoseSpec;
}

export interface SourceSpec {
  title: string;
  url?: string;
  /** What was taken from it, e.g. "wing position". */
  note?: string;
}

export interface PlaneSpec {
  $schema?: string;
  id: string;
  name: string;
  summary?: string;
  difficulty?: 1 | 2 | 3;
  paper: PaperSpec;
  /** Who designed the plane, when known. */
  author?: string;
  /** Where the folding method came from: pages, books, videos or your own notes. */
  sources?: SourceSpec[];
  /** Guesses made while writing the recipe, like reading "about an inch" as 2.5 cm on A4. Reviewers check these. */
  assumptions?: string[];
  steps: StepSpec[];
  done?: { title: string; text: string };
}
