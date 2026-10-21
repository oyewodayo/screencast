// services/transition_graphs.rs
//
// Export graphs for the transitions that move BOTH pictures (push, cube, flip, tile wall, split,
// strips, slice, spin, glitch, light beam, before/after, shape iris, blocks, grid). Each draws one
// transition window: [old{i}] (the outgoing clip's tail, `d` seconds, timed from 0) and [head{i}]
// (the incoming clip's first `d` seconds) into [tr{i}] - exactly what transition_window_graph's
// other cases do, so transition_fold_step joins them the same way.
//
// The preview draws these from the same formulas (components/video/transitionCanvas.ts) - every
// curve, threshold and size here is that file's, evaluated per frame at the output size: progress
// p = min(t/d, 1) from an overlay's/crop's `t`, geq's `T`, or perspective's frame counter `in`.
//
// Cost: everything that moves is a per-frame overlay position, crop window or `perspective`
// corner set over native filters; per-pixel maths (geq) runs once on a sprite, or per frame only
// on a reduced-size mask that is scaled up (its edges are soft anyway).
use crate::commands::conversion::{parse_hex_color, sendcmd_series, TransitionLook};
use std::f64::consts::PI;

pub const CANVAS_TRANSITIONS: &[&str] = &["blocks", "mosaic", "split", "slider", "strips", "beam", "iris", "spin", "glitch", "slice", "push", "cube", "flip", "tiles"];

pub fn is_canvas_transition(name: &str) -> bool {
    CANVAS_TRANSITIONS.contains(&name)
}

// ---------- expression helpers (transitionCanvas.ts's curves) ----------

fn c01(p: &str) -> String {
    format!("clip({p},0,1)")
}
fn ex_smooth(p: &str) -> String {
    let c = c01(p);
    format!("(pow({c},2)*(3-2*{c}))")
}
fn ex_ease_io3(p: &str) -> String {
    let c = c01(p);
    format!("if(lt({c},0.5),4*pow({c},3),1-pow(2-2*{c},3)/2)")
}
fn ex_ease_in3(p: &str) -> String {
    format!("pow({},3)", c01(p))
}

// The asset/text-reveal hash, evaluated here (the same f64 maths as the preview's).
fn index_hash(n: f64) -> f64 {
    let x = (n * 127.1 + 311.7).sin() * 43758.5453;
    x - x.floor()
}
// The dissolve's per-cell hash as a geq expression of X, Y.
const CELL_HASH: &str = "(sin(X*12.9898+Y*78.233)*43758.5453-floor(sin(X*12.9898+Y*78.233)*43758.5453))";

fn even(v: f64) -> i64 {
    ((v / 2.0).round() as i64 * 2).max(2)
}

// Four corners for `perspective`, as option text.
fn corners(c: [(String, String); 4]) -> String {
    format!(
        "x0='{}':y0='{}':x1='{}':y1='{}':x2='{}':y2='{}':x3='{}':y3='{}'",
        c[0].0, c[0].1, c[1].0, c[1].1, c[2].0, c[2].1, c[3].0, c[3].1
    )
}

// A single still frame of the stream, made fully transparent, held for the window - the canvas
// sprites are drawn on.
fn transparent_sprite(src: &str, d: f64) -> String {
    format!("[{src}]trim=end_frame=1,format=yuva420p,lutyuv=y=16:u=128:v=128:a=0,tpad=stop_mode=clone:stop_duration={d:.4}")
}

pub fn grid_size(w: i64, h: i64) -> (i64, i64) {
    let cell = w.min(h) as f64 / 4.0;
    (((w as f64) / cell).round().max(2.0) as i64, ((h as f64) / cell).round().max(2.0) as i64)
}

// The pictures' travel for cube / flip: along the turning direction (x for left/right, y for
// up/down), mirrored for right/down.
fn dir_axes(look: &TransitionLook) -> (bool, f64) {
    let dir = look.direction.as_deref();
    (matches!(dir, Some("up") | Some("down")), if matches!(dir, Some("right") | Some("down")) { -1.0 } else { 1.0 })
}

const DEG1: f64 = PI / 180.0;

// Corner expressions of a turning face. `at(u)` gives (along, k) expressions for the face's source
// line u (0 or 1).
// The source is the face padded by `pad` transparent pixels each side, so its corners are the
// face's own extended outward by `pad` - mapped through the same perspective.
fn face_corners(vertical: bool, w: i64, h: i64, pad: f64, at: impl Fn(f64) -> (String, String)) -> String {
    let (wf, hf) = (w as f64, h as f64);
    let (s_len, p_len) = if vertical { (hf, wf) } else { (wf, hf) };
    let (a0, k0) = at(-pad / s_len);
    let (a1, k1) = at(1.0 + pad / s_len);
    let c = |along: &str, k: &str, plus: bool| -> (String, String) {
        let sign = if plus { "+" } else { "-" };
        let across = format!("{pad}+{:.4}{sign}{:.4}*({k})", p_len / 2.0, p_len / 2.0 + pad);
        if vertical {
            (across, format!("{pad}+({along})"))
        } else {
            (format!("{pad}+({along})"), across)
        }
    };
    if vertical {
        // Source top-left, top-right (u = 0, across -/+), bottom-left, bottom-right (u = 1).
        corners([c(&a0, &k0, false), c(&a0, &k0, true), c(&a1, &k1, false), c(&a1, &k1, true)])
    } else {
        corners([c(&a0, &k0, false), c(&a1, &k1, false), c(&a0, &k0, true), c(&a1, &k1, true)])
    }
}

