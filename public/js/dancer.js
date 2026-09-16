// The dancer.
//
// The body is a jointed rig: hips, knees, ankles, spine, shoulders, elbows, neck.
// The feet are placed in the room and the knees are worked out from where the hips
// are (inverse kinematics), so weight transfer and squatting bend the knees by
// themselves.
//
// Movement has four layers stacked on top of each other:
//   1. a breath that never stops, so the figure is alive before anything happens
//   2. a groove timed to the phrase being played, not to a fixed tempo
//   3. a move, which snaps to an accent and then settles
//   4. steps, jumps, spins, elbow lag and the ponytail, each on its own clock
//
// Every move is handed the span it has before the next one, so the same move is
// quick in a fast phrase and drawn out in a slow one. Nothing is a static pose:
// every number below is eased toward, never jumped to.

const SVG = "http://www.w3.org/2000/svg";
const DEG = 180 / Math.PI;

// ---- Proportions. The floor is at y = 400. ----
const FLOOR = 400;
const FOOT_Y = 376;           // ankle height (the sneaker sole reaches the floor)
const HIP_Y = 228;            // pelvis when standing tall
const HIP_W = 16;             // half the distance between hip joints
const THIGH = 80, SHIN = 76;
const SHOULDER_X = 30, SHOULDER_Y = -84;  // relative to the pelvis
const UPPER_ARM = 52;
const STANCE = 19;            // half the distance between the feet when standing
const TRAVEL_LIMIT = 132;     // how far sideways the dancer may wander
// How much of the sideways knee bend to keep when standing. Seen from the front a
// bent knee mostly travels forward, so solving it flat makes the dancer
// bow-legged — but in a deep squat the knees really do open out, so this rises
// with how low the hips are.
const KNEE_OUT_TALL = 0.62;
const KNEE_OUT_LOW = 1;

// Relaxed standing: knees a little soft, arms hanging with a slight bend.
const REST = {
  weight: 0, lean: 0, twist: 0, crouch: 0.09, rise: 0, sink: 0,
  armLS: 9, armLE: 15, armRS: 9, armRE: 15, headTilt: 0, headNod: 0, shrug: 0,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  parent?.appendChild(node);
  return node;
}

// Where the beat sits inside the body. 0 is standing tall, 1 is fully compressed.
// The curve drops hard on the beat, rebounds, hovers, then lifts just before the
// next one: that lift is the anticipation you feel before a dancer lands a step.
function grooveCurve(p) {
  if (p < 0.16) return lerp(-0.14, 1, 1 - (1 - p / 0.16) ** 2);
  if (p < 0.5) return lerp(1, 0.15, (p - 0.16) / 0.34);
  if (p < 0.84) return lerp(0.15, 0.3, (p - 0.5) / 0.34);
  return lerp(0.3, -0.14, (p - 0.84) / 0.16);
}

// Two bones, one target: find the knee. Returns angles in radians.
function solveLeg(hipX, hipY, footX, footY, kneeSign, kneeOut) {
  const dx = footX - hipX, dy = footY - hipY;
  const d = clamp(Math.hypot(dx, dy), Math.abs(THIGH - SHIN) + 1, THIGH + SHIN - 1);
  const base = Math.atan2(dy, dx);
  const alpha = Math.acos(clamp((THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d), -1, 1)) * kneeOut;
  const thigh = base + kneeSign * alpha;
  const kneeX = hipX + Math.cos(thigh) * THIGH;
  const kneeY = hipY + Math.sin(thigh) * THIGH;
  const shinLen = Math.hypot(footX - kneeX, footY - kneeY);
  return {
    thigh, kneeX, kneeY,
    shin: Math.atan2(footY - kneeY, footX - kneeX),
    shinScale: clamp(shinLen / SHIN, 0.84, 1.2),
  };
}

