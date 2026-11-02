// utils/stage/stageExpr.ts
//
// Maths expressions for graphs, typed the way people write them: "2x^2 - 3x + 1", "sin(x)e^(-x/5)",
// "a cos(2 pi x - t)". Parsed once into a closure - no eval, nothing but arithmetic can run - and
// evaluated hundreds of thousands of times a second. Implicit multiplication (2x, 3sin(x), x(x+1),
// (x+1)(x-1)), powers right-associative (2^3^2 = 512), unary minus binding looser than powers
// (-x^2 = -(x^2)), common functions, pi and e, the variable x, scene time t, and any other name the
// caller provides (a scene's values: a, speed, battery...).

export type Expr = (vars: ExprVars) => number;
export type ExprVars = Record<string, number>;

export interface Parsed {
  fn: Expr;
  // Names it reads besides x (t, values) - what makes a curve change as the scene plays.
  names: Set<string>;
}

export class ExprError extends Error {
  constructor(
    message: string,
    public at: number
  ) {
    super(message);
  }
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  // The logistic curve - neural networks' sigma.
  sigmoid: (z) => 1 / (1 + Math.exp(-z)),
  sigma: (z) => 1 / (1 + Math.exp(-z)),
  relu: (z) => Math.max(0, z),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Tok = { kind: "num"; v: number; at: number } | { kind: "name"; v: string; at: number } | { kind: "op"; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  // Unicode the panel's palette or a paste might bring in.
  const s = src.replace(/π/g, "pi").replace(/[·×]/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/²/g, "^2").replace(/³/g, "^3");
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i))!;
      if (!m) throw new ExprError(`"${c}" isn't a number`, i);
      out.push({ kind: "num", v: Number(m[0]), at: i });
      i += m[0].length;
    } else if (/[a-z_]/i.test(c)) {
      const m = /^[a-z_][a-z0-9_]*/i.exec(s.slice(i))!;
      out.push({ kind: "name", v: m[0], at: i });
      i += m[0].length;
    } else if ("+-*/^(),".includes(c)) {
      out.push({ kind: "op", v: c, at: i });
      i++;
    } else {
      throw new ExprError(`"${c}" can't be used here`, i);
    }
  }
  return out;
}

// Splits a run of letters a function or known name doesn't claim - "xy", "pix", "ax" - into the
// names it's made of, longest known first: "pix" -> pi·x, "ax" -> a·x (a being a value).
function splitName(name: string, known: (n: string) => boolean): string[] | null {
  if (known(name) || FUNCS[name] || CONSTS[name]) return [name];
  for (let cut = name.length - 1; cut >= 1; cut--) {
    const head = name.slice(0, cut);
    if (known(head) || CONSTS[head] || FUNCS[head]) {
      const rest = splitName(name.slice(cut), known);
      if (rest) return [head, ...rest];
    }
  }
  return null;
}