// A face drawn in perspective: shaded (black at 1 - shade over it), padded with a transparent
// border so everything outside the quad is clear, `perspective` to the quad, cropped back.
fn face_chain(src: &str, out: &str, tag: &str, w: i64, h: i64, d: f64, shade: &str, persp: &str) -> String {
    format!(
        "[{src}]split[{tag}a][{tag}b];[{tag}b]scale=8:8,format=yuva420p,geq=lum=16:cb=128:cr=128:a='255*(1-({shade}))',scale={w}:{h}[{tag}s];\
         [{tag}a][{tag}s]overlay=eof_action=pass,format=yuva420p,pad=iw+4:ih+4:2:2:color=black@0,perspective={persp}:sense=destination:eval=frame,crop={w}:{h}:2:2,trim=end={d:.4}[{out}];"
    )
}

// The whole window graph for one of CANVAS_TRANSITIONS.
pub fn canvas_transition(name: &str, i: usize, d: f64, fps: f64, (w, h): (i64, i64), look: &TransitionLook) -> String {
    let (wf, hf) = (w as f64, h as f64);
    let mn = wf.min(hf);
    let half = d / 2.0;
    // Progress from an overlay's / crop's `t`, geq's `T`, perspective's frame counter `in` (from 1).
    let pt = format!("min(t/{d:.4},1)");
    let pg = format!("min(T/{d:.4},1)");
    let frames = (d * fps.max(1.0)).max(1.0);
    let pf = format!("min((in-1)/{frames:.4},1)");
    let black = "lutyuv=y=16:u=128:v=128";
    let alpha_over = |base: &str, layer: &str, out: &str| format!("[{base}][{layer}]overlay=eof_action=pass[{out}];");

    match name {
        "blocks" | "mosaic" => {
            let (cols, rows) = grid_size(w, h);
            let th = if name == "blocks" {
                format!("(0.08+0.84*{CELL_HASH})")
            } else {
                format!("(0.12+0.76*(0.55*((X/{}+Y/{})/2)+0.45*{CELL_HASH}))", cols - 1, rows - 1)
            };
            let masked = format!(
                "[old{i}]split[ma{i}][mm{i}];[mm{i}]scale={cols}:{rows}:flags=neighbor,format=gray,geq=lum='255*lt({pg},{th})',scale={w}:{h}:flags=neighbor[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];"
            );
            if name == "blocks" {
                return format!("{masked}[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];");
            }
            let mut g = format!("{masked}[head{i}]split[hd{i}][hs{i}];[hd{i}][mo{i}]overlay=eof_action=pass[bx{i}];");
            // The grid lines: one sprite, faded in over the first 15% and out over the last.
            let lw = (mn * 0.005).round().max(1.0) as i64;
            let mut boxes = String::new();
            for c in 1..cols {
                let x = ((c as f64) * wf / cols as f64 - lw as f64 / 2.0).round() as i64;
                boxes.push_str(&format!(",drawbox=x={x}:y=0:w={lw}:h={h}:color=black@0.85:t=fill:replace=1"));
            }
            for r in 1..rows {
                let y = ((r as f64) * hf / rows as f64 - lw as f64 / 2.0).round() as i64;
                boxes.push_str(&format!(",drawbox=x=0:y={y}:w={w}:h={lw}:color=black@0.85:t=fill:replace=1"));
            }
            g.push_str(&format!(
                "{}{boxes},fade=t=in:st=0:d={:.4}:alpha=1,fade=t=out:st={:.4}:d={:.4}:alpha=1[ln{i}];{}",
                transparent_sprite(&format!("hs{i}"), d),
                0.15 * d,
                0.85 * d,
                0.15 * d,
                alpha_over(&format!("bx{i}"), &format!("ln{i}"), &format!("tr{i}"))
            ));
            g
        }
        "split" => {
            let (hx, hy) = (even(wf / 2.0), even(hf / 2.0));
            let quads = [(0, 0, hx, hy), (hx, 0, w - hx, hy), (hx, hy, w - hx, h - hy), (0, hy, hx, h - hy)];
            let dirs = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)];
            let mut g = format!("[head{i}]split=6[hb{i}][hq0{i}][hq1{i}][hq2{i}][hq3{i}][hl{i}];[old{i}]split=4[oq0{i}][oq1{i}][oq2{i}][oq3{i}];[hb{i}]{black}[s0{i}];");
            let mut cur = format!("s0{i}");
            let mut n = 0;
            for (side, src) in [("o", "oq"), ("n", "hq")] {
                for (k, &(qx, qy, qw, qh)) in quads.iter().enumerate() {
                    let away = if side == "o" {
                        ex_ease_in3(&format!("({pt}-{:.4})/0.3", 0.1 + 0.06 * k as f64))
                    } else {
                        format!("pow(1-{},3)", c01(&format!("({pt}-{:.4})/0.32", 0.46 + 0.06 * k as f64)))
                    };
                    let (dx, dy) = dirs[k];
                    n += 1;
                    let next = format!("s{n}{i}");
                    g.push_str(&format!(
                        "[{src}{k}{i}]crop={qw}:{qh}:{qx}:{qy}[c{side}{k}{i}];[{cur}][c{side}{k}{i}]overlay=x='{qx}+{dx}*({away})*{:.4}':y='{qy}+{dy}*({away})*{:.4}':eof_action=pass[{next}];",
                        wf / 2.0,
                        hf / 2.0
                    ));
                    cur = next;
                }
            }
            let gw = (mn * 0.014).round().max(2.0) as i64;
            g.push_str(&format!(
                "{},drawbox=x={}:y=0:w={gw}:h={h}:color=black:t=fill:replace=1,drawbox=x=0:y={}:w={w}:h={gw}:color=black:t=fill:replace=1,fade=t=in:st=0:d={:.4}:alpha=1,fade=t=out:st={:.4}:d={:.4}:alpha=1[gl{i}];{}",
                transparent_sprite(&format!("hl{i}"), d),
                hx - gw / 2,
                hy - gw / 2,
                0.1 * d,
                0.9 * d,
                0.1 * d,
                alpha_over(&cur, &format!("gl{i}"), &format!("tr{i}"))
            ));
            g
        }
        "slider" | "beam" => {
            let mirrored = look.direction.as_deref() == Some("left");
            let x = if name == "slider" {
                let m = 0.06 * mn;
                format!("({:.4}+{:.4}*{})", -m, wf + 2.0 * m, ex_smooth(&pt))
            } else {
                format!("({:.4}+{:.4}*{})", -0.15 * wf, 1.3 * wf, ex_smooth(&pt))
            };
            let at = if mirrored { format!("({w}-{x})") } else { x };
            // The new clip shows on one side of `at`: the old picture masked by a half-white sprite
            // two frames wide, slid so its edge sits at `at` (white = old visible).
            let pad_x = if mirrored { "0" } else { "iw" };
            let mut g = format!(
                "[old{i}]split=3[ma{i}][mc{i}][ms{i}];\
                 [ms{i}]trim=end_frame=1,lutyuv=y=255:u=128:v=128,pad=iw*2:ih:{pad_x}:0:black,tpad=stop_mode=clone:stop_duration={d:.4}[sp{i}];\
                 [mc{i}]lutyuv=y=0:u=128:v=128[cv{i}];[cv{i}][sp{i}]overlay=x='{at}-{w}':y=0[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}]split[hd{i}][hs{i}];[hd{i}][mo{i}]overlay=eof_action=pass[bs{i}];"
            );
            if name == "slider" {
                // The handle: a white bar with an arrowhead either side, drawn once.
                let a = 0.03 * mn;
                let gap = 0.016 * mn;
                let lw = (0.006 * mn).max(2.0);
                let hw = even(2.0 * (gap + 1.2 * a) + 8.0);
                let cx = hw as f64 / 2.0;
                let cy = hf / 2.0;
                // u: distance from a tip toward its base; f: inside the slanted edges (>= 0).
                let tri = |sign: f64| {
                    let tip = cx + sign * (gap + 1.2 * a);
                    let u = format!("({sign}*({tip:.4}-(X+0.5)))");
                    let f = format!("(({u})/1.2-abs((Y+0.5)-{cy:.4}))/1.3017");
                    format!("clip(min(min({f},{:.4}-{u}),{u})+0.5,0,1)", 1.2 * a)
                };
                let line = format!("clip({:.4}-abs((X+0.5)-{cx:.4})+0.5,0,1)", lw / 2.0);
                g.push_str(&format!(
                    "[hs{i}]trim=end_frame=1,scale={hw}:{h},format=yuva420p,geq=lum=235:cb=128:cr=128:a='255*max({line},max({},{}))',tpad=stop_mode=clone:stop_duration={d:.4}[hn{i}];\
                     [bs{i}][hn{i}]overlay=x='{at}-{}':y=0:eof_action=pass[tr{i}];",
                    tri(1.0),
                    tri(-1.0),
                    hw / 2
                ));
                return g;
            }
            // The beam: its glow profile drawn once on a strip 2.6 frames wide, a frame-wide window
            // of it cropped per frame so its core sits at `at`, screened on.
            let k = look.intensity.unwrap_or(1.0).clamp(0.1, 1.5);
            let (r, gg, b) = look.color.as_deref().and_then(parse_hex_color).unwrap_or((255.0, 241.0, 214.0));
            let sw = even(2.6 * wf);
            let centre = 1.3 * wf;
            let glow = format!(
                "min(1,{k:.3}*(0.9*exp(-pow((X-{centre:.3})/{:.4},2))+0.5*exp(-pow((X-{centre:.3})/{:.4},2))))",
                0.01 * wf,
                0.06 * wf
            );
            g.push_str(&format!(
                "[hs{i}]trim=end_frame=1,scale={sw}:2,format=gbrp,geq=r='{r}*{glow}':g='{gg}*{glow}':b='{b}*{glow}',scale={sw}:{h}:flags=neighbor,tpad=stop_mode=clone:stop_duration={d:.4},\
                 crop={w}:{h}:x='{centre:.3}-({at})':y=0[gw{i}];[bs{i}]format=gbrp[bg{i}];[bg{i}][gw{i}]blend=all_mode=screen:shortest=1,format=yuv420p[tr{i}];"
            ));
            g
        }
        "strips" => {
            const N: i64 = 6;
            let rows = look.orientation.as_deref() == Some("horizontal");
            let span = if rows { h } else { w };
            // Strip edges on even pixels (whole chroma samples).
            let edges: Vec<i64> = (0..=N).map(|k| if k == 0 { 0 } else if k == N { span } else { ((k * span) as f64 / N as f64 / 2.0).round() as i64 * 2 }).collect();
            let mut g = format!("[old{i}]split={N}");
            for k in 0..N {
                g.push_str(&format!("[so{k}{i}]"));
            }
            g.push_str(&format!(";[head{i}]split={}[sb{i}]", N + 1));
            for k in 0..N {
                g.push_str(&format!("[sn{k}{i}]"));
            }
            g.push_str(&format!(";[sb{i}]{black}[t0{i}];"));
            let mut cur = format!("t0{i}");
            let mut n = 0;
            for k in 0..N {
                let (a0, a1) = (edges[k as usize], edges[k as usize + 1]);
                let travel = ex_ease_io3(&format!("({pt}-{:.4})/0.7", 0.3 * k as f64 / (N - 1) as f64));
                let dir = if k % 2 == 0 { 1.0 } else { -1.0 };
                for (side, offset) in [("so", format!("{dir}*({travel})")), ("sn", format!("{dir}*(({travel})-1)"))] {
                    let crop = if rows { format!("crop={w}:{}:0:{a0}", a1 - a0) } else { format!("crop={}:{h}:{a0}:0", a1 - a0) };
                    let (x, y) = if rows { (format!("{offset}*{w}"), a0.to_string()) } else { (a0.to_string(), format!("{offset}*{h}")) };
                    n += 1;
                    let next = format!("t{n}{i}");
                    g.push_str(&format!("[{side}{k}{i}]{crop}[{side}c{k}{i}];[{cur}][{side}c{k}{i}]overlay=x='{x}':y='{y}':eof_action=pass[{next}];"));
                    cur = next;
                }
            }
            g.push_str(&format!("[{cur}]null[tr{i}];"));
            g
        }
        "iris" => {
            let shape = match look.shape.as_deref() {
                Some(s @ ("diamond" | "hexagon" | "star" | "heart")) => s,
                _ => "triangle",
            };
            let inradius = match shape {
                "diamond" => std::f64::consts::FRAC_1_SQRT_2,
                "hexagon" => 3f64.sqrt() / 2.0,
                "star" => 0.5,
                "heart" => 0.8,
                _ => 0.5,
            };
            let m = mn / 2.0;
            let corner = (wf.hypot(hf) / 2.0) / m;
            let s = format!("max({:.5}*pow({pg},2),1e-6)", corner / inradius * 1.02);
            // Point in units of half the short side, from the centre, y down (mask at half size).
            let x = format!("((X/W-0.5)*{:.4})", wf / m);
            let y = format!("((Y/H-0.5)*{:.4})", hf / m);
            let outside = match shape {
                "diamond" => format!("gt(abs({x})+abs({y}),{s})"),
                "hexagon" => format!("gt(max(2*abs({y})/sqrt(3),abs({x})+abs({y})/sqrt(3)),{s})"),
                "star" => {
                    let rho = 0.5f64;
                    let (s36, c36) = ((36.0 * DEG1).sin(), (36.0 * DEG1).cos());
                    let th = format!("mod(atan2({x},-{y})+2*PI,2*PI/5)");
                    let a = format!("min({th},2*PI/5-{th})");
                    let big_r = format!("({:.6}/(cos({a})*{:.6}-sin({a})*{:.6}))", rho * s36, rho * s36, rho * c36 - 1.0);
                    format!("gt(hypot({x},{y}),{s}*{big_r})")
                }
                "heart" => {
                    let hx = format!("({x}/{s})");
                    let hy = format!("(-{y}/{s}+0.1)");
                    format!("gt(pow({hx}*{hx}+{hy}*{hy}-1,3)-{hx}*{hx}*pow({hy},3),0)")
                }
                _ => format!("gt(max(-2*{y},sqrt(3)*abs({x})+{y}),{s})"),
            };
            let (lw, lh) = ((w / 2).max(2), (h / 2).max(2));
            format!(
                "[old{i}]split[ma{i}][mm{i}];[mm{i}]scale={lw}:{lh},format=gray,geq=lum='255*{outside}',scale={w}:{h}:flags=bilinear[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];"
            )
        }
        "spin" => {
            let sgn = if look.direction.as_deref() == Some("left") { -1.0 } else { 1.0 };
            let ratio = (wf / hf).max(hf / wf);
            let persp = |deg: &str| {
                let a = format!("({sgn}*{deg}*PI/180)");
                let z = format!("(abs(cos({a}))+{ratio:.5}*abs(sin({a})))");
                let pt = |ox: f64, oy: f64| -> (String, String) {
                    let (dx, dy) = (ox - wf / 2.0, oy - hf / 2.0);
                    (
                        format!("{:.4}+({dx:.4}*cos({a})+{dy:.4}*sin({a}))/{z}", wf / 2.0),
                        format!("{:.4}+(-({dx:.4})*sin({a})+{dy:.4}*cos({a}))/{z}", hf / 2.0),
                    )
                };
                format!("perspective={}:sense=source:eval=frame", corners([pt(0.0, 0.0), pt(wf, 0.0), pt(0.0, hf), pt(wf, hf)]))
            };
            let old_deg = format!("(90*pow({},3))", c01(&format!("2*{pf}")));
            let new_deg = format!("(-90*pow(1-{},3))", c01(&format!("2*{pf}-1")));
            let blur = |tag: &str| sendcmd_series(&format!("gblur@{tag}{i}"), &["sigma", "sigmaV"], d, fps, |p| 0.03 * mn * (PI * p).sin().powi(2));
            format!(
                "[old{i}]{},{},gblur@so{i}=sigma=0:sigmaV=0[spo{i}];[head{i}]{},{},gblur@sn{i}=sigma=0:sigmaV=0[spn{i}];[spn{i}][spo{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[tr{i}];",
                persp(&old_deg),
                blur("so"),
                persp(&new_deg),
                blur("sn")
            )
        }
        "glitch" => {
            const STEPS: usize = 10;
            const SLICES: usize = 5;
            let k_expr = format!("min(floor({pt}*{STEPS}),{})", STEPS - 1);
            // A value per step as a nested if on the step number.
            let stepped = |v: &dyn Fn(usize) -> f64| {
                let mut e = format!("{:.4}", v(STEPS - 1));
                for k in (0..STEPS - 1).rev() {
                    e = format!("if(lt({k_expr},{}),{:.4},{e})", k + 1, v(k));
                }
                e
            };
            let mut g = format!("[head{i}][old{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[gb{i}];[gb{i}]split={}[gc{i}]", SLICES + 1);
            for j in 0..SLICES {
                g.push_str(&format!("[gs{j}{i}]"));
            }
            g.push(';');
            let mut cur = format!("gc{i}");
            for j in 0..SLICES {
                let jf = j as f64;
                let sh = ((hf * (0.04 + 0.08 * index_hash(jf * 7.3))).round() as i64).max(2);
                let y = stepped(&|k| (hf - hf * (0.04 + 0.08 * index_hash(jf * 7.3))) * index_hash(jf * 3.1 + k as f64 * 1.7));
                let dx = stepped(&|k| (index_hash(jf * 5.9 + k as f64 * 2.3) - 0.5) * 0.2 * wf);
                let next = format!("gt{j}{i}");
                g.push_str(&format!(
                    "[gs{j}{i}]crop={w}:{sh}:0:y='{y}'[gsc{j}{i}];[{cur}][gsc{j}{i}]overlay=x='({dx})*sin(PI*{pt})':y='{y}':eof_action=pass[{next}];"
                ));
                cur = next;
            }
            let red = sendcmd_series(&format!("rgbashift@g{i}"), &["rh"], d, fps, |p| -(0.02 * wf * (PI * p).sin()).round());
            let blue = sendcmd_series(&format!("rgbashift@g{i}"), &["bh"], d, fps, |p| (0.02 * wf * (PI * p).sin()).round());
            g.push_str(&format!("[{cur}]{red},{blue},rgbashift@g{i}=rh=0:bh=0:edge=smear,format=yuv420p[tr{i}];"));
            g
        }
        "slice" => {
            let (nx, ny) = ((PI / 3.0).sin(), (PI / 3.0).cos());
            let (dx, dy) = ((PI / 3.0).cos(), -(PI / 3.0).sin());
            let travel = format!("({}*{:.4})", ex_ease_io3(&pt), wf.hypot(hf));
            let (lw, lh) = ((w / 2).max(2), (h / 2).max(2));
            format!(
                "[old{i}]split=3[oa{i}][ob{i}][om{i}];\
                 [om{i}]trim=end_frame=1,scale={lw}:{lh},format=gray,geq=lum='255*clip(0.5-((X/W-0.5)*{wf}*{nx:.6}+(Y/H-0.5)*{hf}*{ny:.6})/2,0,1)',scale={w}:{h}:flags=bilinear,tpad=stop_mode=clone:stop_duration={d:.4},split[mA{i}][mB0{i}];\
                 [mB0{i}]negate[mB{i}];\
                 [oa{i}]format=yuva420p[oaa{i}];[oaa{i}][mA{i}]alphamerge[ha{i}];[ob{i}]format=yuva420p[obb{i}];[obb{i}][mB{i}]alphamerge[hb{i}];\
                 [head{i}][ha{i}]overlay=x='{travel}*{dx:.6}':y='{travel}*{dy:.6}':eof_action=pass[sl{i}];\
                 [sl{i}][hb{i}]overlay=x='-{travel}*{dx:.6}':y='-{travel}*{dy:.6}':eof_action=pass[tr{i}];"
            )
        }
        "push" => {
            let e = ex_ease_io3(&pt);
            let (pos_old, pos_new) = match look.direction.as_deref() {
                Some("right") => ((format!("({e})*{w}"), "0".to_string()), (format!("(({e})-1)*{w}"), "0".to_string())),
                Some("up") => (("0".to_string(), format!("-({e})*{h}")), ("0".to_string(), format!("(1-({e}))*{h}"))),
                Some("down") => (("0".to_string(), format!("({e})*{h}")), ("0".to_string(), format!("(({e})-1)*{h}"))),
                _ => ((format!("-({e})*{w}"), "0".to_string()), (format!("(1-({e}))*{w}"), "0".to_string())),
            };
            format!(
                "[head{i}]split[pb{i}][pn{i}];[pb{i}]{black}[pk{i}];[pk{i}][old{i}]overlay=x='{}':y='{}':eof_action=pass[p1{i}];[p1{i}][pn{i}]overlay=x='{}':y='{}':eof_action=pass[tr{i}];",
                pos_old.0, pos_old.1, pos_new.0, pos_new.1
            )
        }
        "cube" => {
            let (vertical, sgn) = dir_axes(look);
            let s_len = if vertical { hf } else { wf };
            let big_d = 2.2 * s_len;
            // Turn angle from perspective's frame counter (clamped off the degenerate edge-on
            // positions, which the overlays hide) and from an overlay's `t`.
            let phi_of = |p: &str| format!("(PI/2*{})", ex_ease_io3(p));
            let face = |old: bool| {
                let phi = if old { format!("min({},{:.6})", phi_of(&pf), PI / 2.0 - DEG1) } else { format!("max({},{:.6})", phi_of(&pf), DEG1) };
                let recess = format!("({:.4}*sin(2*{phi}))", 0.25 * s_len);
                let at = move |u: f64| -> (String, String) {
                    let x = sgn * (u - 0.5) * s_len;
                    let (xp, zp) = if old {
                        (format!("({x:.4}*cos({phi})-{:.4}*sin({phi}))", s_len / 2.0), format!("({x:.4}*sin({phi})+{:.4}*cos({phi}))", s_len / 2.0))
                    } else {
                        (format!("({:.4}*cos({phi})+{x:.4}*sin({phi}))", s_len / 2.0), format!("({:.4}*sin({phi})-({x:.4})*cos({phi}))", s_len / 2.0))
                    };
                    let k = format!("({big_d:.4}/({big_d:.4}-({zp}-{:.4}-{recess})))", s_len / 2.0);
                    (format!("{:.4}+{sgn}*{xp}*{k}", s_len / 2.0), k)
                };
                face_corners(vertical, w, h, 2.0, at)
            };
            let phi_t = phi_of(&pt);
            let phi_g = phi_of(&pg);
            format!(
                "{}{}[head{i}]split[cb{i}][cn{i}];[cb{i}]{black}[ck{i}];\
                 [ck{i}][cfo{i}]overlay=eof_action=pass:enable='lte({phi_t},{:.6})'[c1{i}];[c1{i}][cfn{i}]overlay=eof_action=pass:enable='gte({phi_t},{:.6})'[tr{i}];",
                face_chain(&format!("old{i}"), &format!("cfo{i}"), &format!("cso{i}"), w, h, d, &format!("0.6+0.4*cos({phi_g})"), &face(true)),
                face_chain(&format!("cn{i}"), &format!("cfn{i}"), &format!("csn{i}"), w, h, d, &format!("0.6+0.4*sin({phi_g})"), &face(false)),
                PI / 2.0 - DEG1,
                DEG1
            )
        }
        "flip" => {
            let (vertical, sgn) = dir_axes(look);
            let s_len = if vertical { hf } else { wf };
            let big_d = 2.5 * s_len;
            let e_of = |p: &str| ex_ease_io3(p);
            let face = |old: bool| {
                let e = e_of(&pf);
                let theta = if old { format!("min(PI*{e},{:.6})", PI / 2.0 - DEG1) } else { format!("max(PI*{e}-PI,{:.6})", -PI / 2.0 + DEG1) };
                let recess = format!("({:.4}*sin(PI*{e}))", 0.2 * s_len);
                let at = move |u: f64| -> (String, String) {
                    let x = sgn * (u - 0.5) * s_len;
                    let k = format!("({big_d:.4}/({big_d:.4}-(-({x:.4})*sin({theta})-{recess})))");
                    (format!("{:.4}+{sgn}*{x:.4}*cos({theta})*{k}", s_len / 2.0), k)
                };
                face_corners(vertical, w, h, 2.0, at)
            };
            let phi_t = format!("(PI*{})", e_of(&pt));
            let shade = |old: bool| {
                let phi = format!("(PI*{})", e_of(&pg));
                if old {
                    format!("0.6+0.4*abs(cos({phi}))")
                } else {
                    format!("0.6+0.4*abs(cos({phi}-PI))")
                }
            };
            format!(
                "{}[head{i}]split[fb{i}][fn{i}];{}[fb{i}]{black}[fk{i}];\
                 [fk{i}][ffo{i}]overlay=eof_action=pass:enable='lt({phi_t},{:.6})'[f1{i}];[f1{i}][ffn{i}]overlay=eof_action=pass:enable='gt({phi_t},{:.6})'[tr{i}];",
                face_chain(&format!("old{i}"), &format!("ffo{i}"), &format!("fso{i}"), w, h, d, &shade(true), &face(true)),
                face_chain(&format!("fn{i}"), &format!("ffn{i}"), &format!("fsn{i}"), w, h, d, &shade(false), &face(false)),
                PI / 2.0 - DEG1,
                PI / 2.0 + DEG1
            )
        }
        // "tiles"
        _ => {
            // The incoming clip as a 3x3 wall of mirrored tiles (each padded by the gap), turned and
            // scaled about the centre per frame with `perspective`, the frame-sized middle cropped
            // out. `perspective` costs per pixel, so only the centre tile - which ends up as the
            // whole frame - is turned at full size; the eight around it come from a third-size wall
            // and their rounded shape from a quarter-size one (they're at the edges, moving fast).
            let gap = ((0.05 * mn / 12.0).round() as i64 * 12).max(12);
            let radius = ((0.05 * mn / 8.0).round() as i64 * 8).max(8);
            let ef = ex_ease_io3(&pf);
            let s = format!("(0.34+0.66*{ef})");
            let a = format!("(-10*(1-{ef})*PI/180)");
            // A wall of `div`-size tiles: source points of its output corners, centre + R(-a) (corner - centre) / s.
            let wall_persp = |ww: i64, wh: i64| {
                let pt = |sx: f64, sy: f64| -> (String, String) {
                    let (dx, dy) = (sx * ww as f64 / 2.0, sy * wh as f64 / 2.0);
                    (
                        format!("{:.4}+({dx:.4}*cos({a})+{dy:.4}*sin({a}))/{s}", ww as f64 / 2.0),
                        format!("{:.4}+(-({dx:.4})*sin({a})+{dy:.4}*cos({a}))/{s}", wh as f64 / 2.0),
                    )
                };
                format!("perspective={}:sense=source:eval=frame", corners([pt(-1.0, -1.0), pt(1.0, -1.0), pt(-1.0, 1.0), pt(1.0, 1.0)]))
            };
            // Tiles at 1/div: size, gap, the wall's size and its middle tile's offset.
            let dims = |div: i64| {
                let (tw, th, tg) = (even(wf / div as f64), even(hf / div as f64), gap / div);
                let (cw, ch) = (tw + tg, th + tg);
                (tw, th, tg, cw, ch, (3 * cw - tw) / 2, (3 * ch - th) / 2)
            };
            let (w2, h2, g2, cw2, ch2, ox2, oy2) = dims(3);
            let (w4, h4, g4, cw4, ch4, ox4, oy4) = dims(4);
            let r4 = radius / 4;
            // The full-size centre tile, padded 2px clear: corners C + R(a) s (+-(W/2+2), +-(H/2+2)).
            let centre_pt = |sx: f64, sy: f64| -> (String, String) {
                let (x, y) = (sx * (wf / 2.0 + 2.0), sy * (hf / 2.0 + 2.0));
                (
                    format!("2+{:.4}+{s}*({x:.4}*cos({a})-({y:.4})*sin({a}))", wf / 2.0),
                    format!("2+{:.4}+{s}*({x:.4}*sin({a})+{y:.4}*cos({a}))", hf / 2.0),
                )
            };
            let centre = corners([centre_pt(-1.0, -1.0), centre_pt(1.0, -1.0), centre_pt(-1.0, 1.0), centre_pt(1.0, 1.0)]);
            // A rounded corner of radius r in its patch (top-left; mirrored for the others).
            let corner_geq = |r: &str| format!("geq=lum='255*if(lt(X,{r})*lt(Y,{r}),clip({r}-hypot({r}-X-0.5,{r}-Y-0.5)+0.5,0,1),1)'");
            let four_corners = |src: &str, patch: &str, out: &str, tw: i64, th: i64, r: i64, tag: &str| {
                format!(
                    "[{patch}]split=4[{tag}0{i}][{tag}1{i}][{tag}2{i}][{tag}3{i}];[{tag}1{i}]hflip[{tag}1f{i}];[{tag}2{i}]vflip[{tag}2f{i}];[{tag}3{i}]hflip,vflip[{tag}3f{i}];\n                     [{src}][{tag}0{i}]overlay=0:0[{tag}a{i}];[{tag}a{i}][{tag}1f{i}]overlay={}:0[{tag}b{i}];[{tag}b{i}][{tag}2f{i}]overlay=0:{}[{tag}c{i}];[{tag}c{i}][{tag}3f{i}]overlay={}:{},format=gray[{out}];",
                    tw - r,
                    th - r,
                    tw - r,
                    th - r
                )
            };
            // The centre tile's corners square off over the last 20%, so it lands exactly on the frame.
            let centre_r = format!("({radius}*(1-clip((T/{d:.4}-0.8)/0.2,0,1)))");
            format!(
                "[head{i}]split=3[thc{i}][thw{i}][thm{i}];\n                 [thw{i}]scale={w2}:{h2},pad={cw2}:{ch2}:{}:{}:black,split=4[tn{i}][ta{i}][tb{i}][tc{i}];\n                 [ta{i}]hflip,split=2[hf0{i}][hf1{i}];[tb{i}]vflip,split=2[vf0{i}][vf1{i}];[tc{i}]hflip,vflip,split=4[hv0{i}][hv1{i}][hv2{i}][hv3{i}];\n                 [hv0{i}][vf0{i}][hv1{i}]hstack=inputs=3[rt{i}];[hf0{i}][tn{i}][hf1{i}]hstack=inputs=3[rm{i}];[hv2{i}][vf1{i}][hv3{i}]hstack=inputs=3[rb{i}];\n                 [rt{i}][rm{i}][rb{i}]vstack=inputs=3,{},crop={w2}:{h2}:{ox2}:{oy2},scale={w}:{h}:flags=bilinear[wv{i}];\n                 [thm{i}]trim=end_frame=1,scale={w4}:{h4},format=gray,lut=c0=255,split[nw{i}][nc{i}];[nc{i}]crop={r4}:{r4}:0:0,{}[ncp{i}];\n                 {}[nr{i}]pad={cw4}:{ch4}:{}:{}:black,split=9[q0{i}][q1{i}][q2{i}][q3{i}][qx{i}][q5{i}][q6{i}][q7{i}][q8{i}];[qx{i}]lut=c0=0[q4{i}];\n                 [q0{i}][q1{i}][q2{i}]hstack=inputs=3[qt{i}];[q3{i}][q4{i}][q5{i}]hstack=inputs=3[qm{i}];[q6{i}][q7{i}][q8{i}]hstack=inputs=3[qb{i}];\n                 [qt{i}][qm{i}][qb{i}]vstack=inputs=3,tpad=stop_mode=clone:stop_duration={d:.4},{},crop={w4}:{h4}:{ox4}:{oy4},scale={w}:{h}:flags=bilinear[nmk{i}];\n                 [wv{i}]format=yuva420p[wva{i}];[wva{i}][nmk{i}]alphamerge,fade=t=in:st=0:d={fade:.4}:alpha=1[nb{i}];\n                 [thc{i}]split[cpic{i}][cal{i}];[cal{i}]scale,format=gray,lut=c0=255,split[cw{i}][cc{i}];[cc{i}]crop={radius}:{radius}:0:0,{}[ccp{i}];\n                 {}[cpic{i}]scale,format=yuva420p[cpa{i}];[cpa{i}][cmk{i}]alphamerge,pad=iw+4:ih+4:2:2:color=black@0,perspective={centre}:sense=destination:eval=frame,crop={w}:{h}:2:2,fade=t=in:st=0:d={fade:.4}:alpha=1[tcv{i}];\n                 [old{i}][nb{i}]overlay=eof_action=pass[tn2{i}];[tn2{i}][tcv{i}]overlay=eof_action=pass[tr{i}];",
                g2 / 2,
                g2 / 2,
                wall_persp(3 * cw2, 3 * ch2),
                corner_geq(&r4.to_string()),
                four_corners(&format!("nw{i}"), &format!("ncp{i}"), &format!("nr{i}"), w4, h4, r4, "nk"),
                g4 / 2,
                g4 / 2,
                wall_persp(3 * cw4, 3 * ch4),
                corner_geq(&centre_r),
                four_corners(&format!("cw{i}"), &format!("ccp{i}"), &format!("cmk{i}"), w, h, radius, "ck"),
                fade = 0.12 * d,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // Every pad label in a graph: how often it's produced (after a filter) and consumed (before one).
    fn pad_counts(graph: &str) -> (HashMap<String, usize>, HashMap<String, usize>) {
        let (mut made, mut used) = (HashMap::new(), HashMap::new());
        for chain in graph.split(';').map(str::trim).filter(|c| !c.is_empty()) {
            let mut rest = chain;
            // Leading [labels] are inputs.
            while let Some(r) = rest.strip_prefix('[') {
                let end = r.find(']').unwrap();
                *used.entry(r[..end].to_string()).or_insert(0) += 1;
                rest = &r[end + 1..];
            }
            // Trailing [labels] are outputs (quoted option text never ends a chain).
            let mut tail = rest;
            while tail.ends_with(']') {
                let start = tail.rfind('[').unwrap();
                *made.entry(tail[start + 1..tail.len() - 1].to_string()).or_insert(0) += 1;
                tail = &tail[..start];
            }
        }
        (made, used)
    }

    #[test]
    fn every_canvas_transition_wires_old_and_head_into_tr() {
        let looks = [
            TransitionLook::default(),
            TransitionLook { direction: Some("down".into()), orientation: Some("horizontal".into()), shape: Some("star".into()), ..Default::default() },
            TransitionLook { direction: Some("right".into()), shape: Some("heart".into()), color: Some("#336699".into()), ..Default::default() },
        ];
        for name in CANVAS_TRANSITIONS {
            for look in &looks {
                for size in [(1920, 1080), (1080, 1920), (640, 360)] {
                    let g = canvas_transition(name, 3, 0.7, 30.0, size, look);
                    let (made, used) = pad_counts(&g);
                    assert_eq!(used.get("old3"), Some(&1), "{name}: [old3] read once\n{g}");
                    assert_eq!(used.get("head3"), Some(&1), "{name}: [head3] read once\n{g}");
                    assert_eq!(made.get("tr3"), Some(&1), "{name}: [tr3] made once\n{g}");
                    for (label, n) in &made {
                        assert_eq!(*n, 1, "{name}: [{label}] made {n} times");
                        if label != "tr3" {
                            assert_eq!(used.get(label), Some(&1), "{name}: [{label}] made but read {:?} times\n{g}", used.get(label));
                        }
                    }
                    for label in used.keys() {
                        assert!(label == "old3" || label == "head3" || made.contains_key(label), "{name}: [{label}] read but never made\n{g}");
                    }
                }
            }
        }
    }

    #[test]
    fn animated_blurs_drive_both_axes() {
        // gblur copies sigma into sigmaV only at init, so every per-frame sigma command needs a
        // matching sigmaV one (else the blur stays horizontal, unlike the preview's CSS blur).
        for name in ["whip", "zoomblur", "spin"] {
            let g = crate::commands::conversion::transition_window_graph_for_tests(name, 1, 0.6, 30.0, (640, 360));
            let (h, v) = (g.matches(" sigma ").count(), g.matches(" sigmaV ").count());
            assert!(h > 0 && h == v, "{name}: {h} sigma vs {v} sigmaV commands");
        }
    }

    #[test]
    fn grid_matches_the_preview() {
        // transitionCanvas.ts gridSize: four cells across the short side.
        assert_eq!(grid_size(1920, 1080), (7, 4));
        assert_eq!(grid_size(1080, 1920), (4, 7));
        assert_eq!(grid_size(1080, 1080), (4, 4));
    }

    // Not a unit test: renders every canvas transition between two coloured test patterns with the
    // bundled ffmpeg in $FFMPEG_DIR, checking each runs and that the result keeps its colour (a
    // `format=gray` straight after a `split` once turned whole transitions grey).
    #[test]
    #[ignore]
    fn canvas_transitions_render_in_colour() {
        let Ok(bin) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = std::path::PathBuf::from(&bin).join("ffmpeg.exe");
        for name in CANVAS_TRANSITIONS {
            let body = canvas_transition(name, 1, 0.5, 30.0, (320, 180), &TransitionLook::default());
            let graph = format!(
                "testsrc2=s=320x180:r=30:d=0.5,format=yuv420p,settb=AVTB[old1];smptebars=s=320x180:r=30:d=0.5,format=yuv420p,settb=AVTB[head1];{body}[tr1]select='eq(n,7)',format=yuv444p,extractplanes=u,signalstats,metadata=print:key=lavfi.signalstats.YMAX"
            );
            let out = std::process::Command::new(&ffmpeg).args(["-v", "info", "-hide_banner", "-filter_complex", &graph, "-f", "null", "-"]).output().unwrap();
            let log = String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success(), "{name}: {log}");
            let umax: f64 = log.lines().find_map(|l| l.split("YMAX=").nth(1)).and_then(|v| v.trim().parse().ok()).unwrap_or(0.0);
            assert!(umax > 160.0, "{name}: chroma flat (U max {umax}) - rendered grey?");
        }
    }
}