export class Dancer {
  constructor(container) {
    this.pony = { angle: 0, vel: 0, node: null };
    this.build(container);

    this.tempo = 520;            // the phrase's typical gap, as last seen
    this.lastBeatAt = -1e9;
    this.expected = null;        // when the next move in the phrase is due
    this.beatParity = 0;
    this.energy = 0.25;          // fades away when nothing is being played
    this.still = false;          // set by hold and drop, cleared by the next move
    this.current = null;
    this.spinBias = 1;

    this.feet = {
      L: { x: -STANCE, y: FOOT_Y, rot: 0, lift: 0, anim: null },
      R: { x: STANCE, y: FOOT_Y, rot: 0, lift: 0, anim: null },
    };
    this.cur = { ...REST };
    this.target = { ...REST };
    this.settle = null;
    this.accentUntil = 0;
    this.stiffness = 9;
    this.queue = [];             // steps waiting their turn
    this.jump = null;
    this.spin = null;
    this.bounce = null;
    this.landing = null;
    this.facing = 1;
    this.prevHipY = HIP_Y;
    this.breath = 0;
    this.foreLag = { L: 0, R: 0 };   // the forearm catching up with the shoulder
    this.prevArm = { L: REST.armLS, R: REST.armRS };
    // Someone who asked for less motion still gets the moves, just a calmer groove.
    this.calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0.45 : 1;
  }

  // ---------- The body ----------