// `names` lists what may be read besides x and t (a scene's values); anything else is an error.
export function parseExpr(src: string, names: Iterable<string> = []): Parsed {
  const allowed = new Set(["x", "t", ...names]);
  const known = (n: string) => allowed.has(n);
  const raw = tokenize(src);
  // Names split into their parts ("2ax" -> 2 a x).
  const toks: Tok[] = [];
  for (const t of raw) {
    if (t.kind !== "name") {
      toks.push(t);
      continue;
    }
    const parts = splitName(t.v, known);
    if (!parts) throw new ExprError(`"${t.v}" isn't a value or function this graph knows`, t.at);
    let at = t.at;
    for (const p of parts) {
      toks.push({ kind: "name", v: p, at });
      at += p.length;
    }
  }
  if (toks.length === 0) throw new ExprError("Type a function of x - e.g. x^2 or sin(x)", 0);
  const used = new Set<string>();
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.kind === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(peek() ? `Expected "${v}"` : `Missing a closing "${v}"`, peek()?.at ?? src.length);
    i++;
  };
  // Whether the next token starts a factor - for implicit multiplication.
  const startsFactor = () => {
    const t = peek();
    return !!t && (t.kind === "num" || t.kind === "name" || (t.kind === "op" && t.v === "("));
  };

  // sum := term (('+'|'-') term)*
  const sum = (): Expr => {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = toks[i++].v;
      const right = term();
      const l = left;
      left = op === "+" ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
    }
    return left;
  };
  // term := unary (('*'|'/'|implicit) unary)*
  const term = (): Expr => {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = toks[i++].v;
        const right = unary();
        const l = left;
        left = op === "*" ? (v) => l(v) * right(v) : (v) => l(v) / right(v);
      } else if (startsFactor()) {
        const right = power();
        const l = left;
        left = (v) => l(v) * right(v);
      } else return left;
    }
  };
  // unary := '-' unary | '+' unary | power      (so -x^2 = -(x^2))
  const unary = (): Expr => {
    if (isOp("-")) {
      i++;
      const inner = unary();
      return (v) => -inner(v);
    }
    if (isOp("+")) {
      i++;
      return unary();
    }
    return power();
  };
  // power := atom ('^' unary)?      right-associative
  const power = (): Expr => {
    const base = atom();
    if (isOp("^")) {
      i++;
      const exp = unary();
      return (v) => Math.pow(base(v), exp(v));
    }
    return base;
  };
  const atom = (): Expr => {
    const t = peek();
    if (!t) throw new ExprError("Something's missing at the end", src.length);
    if (t.kind === "num") {
      i++;
      const n = t.v;
      return () => n;
    }
    if (t.kind === "op" && t.v === "(") {
      i++;
      const inner = sum();
      expect(")");
      return inner;
    }
    if (t.kind === "name") {
      i++;
      const f = FUNCS[t.v];
      if (f) {
        // sin x, sin 2x (no brackets) take the next power; sin(x, ...) its arguments.
        if (isOp("(")) {
          i++;
          const args: Expr[] = [sum()];
          while (isOp(",")) {
            i++;
            args.push(sum());
          }
          expect(")");
          if (args.length === 1) {
            const a = args[0];
            return (v) => f(a(v));
          }
          return (v) => f(...args.map((a) => a(v)));
        }
        // Without brackets the argument runs to the next function: "sin 2x" is sin(2x), "sin x cos x"
        // is sin(x)·cos(x) - as people write it.
        let arg = power();
        while (startsFactor() && !(peek()!.kind === "name" && FUNCS[(peek() as { v: string }).v])) {
          const a = arg;
          const b = power();
          arg = (v) => a(v) * b(v);
        }
        const whole = arg;
        return (v) => f(whole(v));
      }
      const c = CONSTS[t.v];
      if (c !== undefined && !allowed.has(t.v)) return () => c;
      const name = t.v;
      if (name !== "x") used.add(name);
      return (v) => v[name] ?? 0;
    }
    throw new ExprError(`"${t.v}" can't go here`, t.at);
  };

  const fn = sum();
  if (i < toks.length) throw new ExprError(`"${toks[i].v}" doesn't belong here`, toks[i].at);
  return { fn, names: used };
}

// Parsed once per distinct source and set of names; graphs re-read the same expressions every frame.
const cache = new Map<string, Parsed | ExprError>();
export function compileExpr(src: string, names: string[] = []): Parsed | ExprError {
  const key = `${names.join(",")}\u0000${src}`;
  let hit = cache.get(key);
  if (!hit) {
    try {
      hit = parseExpr(src, names);
    } catch (e) {
      hit = e instanceof ExprError ? e : new ExprError(String(e), 0);
    }
    if (cache.size > 2000) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

// The slope at x, by a central difference scaled to x - accurate to ~1e-8 relative on smooth curves.
export function slopeAt(fn: Expr, vars: ExprVars, x: number): number {
  const h = 1e-5 * Math.max(1, Math.abs(x));
  return (fn({ ...vars, x: x + h }) - fn({ ...vars, x: x - h })) / (2 * h);
}
