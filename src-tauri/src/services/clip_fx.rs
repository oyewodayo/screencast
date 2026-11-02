// services/clip_fx.rs
//
// Export of a clip's effect (Clip.fx - echo, RGB split, colour cycle, focus in, colour in, flicker):
// a graph fragment laid over the segment's finished picture, [input] -> [out], before the vignette
// preset's layer - where the preview's ClipFxLayer draws it. Every curve is clipFx.ts's, evaluated
// on the segment's own clock (t from 0 at its first frame, on the output timeline).
//
// Colour changes over time are colorchannelmixer matrices switched per step by sendcmd (a matrix
// multiply per pixel - no per-pixel expressions); colour maps run in RGBA, where the CSS filter they
// mirror (hue-rotate, saturate, grayscale, brightness) is exactly a 3x3 matrix.
use crate::commands::conversion::{compose_css_color_ops, sendcmd_series, CssColorOp};
use serde::Deserialize;
use std::f64::consts::PI;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipFx {
    // Only ever matched against known names - never interpolated.
    pub kind: String,
    pub intensity: f64,
}

type Mat = [[f64; 3]; 3];
const IDENTITY: Mat = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn smooth(x: f64) -> f64 {
    let c = x.clamp(0.0, 1.0);
    c * c * (3.0 - 2.0 * c)
}

// transitionCanvas.ts's indexHash.
fn index_hash(n: f64) -> f64 {
    let x = (n * 127.1 + 311.7).sin() * 43758.5453;
    x - x.floor()
}

fn css_matrix(ops: &[CssColorOp]) -> Mat {
    compose_css_color_ops(ops).0
}

fn lerp_mat(a: &Mat, b: &Mat, k: f64) -> Mat {
    let mut m = [[0.0; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            m[r][c] = a[r][c] + (b[r][c] - a[r][c]) * k;
        }
    }
    m
}

const MIX_PARAMS: [&str; 9] = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];

// colorchannelmixer options for a matrix.
fn mix_options(m: &Mat) -> String {
    MIX_PARAMS.iter().enumerate().map(|(n, p)| format!("{p}={:.6}", m[n / 3][n % 3])).collect::<Vec<_>>().join(":")
}

// A sendcmd switching `target`'s matrix at each (time, matrix) - only where it changes.
fn matrix_series(target: &str, steps: &[(f64, Mat)]) -> String {
    let mut cmds = Vec::new();
    let mut last: Option<String> = None;
    for (t, m) in steps {
        let set: Vec<String> = MIX_PARAMS.iter().enumerate().map(|(n, p)| format!("{target} {p} {:.6}", m[n / 3][n % 3])).collect();
        let joined = set.join(",");
        if last.as_deref() != Some(joined.as_str()) {
            cmds.push(format!("{t:.4} {joined}"));
            last = Some(joined);
        }
    }
    format!("sendcmd=c='{}'", cmds.join(";"))
}

// A colour-matrix chain whose matrix follows `steps` over time.
fn matrix_chain(input: &str, out: &str, tag: &str, steps: &[(f64, Mat)]) -> String {
    let first = steps.first().map(|s| s.1).unwrap_or(IDENTITY);
    format!("[{input}]format=rgba,{},colorchannelmixer@{tag}={}:aa=1,format=yuv420p[{out}];", matrix_series(&format!("colorchannelmixer@{tag}"), steps), mix_options(&first))
}