  build(container) {
    const svg = el("svg", { viewBox: "-210 20 420 400", class: "dancer-svg", "aria-hidden": "true" }, container);
    el("line", { x1: -208, x2: 208, y1: FLOOR, y2: FLOOR, class: "floor" }, svg);
    this.shadow = el("ellipse", { cx: 0, cy: FLOOR + 3, rx: 66, ry: 6, class: "shadow" }, svg);

    this.figure = el("g", {}, svg);

    // A leg tapers from thigh to ankle, so the weight reads as sitting in the hips.
    const leg = () => {
      const g = {};
      g.thigh = el("g", {}, this.figure);
      el("path", { d: "M-19 -14 C-22 18,-20 52,-16 90 L16 90 C20 52,22 18,19 -14 Z", class: "pants" }, g.thigh);
      g.shin = el("g", {}, this.figure);
      el("path", { d: "M-15 -10 C-17 22,-14 48,-12 80 L13 80 C15 48,17 22,15 -10 Z", class: "pants" }, g.shin);
      el("path", { d: "M-12 64 C-5 69,6 69,13 64", class: "seam" }, g.shin);   // the turn-up at the ankle
      g.foot = el("g", {}, this.figure);
      // A sneaker: rounded heel, a toe that lifts a little, a sole under both.
      el("path", {
        d: "M-13 -16 C-18 -8,-19 6,-16 12 C-8 16,10 16,24 14 C33 13,36 3,29 -1 L8 -14 C2 -17,-8 -18,-13 -16 Z",
        class: "shoe",
      }, g.foot);
      el("path", { d: "M-16 10 L30 6", class: "sole" }, g.foot);
      el("path", { d: "M-5 -4 C4 2,13 4,23 2", class: "seam" }, g.foot);
      return g;
    };
    this.legL = leg();
    this.legR = leg();

    // Everything above the hips hangs off the torso, so it leans as one piece.
    this.torso = el("g", {}, this.figure);
    this.shoulders = el("g", {}, this.torso);   // chest, arms and head turn together

    // The bunched hood, behind the neck.
    el("path", { d: "M-27 -84 C-24 -104,24 -104,27 -84 C18 -93,-18 -93,-27 -84 Z", class: "hood" }, this.shoulders);
    // The neck, drawn before the hoodie so the collar sits in front of its base.
    el("path", { d: "M-9 -78 L9 -78 L8 -104 L-8 -104 Z", class: "skin" }, this.shoulders);

    // An arm: upper arm, forearm, and a hand, each narrower than the one above it.
    const arm = (parent) => {
      const g = {};
      g.upper = el("g", {}, parent);
      el("path", { d: "M-11 -11 C-13 8,-11 30,-9 54 L9 54 C11 30,13 8,11 -11 Z", class: "sleeve" }, g.upper);
      g.fore = el("g", {}, g.upper);
      el("path", { d: "M-9 -7 C-11 10,-9 26,-7 40 L7 40 C9 26,11 10,9 -7 Z", class: "sleeve" }, g.fore);
      el("path", { d: "M-7 34 C-2 37,2 37,7 34", class: "seam" }, g.fore);   // the cuff
      // A closed mitten with a thumb along its outer edge, so no hole opens up.
      el("path", {
        d: "M-9 38 C-15 42,-17 50,-13 55 C-12 63,-3 68,4 65 C10 62,12 55,11 48 C11 44,10 40,9 37 Z",
        class: "skin",
      }, g.fore);
      return g;
    };
    this.armL = arm(this.shoulders);   // drawn behind the body

    // The hoodie: narrow across the shoulders so the arms read outside it, drawn
    // in at the waist, hem flaring again.
    el("path", {
      d: "M-30 34 C-29 18,-27 4,-26 -6 C-25 -28,-25 -48,-24 -58 C-22 -78,-13 -90,0 -90 C13 -90,22 -78,24 -58 C25 -48,25 -28,26 -6 C27 4,29 18,30 34 C12 39,-12 39,-30 34 Z",
      class: "hoodie",
    }, this.shoulders);
    el("path", { d: "M-22 -10 C-10 -1,10 -1,22 -10", class: "seam" }, this.shoulders);   // chest
    el("path", { d: "M-23 13 C-12 21,12 21,23 13", class: "seam" }, this.shoulders);     // pocket
    el("path", { d: "M-7 -80 L-6 -52 M7 -80 L6 -52", class: "string" }, this.shoulders);

    // The head sits clear of the collar, so there is a neck to turn on.
    this.head = el("g", {}, this.shoulders);
    // The ponytail comes out of the back of the head, under the cap.
    this.pony.node = el("g", { "transform-origin": "-20 -34" }, this.head);
    el("path", {
      d: "M-19 -40 C-38 -39,-53 -22,-49 -2 C-47 11,-36 15,-32 8 C-39 -3,-33 -22,-22 -31 Z",
      class: "hair",
    }, this.pony.node);
    // The skull: rounder at the back, tapering through a nose to a chin.
    el("path", {
      d: "M-25 -34 C-26 -57,24 -61,26 -37 C26 -31,27 -26,28.5 -22 C29.5 -20,27.5 -19,25 -19 C24 -12,19 -5,11 -2 C3 1,-6 0,-13 -6 C-20 -12,-25 -22,-25 -34 Z",
      class: "skin",
    }, this.head);
    // A cap worn backwards: the crown caps the skull, the brim points behind.
    el("path", { d: "M-25 -36 C-27 -62,26 -65,27 -38 C10 -30,-8 -30,-25 -36 Z", class: "cap" }, this.head);
    el("path", { d: "M-25 -38 C-43 -41,-53 -31,-49 -23 C-38 -27,-30 -33,-25 -38 Z", class: "cap" }, this.head);
    el("circle", { cx: 8, cy: -26, r: 3, class: "face" }, this.head);
    el("circle", { cx: 19, cy: -25, r: 2.6, class: "face" }, this.head);
    el("path", { d: "M12 -11 C16 -9,20 -11,22 -14", class: "mouth" }, this.head);

    this.armR = arm(this.shoulders);   // drawn in front of the body
  }

  // ---------- Moves ----------

  // `span` is how long this move has before the next one is due, which is where
  // the phrase's own rhythm gets into the body. `who` is "you" while a person is
  // playing and "dancer" while the dancer is taking its turn.
  perform(move, who, now, span = 520) {
    this.tempo = clamp(span, 150, 2400);
    this.lastBeatAt = now;
    this.beatParity ^= 1;
    this.still = false;
    this.current = { move, who };
    this.figure.classList.toggle("is-dancer", who === "dancer");

    const s = this.tempo;
    this.accentUntil = now + clamp(s * 0.18, 60, 150);
    this.stiffness = 32;

    const fns = {
      pulse: () => this.doPulse(now, s),
      step_left: () => this.doStep(-1, now, s),
      step_right: () => this.doStep(1, now, s),
      jump: () => this.doJump(now, s),
      drop: () => this.doDrop(now, s),
      spin: () => this.doSpin(now, s),
      bounce: () => this.doBounce(now, s),
      hold: () => this.doHold(now, s),
    };
    (fns[move] ?? fns.pulse)();
  }

