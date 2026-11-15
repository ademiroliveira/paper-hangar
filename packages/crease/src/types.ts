/** A point in flat sheet coordinates, in centimetres. (0,0) is the bottom-left corner, y runs toward the nose. */
export type Vec2 = [number, number];

export type PaperSpec = 'A4' | 'Letter' | { width: number; height: number };

/**
 * One fold. Describe it the way you'd say it out loud:
 *  - { bring: "corner:top-left", to: "crease:center", through: "mid:edge:top" }
 *  - { bring: "edge:left", to: "edge:right" }
 *  - { along: "crease:center", move: "corner:bottom-left" }
 *  - { parallel: "crease:center", distance: 2.5, move: "corner:bottom-left" }
 *  - { line: ["at:0.5,0.8", "at:0.6,0"], move: "corner:bottom-right" }
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
  /** Fold on the straight line through these two points (with `move`): "fold from the nose tip to 2.5 cm from the keel". */
  line?: [string, string];
  /** `top` folds only the uppermost flap; `all` (default) folds every layer on the moving side. */
  layers?: 'all' | 'top';
  /**
   * Fold only the flap that holds this point of the paper (and anything lying on top of it).
   * Use it when two flaps are equally high and `layers: "top"` can't tell which one you mean.
   */
  flap?: string;
  /** Fold, press a crease, then open it flat again. */
  unfold?: boolean;
  /**
   * `inside`: an inside reverse fold. The paper on the moving side is a pocket (layers joined along
   * a fold); its point turns inside out and ends up between the pocket's two sides.
   */
  reverse?: 'inside';
  /**
   * A swivel fold: the `flap` folds over this fold's line, but it is joined to the layer under it along
   * a fold (a pocket), so its corner swivels back down around the point where the two lines meet and the
   * layer under it folds its corner in. Found automatically: the line where the flap is joined to that layer.
   */
  swivel?: boolean;
}

/** Cut through every layer along a straight line, from one point to the other. */
export interface CutSpec {
  /** One or more slits. Each runs from the first point to the second. */
  slits: [string, string][];
  /**
   * With exactly two slits: name the tab between them (an elevator, say). The tab hinges on the line
   * joining the slits' ends, which becomes `crease:<tab>`, and the flight pose can bend it with `tabs`.
   */
  tab?: string;
}

export interface TabBend {
  /** The tab's name, from a cut step. */
  id: string;
  /** Degrees to bend it. Positive bends the tab up (toward the top of the plane in flight). Default 20. */
  angle?: number;
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
  /** Ids of folds that made wingtip fins. They open to stand at `finAngle` to their wing. */
  fins?: string[];
  /** How far the fins open from lying flat, in degrees. Default 90 (upright). */
  finAngle?: number;
  /** Tabs cut earlier (elevators) to bend, each by its own angle. */
  tabs?: TabBend[];
}

export interface StepSpec {
  title: string;
  text?: string;
  fold?: FoldSpec;
  /** Several folds that happen at the same time (for example, both corners). */
  folds?: FoldSpec[];
  flip?: boolean | FlipSpec;
  cut?: CutSpec;
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