// The graph for `fx` over a segment `duration` seconds long (frame w x h), or None for an unknown
// effect or one switched off.
pub fn clip_fx_graph(fx: &ClipFx, input: &str, out: &str, (w, h): (i64, i64), duration: f64, i: usize) -> Option<String> {
    let k = fx.intensity.clamp(0.0, 1.0);
    if k <= 0.0 {
        return None;
    }
    let (wf, hf) = (w as f64, h as f64);
    let mn = wf.min(hf);
    let duration = duration.max(0.1);
    Some(match fx.kind.as_str() {
        "echo" => {
            // Two blurred, see-through copies swaying either side (echoOffset, echoBlur, echoAlpha).
            let dx = format!("{wf}*{:.5}*(1+0.25*sin(2*PI*t/1.6))", 0.06 + 0.06 * k);
            let sigma = 0.012 * mn;
            let alpha = 0.22 + 0.2 * k;
            format!(
                "[{input}]split=3[fxa{i}][fxb{i}][fxc{i}];\
                 [fxb{i}]gblur=sigma={sigma:.3},format=yuva420p,lutyuv=a='val*{alpha:.4}'[fxg{i}];\
                 [fxc{i}]gblur=sigma={sigma:.3},format=yuva420p,lutyuv=a='val*{alpha:.4}'[fxh{i}];\
                 [fxa{i}][fxg{i}]overlay=x='{dx}':y=0[fxe{i}];[fxe{i}][fxh{i}]overlay=x='-({dx})':y=0[{out}];"
            )
        }
        "rgbsplit" => {
            let s = ((0.004 + 0.012 * k) * wf).round() as i64;
            format!("[{input}]rgbashift=rh={}:bh={s}:edge=smear,format=yuv420p[{out}];", -s)
        }
        "huecycle" => {
            // The hue steps 60 degrees every 0.3s, saturated a little, mixed in by the intensity.
            let steps: Vec<(f64, Mat)> = (0..=((duration / 0.3).ceil() as usize))
                .map(|n| {
                    let full = css_matrix(&[CssColorOp::HueRotate(((n * 60) % 360) as f64), CssColorOp::Saturate(1.25)]);
                    (n as f64 * 0.3, lerp_mat(&IDENTITY, &full, k))
                })
                .collect();
            matrix_chain(input, out, &format!("hc{i}"), &steps)
        }
        "focus" => {
            // Opens out of a blur over the first 0.8s (focusBlur).
            let peak = 0.035 * mn * (0.4 + 0.6 * k);
            let series = sendcmd_series(&format!("gblur@fc{i}"), &["sigma", "sigmaV"], 0.8, 30.0, |p| peak * (1.0 - smooth(p)));
            format!("[{input}]{series},gblur@fc{i}=sigma={peak:.3}:sigmaV={peak:.3}[{out}];")
        }
        "colorin" => {
            // Black and white flowing into colour over 0.6 + intensity seconds (colorInGray).
            let ramp = 0.6 + k;
            let frames = (ramp * 30.0).ceil() as usize;
            let steps: Vec<(f64, Mat)> = (0..=frames)
                .map(|n| {
                    let t = n as f64 / 30.0;
                    (t, css_matrix(&[CssColorOp::Grayscale(1.0 - smooth(t / ramp))]))
                })
                .collect();
            matrix_chain(input, out, &format!("ci{i}"), &steps)
        }
        "flicker" => {
            // Old-projector brightness, re-rolled 12 times a second (flickerBrightness).
            let steps: Vec<(f64, Mat)> = (0..=((duration * 12.0).ceil() as usize))
                .map(|n| {
                    let dip = if index_hash(n as f64 * 3.7) > 0.92 { 0.15 * k } else { 0.0 };
                    let b = 1.0 + 0.12 * k * (index_hash(n as f64) - 0.5) * 2.0 - dip;
                    (n as f64 / 12.0, css_matrix(&[CssColorOp::Brightness(b)]))
                })
                .collect();
            matrix_chain(input, out, &format!("fl{i}"), &steps)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_effect_reads_its_input_and_makes_its_output() {
        for kind in ["echo", "rgbsplit", "huecycle", "focus", "colorin", "flicker"] {
            let g = clip_fx_graph(&ClipFx { kind: kind.into(), intensity: 0.6 }, "v3fx", "v3", (1080, 1920), 4.0, 3).unwrap();
            assert!(g.starts_with("[v3fx]") && g.ends_with("[v3];"), "{kind}: {g}");
        }
        assert!(clip_fx_graph(&ClipFx { kind: "'; drop".into(), intensity: 1.0 }, "a", "b", (64, 64), 1.0, 0).is_none());
        assert!(clip_fx_graph(&ClipFx { kind: "echo".into(), intensity: 0.0 }, "a", "b", (64, 64), 1.0, 0).is_none());
    }

    #[test]
    fn the_colour_cycle_matches_css_hue_rotate() {
        // At full intensity the second step (60 degrees) is CSS hue-rotate(60deg) saturate(1.25).
        let g = clip_fx_graph(&ClipFx { kind: "huecycle".into(), intensity: 1.0 }, "i", "o", (64, 64), 1.0, 0).unwrap();
        let m = css_matrix(&[CssColorOp::HueRotate(60.0), CssColorOp::Saturate(1.25)]);
        assert!(g.contains(&format!("0.3000 colorchannelmixer@hc0 rr {:.6}", m[0][0])), "{g}");
        let _ = PI;
    }

    #[test]
    fn flicker_and_colour_in_settle() {
        let g = clip_fx_graph(&ClipFx { kind: "colorin".into(), intensity: 0.4 }, "i", "o", (64, 64), 5.0, 0).unwrap();
        // Ends on the identity once the ramp is over.
        assert!(g.contains("rr 1.000000,colorchannelmixer@ci0 rg 0.000000"), "{g}");
    }
}