  // When the next move in the phrase is due, so the body can lean toward it.
  expect(t) {
    this.expected = t;
  }

  // Back to standing, between turns.
  reset(now) {
    this.queue.length = 0;
    this.jump = this.spin = this.bounce = this.landing = null;
    this.still = false;
    this.expected = null;
    this.target = { ...REST };
    this.settle = null;
    this.stiffness = 6;
    this.lastBeatAt = -1e9;
    this.current = null;
    this.figure.classList.remove("is-dancer");
    const mid = (this.feet.L.x + this.feet.R.x) / 2;
    this.stepFoot("L", mid - STANCE, now, 340, 4);
    this.stepFoot("R", mid + STANCE, now, 340, 4);
    this.feet.L.rot = this.feet.R.rot = 0;
  }

  // A beat marked on the spot: the weight drops into the floor and the chest
  // answers it. Nothing travels, which is what makes it read as punctuation.
  doPulse(now, s) {
    const dir = this.beatParity ? 1 : -1;
    this.target = {
      ...REST, crouch: 0.58, weight: dir * 0.35, twist: -dir * 6, shrug: 8,
      armLS: 27, armLE: 46, armRS: 27, armRE: 46, headNod: 7,
    };
    this.settle = {
      ...REST, crouch: 0.2, weight: dir * 0.2, twist: -dir * 2,
      armLS: 14, armLE: 23, armRS: 14, armRE: 23,
    };
  }

  // A step travels: the leading foot goes out, the trailing one catches up, and
  // the weight arrives over the new foot.
  doStep(dir, now, s) {
    const lead = dir < 0 ? "L" : "R";
    const trail = dir < 0 ? "R" : "L";
    const travel = clamp(s * 0.14, 32, 84);
    const leadX = clamp(this.feet[lead].x + dir * travel, -TRAVEL_LIMIT, TRAVEL_LIMIT);
    const stepDur = clamp(s * 0.36, 120, 340);

    this.stepFoot(lead, leadX, now, stepDur, clamp(s * 0.035, 8, 20));
    // The trailing foot follows a fraction later, closing back to a stance.
    this.queue.push({
      at: now + stepDur * 0.55,
      run: (t) => this.stepFoot(trail, leadX - dir * STANCE * 2, t, stepDur * 1.1, clamp(s * 0.02, 5, 12)),
    });

    const swing = dir < 0 ? 1 : -1;
    this.target = {
      ...REST, crouch: 0.44, weight: dir, lean: dir * 7, twist: -dir * 6, shrug: 3,
      armLS: 36 + swing * 20, armLE: 34 - swing * 12,
      armRS: 36 - swing * 20, armRE: 34 + swing * 12,
      headTilt: dir * 5, headNod: 3,
    };
    this.settle = {
      ...REST, crouch: 0.26, weight: dir * 0.75, lean: dir * 3, twist: -dir * 2.5,
      armLS: 16 + swing * 8, armLE: 22, armRS: 16 - swing * 8, armRE: 22, headTilt: dir * 2,
    };
  }

  // A jump really leaves the floor: gather, push, tuck at the top, and absorb the
  // landing through the knees. The shadow shrinks away underneath.
  doJump(now, s) {
    const dur = clamp(s * 0.95, 340, 950);
    this.jump = { start: now, dur, height: clamp(s * 0.17, 38, 86) };
    // Feet come together in the air, the way they do when you actually jump.
    const mid = (this.feet.L.x + this.feet.R.x) / 2;
    this.stepFoot("L", mid - STANCE * 0.65, now + dur * 0.15, dur * 0.4, 0);
    this.stepFoot("R", mid + STANCE * 0.65, now + dur * 0.15, dur * 0.4, 0);
    this.target = {
      ...REST, crouch: 0, rise: 14, shrug: -8,
      armLS: 156, armLE: 8, armRS: 156, armRE: 8, headNod: -11,
    };
    this.settle = {
      ...REST, crouch: 0.32, armLS: 22, armLE: 32, armRS: 22, armRE: 32, headNod: 4,
    };
    this.accentUntil = now + dur * 0.78;   // stay extended until the landing
  }

  // Down into the floor: the hips travel a long way down, the knees open out,
  // the chest stays up. It stays there until the next move asks for something.
  doDrop(now, s) {
    const dur = clamp(s * 0.5, 180, 450);
    const mid = (this.feet.L.x + this.feet.R.x) / 2;
    const wide = STANCE + clamp(s * 0.03, 11, 24);
    this.stepFoot("L", mid - wide, now, dur, 4);
    this.stepFoot("R", mid + wide, now, dur, 4);
    this.feet.L.rot = 9;
    this.feet.R.rot = 9;
    this.target = {
      ...REST, sink: 74, crouch: 0.1, lean: 5, shrug: -4,
      armLS: 52, armLE: 78, armRS: 52, armRE: 78, headNod: 6,
    };
    this.settle = {
      ...REST, sink: 62, crouch: 0.1, lean: 4,
      armLS: 44, armLE: 72, armRS: 44, armRE: 72, headNod: 4,
    };
    this.still = true;   // the groove quiets right down while it is low
  }

  // All the way round on the spot, through the narrow side and out again facing
  // the same way. The arms pull in to spin, and the head whips.
  doSpin(now, s) {
    const dur = clamp(s * 1.0, 360, 1000);
    this.spin = { start: now, dur, dir: this.spinBias };
    this.spinBias *= -1;
    const mid = (this.feet.L.x + this.feet.R.x) / 2;
    this.stepFoot("L", mid - STANCE * 0.7, now, dur * 0.35, 7);
    this.stepFoot("R", mid + STANCE * 0.7, now, dur * 0.55, 10);
    this.target = {
      ...REST, crouch: 0.42, rise: 6, twist: 16, shrug: 5,
      armLS: 30, armLE: 108, armRS: 30, armRE: 108, headTilt: -8,
    };
    this.settle = { ...REST, crouch: 0.22, armLS: 17, armLE: 32, armRS: 17, armRE: 32 };
    this.accentUntil = now + dur * 0.8;
  }

  // Two quick compressions rather than one. The elbows also come out and the
  // hands in, so it is a different shape from a beat and not only a different
  // rhythm — a still frame of the two should not look the same.
  doBounce(now, s) {
    this.bounce = { start: now, dur: clamp(s * 0.85, 260, 800) };
    const mid = (this.feet.L.x + this.feet.R.x) / 2;
    this.stepFoot("L", mid - STANCE * 1.35, now, clamp(s * 0.3, 120, 300), 5);
    this.stepFoot("R", mid + STANCE * 1.35, now, clamp(s * 0.3, 120, 300), 5);
    this.target = {
      ...REST, crouch: 0.46, shrug: 7,
      armLS: 46, armLE: 104, armRS: 46, armRE: 104, headNod: 6,
    };
    this.settle = {
      ...REST, crouch: 0.2, armLS: 34, armLE: 88, armRS: 34, armRE: 88,
    };
  }

  // A hold is a shape someone chose to stand in, not a freeze frame: weight on
  // one leg, the other toe turned out, one hand on the hip, chin up.
  doHold(now, s) {
    const dir = this.beatParity ? 1 : -1;
    const free = dir > 0 ? "L" : "R";
    const stand = dir > 0 ? "R" : "L";
    this.stepFoot(free, this.feet[stand].x - dir * STANCE * 0.9, now, clamp(s * 0.45, 180, 420), 6);
    this.feet[free].rot = -24 * dir;
    this.target = {
      ...REST, crouch: 0.14, weight: -dir, lean: -dir * 9, twist: dir * 6,
      [`arm${free}S`]: 25, [`arm${free}E`]: 110,
      [`arm${stand}S`]: 11, [`arm${stand}E`]: 17,
      headTilt: -dir * 7, headNod: -8,
    };
    this.settle = { ...this.target };
    this.still = true;
  }

  // `now` may be in the future, which books the step to begin then: a jump
  // pushes off before the feet come together.
  stepFoot(which, x, now, dur, lift) {
    const foot = this.feet[which];
    foot.anim = { from: foot.x, to: clamp(x, -TRAVEL_LIMIT, TRAVEL_LIMIT), start: now, dur, lift };
  }

  // How long the body thinks this beat lasts: the distance to the next move in
  // the phrase when that is known, otherwise the phrase's typical gap.
  groovePeriod(now) {
    if (this.expected && this.expected > now) {
      const toNext = this.expected - this.lastBeatAt;
      if (toNext > 140 && toNext < 3000) return toNext;
    }
    return this.tempo;
  }

  // ---------- Frame ----------

  update(dt, now) {
    const since = now - this.lastBeatAt;

    // Energy fades when nothing is being played, and sits low in a hold or a drop.
    const wanted = this.still ? 0.14 : since > this.tempo * 2.2 ? 0.1 : 1;
    this.energy += (wanted - this.energy) * (1 - Math.exp((-dt / 1000) * 3));

    // A breath that runs whether or not anything else is happening.
    this.breath += dt / 3400;
    const breath = Math.sin(this.breath * Math.PI * 2) * (1.2 - this.energy * 0.7);

    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (now >= this.queue[i].at) { this.queue[i].run(now); this.queue.splice(i, 1); }
    }

    // Accent, then settle.
    if (this.settle && now > this.accentUntil) {
      this.target = this.settle;
      this.settle = null;
      this.stiffness = 8;
    }
    const k = 1 - Math.exp((-dt / 1000) * this.stiffness);
    for (const key in this.cur) this.cur[key] += (this.target[key] - this.cur[key]) * k;

    // ---- The jump: how far off the floor, and how hard the landing ----
    let air = 0, tuck = 0, jumpSink = 0;
    if (this.jump) {
      const t = clamp((now - this.jump.start) / this.jump.dur, 0, 1);
      if (t < 0.16) {
        jumpSink = (t / 0.16) * 22;                       // gather
      } else if (t < 0.84) {
        const u = (t - 0.16) / 0.68;
        air = Math.sin(Math.PI * u) * this.jump.height;   // the arc
        tuck = Math.sin(Math.PI * u) ** 2 * 28;           // knees come up at the top
      } else {
        const u = (t - 0.84) / 0.16;
        jumpSink = Math.sin(Math.PI * u) * 26;            // absorb through the knees
      }
      if (t >= 1) this.jump = null;
    }

    let bounceDrop = 0;
    if (this.bounce) {
      const t = (now - this.bounce.start) / this.bounce.dur;
      if (t >= 1) this.bounce = null;
      // Two compressions, the second smaller than the first.
      else bounceDrop = Math.abs(Math.sin(2 * Math.PI * t)) * 15 * (1 - t * 0.55);
    }

    // Feet.
    const slow = 1 - Math.exp((-dt / 1000) * 4);
    for (const name of ["L", "R"]) {
      const f = this.feet[name];
      if (f.anim) {
        if (now < f.anim.start) continue;                 // booked, not started yet
        const t = clamp((now - f.anim.start) / f.anim.dur, 0, 1);
        const e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
        f.x = lerp(f.anim.from, f.anim.to, e);
        f.y = FOOT_Y - Math.sin(Math.PI * t) * f.anim.lift;
        if (t >= 1) { f.anim = null; f.y = FOOT_Y; }
      } else {
        f.y += (FOOT_Y - f.lift - f.y) * slow;
      }
      f.rot += ((f.anim ? f.rot : f.rot * 0.9) - f.rot) * slow;
    }

    // The groove: where the beat lives in the body.
    const period = this.groovePeriod(now);
    const p = (((since % period) + period) % period) / period;
    const g = grooveCurve(p) * this.energy * this.calm;
    const depth = clamp(period / 620, 0.6, 1.5) * 11;
    // A slow phrase gets a second sway between moves so it never looks stalled.
    const slowSway = period > 900 ? (0.5 - 0.5 * Math.cos(4 * Math.PI * p)) * 3 * this.energy : 0;
    const swayDir = this.beatParity ? 1 : -1;
    const sway = Math.sin(Math.PI * p) * swayDir * 5 * this.energy * this.calm;

    // Hips: over the weighted foot, dropped by the groove and by whatever the
    // current move is doing to them, lifted by the jump.
    const midFeet = (this.feet.L.x + this.feet.R.x) / 2;
    const halfSpan = (this.feet.R.x - this.feet.L.x) / 2;
    const hipX = midFeet + this.cur.weight * halfSpan * 0.55 + sway;
    const hipY = HIP_Y - this.cur.rise + this.cur.crouch * 20 + this.cur.sink
      + g * depth + slowSway + bounceDrop + jumpSink + breath - air;

    const footLy = this.feet.L.y - air - tuck;
    const footRy = this.feet.R.y - air - tuck;

    const hipTilt = (-this.cur.weight * 5 + this.cur.lean * 0.4) / DEG;
    const hipLx = hipX - Math.cos(hipTilt) * HIP_W, hipLy = hipY - Math.sin(hipTilt) * HIP_W;
    const hipRx = hipX + Math.cos(hipTilt) * HIP_W, hipRy = hipY + Math.sin(hipTilt) * HIP_W;

    // The lower the hips, the more the knees are allowed to open sideways.
    const lowness = clamp((hipY - HIP_Y) / 74, 0, 1);
    const kneeOut = lerp(KNEE_OUT_TALL, KNEE_OUT_LOW, lowness);

    this.place(this.legL, hipLx, hipLy,
      solveLeg(hipLx, hipLy, this.feet.L.x, footLy, 1, kneeOut), this.feet.L, footLy, -1);
    this.place(this.legR, hipRx, hipRy,
      solveLeg(hipRx, hipRy, this.feet.R.x, footRy, -1, kneeOut), this.feet.R, footRy, 1);

    // Spine and shoulders: the shoulders answer the hips rather than copying them.
    const torsoRot = -this.cur.weight * 3.5 + this.cur.lean + g * 1.6 * this.energy;
    const shoulderRot = this.cur.weight * 2.6 + this.cur.twist - g * 2.4 * this.energy;
    this.torso.setAttribute("transform", `translate(${hipX.toFixed(2)} ${hipY.toFixed(2)}) rotate(${torsoRot.toFixed(2)})`);
    // The shoulders also ride up a little on an accent: a shrug, not a shift.
    const shrug = this.cur.shrug + g * 1.4 * this.energy;
    this.shoulders.setAttribute("transform",
      `rotate(${shoulderRot.toFixed(2)} 0 -60) translate(0 ${(-shrug * 0.35).toFixed(2)})`);

    const swing = Math.sin(2 * Math.PI * p) * 4 * this.energy;
    const lagL = this.trackArm("L", this.cur.armLS, dt);
    const lagR = this.trackArm("R", this.cur.armRS, dt);
    this.armL.upper.setAttribute("transform", `translate(${-SHOULDER_X} ${SHOULDER_Y}) rotate(${(this.cur.armLS + swing).toFixed(2)})`);
    this.armL.fore.setAttribute("transform", `translate(0 ${UPPER_ARM}) rotate(${(-this.cur.armLE - lagL).toFixed(2)})`);
    this.armR.upper.setAttribute("transform", `translate(${SHOULDER_X} ${SHOULDER_Y}) rotate(${(-this.cur.armRS - swing).toFixed(2)})`);
    this.armR.fore.setAttribute("transform", `translate(0 ${UPPER_ARM}) rotate(${(this.cur.armRE + lagR).toFixed(2)})`);

    // Facing, and the spin that carries it all the way round. The head leads.
    let facing = this.facing;
    let headLead = 0;
    if (this.spin) {
      const t = clamp((now - this.spin.start) / this.spin.dur, 0, 1);
      facing = this.facing * Math.cos(2 * Math.PI * t);
      headLead = Math.sin(2 * Math.PI * t) * 14 * this.spin.dir;
      if (t >= 1) { this.spin = null; facing = this.facing; }
    }

    const headRot = this.cur.headTilt + this.cur.headNod * 0.3 + g * 2 * this.energy + headLead;
    this.head.setAttribute("transform", `translate(0 ${SHOULDER_Y - 18}) rotate(${headRot.toFixed(2)})`);

    // The ponytail lags behind whatever the head just did.
    const hipVel = ((hipY - this.prevHipY) / Math.max(dt, 1)) * 1000;
    this.prevHipY = hipY;
    const pull = clamp(-hipVel * 0.04 - this.cur.lean * 0.7 - headLead * 1.1, -42, 42);
    this.pony.vel += ((pull - this.pony.angle) * 0.018 - this.pony.vel * 0.011) * dt;
    this.pony.angle += this.pony.vel * dt * 0.06;
    this.pony.node.setAttribute("transform", `rotate(${this.pony.angle.toFixed(2)})`);

    const narrow = 0.16;   // never thinner than this, or the figure disappears
    const shown = Math.sign(facing || 1) * Math.max(narrow, Math.abs(facing));
    this.figure.setAttribute("transform",
      `translate(${hipX.toFixed(2)} 0) scale(${shown.toFixed(3)} 1) translate(${(-hipX).toFixed(2)} 0)`);

    // The shadow reads the height off the floor: smaller and fainter in the air.
    const lift = clamp(air / 70, 0, 1);
    this.shadow.setAttribute("cx", hipX.toFixed(2));
    // It shrinks as the figure rises, but never past nothing: at the top of a
    // big jump the arithmetic would otherwise go negative.
    this.shadow.setAttribute("rx", clamp(58 + (hipY - HIP_Y) * 0.4 - lift * 22, 7, 92).toFixed(2));
    this.shadow.setAttribute("opacity", clamp(0.5 + this.cur.crouch * 0.3 - lift * 0.42, 0.08, 0.9).toFixed(2));
  }

  // The forearm trails the upper arm. When the shoulder swings fast the elbow is
  // still catching up, which is what makes an arm read as having weight.
  trackArm(name, angle, dt) {
    const vel = ((angle - this.prevArm[name]) / Math.max(dt, 1)) * 1000;
    this.prevArm[name] = angle;
    const wanted = clamp(-vel * 0.045, -28, 28);
    this.foreLag[name] += (wanted - this.foreLag[name]) * (1 - Math.exp((-dt / 1000) * 11));
    return this.foreLag[name];
  }

  // Each bone is drawn pointing down from its own joint, so the transform is just
  // "stand at the joint and turn to the angle the solver found".
  place(parts, hipX, hipY, leg, foot, footY, side) {
    parts.thigh.setAttribute("transform",
      `translate(${hipX.toFixed(2)} ${hipY.toFixed(2)}) rotate(${(leg.thigh * DEG - 90).toFixed(2)})`);
    parts.shin.setAttribute("transform",
      `translate(${leg.kneeX.toFixed(2)} ${leg.kneeY.toFixed(2)}) rotate(${(leg.shin * DEG - 90).toFixed(2)}) scale(1 ${leg.shinScale.toFixed(3)})`);
    parts.foot.setAttribute("transform",
      `translate(${foot.x.toFixed(2)} ${footY.toFixed(2)}) scale(${side} 1) rotate(${(foot.rot * side).toFixed(2)})`);
  }
}
