// Unit tests for conversion commands, filter graphs, and media helpers.
    #[test]
    fn duck_filter_is_local_to_the_overlay_and_skips_far_ranges() {
        let duck = DuckEnvelope { level: 0.25, attack: 0.25, release: 0.5, ranges: vec![[11.0, 13.0], [50.0, 51.0], [2.0, 3.0]] };
        // Overlay plays output 10..20: only the 11..13 range touches it, shifted to local 1..3.
        let f = super::duck_volume_filter(&duck, 10.0, 10.0).unwrap();
        assert_eq!(f, "volume='1-0.750*min(1,clip((t-0.750)/0.250,0,1)*clip((3.500-t)/0.500,0,1))':eval=frame");
        // A range starting before the overlay gives a "+" offset, never "--".
        let early = DuckEnvelope { ranges: vec![[9.0, 12.0]], ..duck };
        assert!(super::duck_volume_filter(&early, 10.0, 10.0).unwrap().contains("clip((t+1.250)/0.250"));
        let none = DuckEnvelope { level: 1.0, attack: 0.25, release: 0.5, ranges: vec![[11.0, 12.0]] };
        assert!(super::duck_volume_filter(&none, 10.0, 10.0).is_none());
    }

    use super::*;

    // The proxy must decode the photo once: no `-loop` input (which re-decodes the whole photo for
    // every frame - 26-32s per 64-megapixel phone photo, against ~0.8s), and the repeat done by the
    // `loop` filter after the fit, so it repeats the small fitted frame.
    #[test]
    fn image_clip_proxy_decodes_the_photo_once() {
        for blur in [false, true] {
            let args = image_clip_proxy_args("photo.jpg".into(), 1920, 1080, blur);
            assert!(!args.iter().any(|a| a == "-loop"), "no looped input: {args:?}");
            let i = args.iter().position(|a| a == "-i").unwrap();
            assert_eq!(args[i + 1], "photo.jpg");
            let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
            let fit_end = vf.find("format=yuv420p").expect("fitted first");
            let repeat = vf.find("loop=loop=59:size=1:start=0").expect("then repeated");
            assert!(repeat > fit_end, "the repeat comes after the fit: {vf}");
            assert!(vf.ends_with("setpts=N*10/TB"), "{vf}");
            // Same shape of file as before: 600s at one frame every 10s.
            let r = args.iter().position(|a| a == "-r").unwrap();
            assert_eq!(args[r + 1], "1/10");
            let t = args.iter().position(|a| a == "-t").unwrap();
            assert_eq!(args[t + 1], "600");
        }
    }

    // Bare-minimum KeepSegment with every optional field off - individual tests override just the
    // field(s) they care about via struct-update syntax (`..base_segment()`), so adding a new field
    // to KeepSegment later only means updating this one helper, not every test.
    fn base_segment() -> KeepSegment {
        KeepSegment {
            source_path: "clip.mp4".to_string(),
            start: 0.0,
            end: 10.0,
            color_filter: None,
            ken_burns: None,
            transition_in: None,
            crop: None,
            flip_horizontal: None,
            speed: None,
            noise_reduction: None,
            audio_cleanup: None,
            lut_cube: None,
            stabilize: None,
            speed_steps: None,
            muted: None,
            pointer_layers: None,
            source_fps: None,
            fit_blur: None,
            prefitted: false,
            fx: None,
        }
    }

    #[test]
    fn an_overlay_frame_sequence_counts_as_present_when_its_first_frame_is() {
        let frames = OverlayFrames { unique: vec![BASE64.encode([137u8, 80, 78, 71])], sequence: vec![0, 0, 0], fps: None };
        let mut created = Vec::new();
        let pattern = write_temp_overlay_sequence(&frames, 9_999, &mut created).expect("frames written");
        let input = InputSpec { path: pattern.clone(), pre_args: vec!["-framerate".into(), "30".into(), "-start_number".into(), "0".into()] };
        assert!(!PathBuf::from(&pattern).exists(), "the pattern itself is not a file");
        assert!(input.existing_path().exists(), "{pattern}");
        for path in &created {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn a_muted_clip_renders_silence_of_its_own_length() {
        let seg = KeepSegment { muted: Some(true), end: 4.0, ..base_segment() };
        assert!(segment_needs_filter_graph(&seg));
        let audio = segment_audio_chain(true, 2, &seg, &(vec![], None), "a2");
        assert!(audio.starts_with("anullsrc") && audio.contains("duration=4.000"), "{audio}");
    }

    // ---- segment_speed / segment_noise_reduction_db --------------------------------------------

    #[test]
    fn segment_speed_defaults_to_1x_when_unset() {
        assert_eq!(segment_speed(&base_segment()), 1.0);
    }

    #[test]
    fn segment_speed_clamps_to_0_25_16_range() {
        let mut seg = base_segment();
        seg.speed = Some(100.0);
        assert_eq!(segment_speed(&seg), 16.0);
        seg.speed = Some(0.001);
        assert_eq!(segment_speed(&seg), 0.25);
        seg.speed = Some(1.5);
        assert_eq!(segment_speed(&seg), 1.5);
    }

    #[test]
    fn segment_noise_reduction_db_is_none_when_off() {
        let seg = base_segment();
        assert_eq!(segment_noise_reduction_db(&seg), None);

        let mut zero = base_segment();
        zero.noise_reduction = Some(0.0);
        assert_eq!(segment_noise_reduction_db(&zero), None);
    }

    #[test]
    fn segment_noise_reduction_db_maps_0_to_1_onto_4_to_40_db() {
        let mut seg = base_segment();
        seg.noise_reduction = Some(1.0);
        assert_eq!(segment_noise_reduction_db(&seg), Some(40.0));

        seg.noise_reduction = Some(0.5);
        assert_eq!(segment_noise_reduction_db(&seg), Some(22.0));

        // Clamped even if a stale/hand-edited sidecar carries an out-of-range value.
        seg.noise_reduction = Some(5.0);
        assert_eq!(segment_noise_reduction_db(&seg), Some(40.0));
        seg.noise_reduction = Some(-5.0);
        assert_eq!(segment_noise_reduction_db(&seg), None);
    }

    #[test]
    fn segment_noise_reduction_params_maps_0_to_1_onto_the_full_nr_nf_pair() {
        let mut seg = base_segment();
        seg.noise_reduction = Some(1.0);
        assert_eq!(segment_noise_reduction_params(&seg), Some((40.0, -20.0)));

        seg.noise_reduction = Some(0.5);
        assert_eq!(segment_noise_reduction_params(&seg), Some((22.0, -35.0)));

        seg.noise_reduction = Some(0.0);
        assert_eq!(segment_noise_reduction_params(&seg), None);
    }

    // ---- segment_needs_filter_graph ---------------------------------------------------------------

    #[test]
    fn segment_needs_filter_graph_is_false_for_a_plain_trim() {
        assert!(!segment_needs_filter_graph(&base_segment()));
    }

    #[test]
    fn segment_needs_filter_graph_is_true_for_noise_reduction_alone() {
        // Regression case: a single-segment timeline whose ONLY edit is noise reduction (no crop,
        // speed, color grade, etc.) used to be misclassified as needing no filter graph at all,
        // which meant export_trimmed_video's fast -ss/-to path was taken and afftdn never got
        // applied - see this function's own doc comment.
        let mut seg = base_segment();
        seg.noise_reduction = Some(0.5);
        assert!(segment_needs_filter_graph(&seg));

        // 0/None must still count as "off", same convention segment_noise_reduction_db itself uses.
        let mut off = base_segment();
        off.noise_reduction = Some(0.0);
        assert!(!segment_needs_filter_graph(&off));
    }

    // ---- atempo_chain ---------------------------------------------------------------------------

    #[test]
    fn atempo_chain_1x_is_a_single_noop_stage() {
        assert_eq!(atempo_chain(1.0), "atempo=1.0000");
    }

    #[test]
    fn atempo_chain_within_single_instance_range_needs_no_chaining() {
        assert_eq!(atempo_chain(2.0), "atempo=2.0000");
        assert_eq!(atempo_chain(0.5), "atempo=0.5000");
        assert_eq!(atempo_chain(1.37), "atempo=1.3700");
    }

    #[test]
    fn atempo_chain_above_2x_splits_into_two_stages() {
        // 4.0 -> one atempo=2.0 stage, remaining 2.0 -> loop condition is `> 2.0` so exactly 2.0
        // stops there, leaving a second atempo=2.0000 stage for the remainder.
        assert_eq!(atempo_chain(4.0), "atempo=2.0000,atempo=2.0000");
    }

    #[test]
    fn atempo_chain_below_0_5x_splits_into_two_stages() {
        assert_eq!(atempo_chain(0.25), "atempo=0.5000,atempo=0.5000");
    }

    // ---- sanitizers - the security-boundary functions --------------------------------------------

    #[test]
    fn sanitize_transition_name_passes_through_allowed_values() {
        assert_eq!(sanitize_transition_name("wipeleft"), "wipeleft");
        assert_eq!(sanitize_transition_name("dissolve"), "dissolve");
    }

    #[test]
    fn sanitize_transition_name_falls_back_to_fade_for_anything_else() {
        assert_eq!(sanitize_transition_name("fade"), "fade");
        assert_eq!(sanitize_transition_name(""), "fade");
        assert_eq!(sanitize_transition_name("'; DROP TABLE clips; --"), "fade");
    }

    #[test]
    fn pop_scales_from_nothing_past_full_size_and_back() {
        let s = overlay_pop_scale_expr(1.0, 3.0, "t");
        // The preview's ease-out-back over a 0.4s ramp at each end.
        assert!(s.contains("clip(min((t-1.000)/0.4000,(3.000-t)/0.4000),0,1)") && s.contains("2.70158*pow("), "{s}");
        // A very short overlay ramps over half its length, as the preview does.
        assert!(overlay_pop_scale_expr(1.0, 1.5, "t").contains("/0.2500"));
    }

    #[test]
    fn sanitize_overlay_animation_passes_through_allowed_values_only() {
        assert_eq!(sanitize_overlay_animation("slide-left"), "slide-left");
        assert_eq!(sanitize_overlay_animation("pop"), "pop"); // burned in as a per-frame scale
        assert_eq!(sanitize_overlay_animation("anything-else"), "none");
    }

    #[test]
    fn pip_crop_fragment_skips_full_frame_and_clamps() {
        assert_eq!(pip_crop_fragment(None), "");
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 })),
            ""
        );
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.25, y: 0.1, width: 0.5, height: 0.8 })),
            "crop=w=iw*0.500000:h=ih*0.800000:x=iw*0.250000:y=ih*0.100000,"
        );
        // Zero-area and overflowing crops are clamped rather than handed to ffmpeg as-is.
        assert_eq!(
            pip_crop_fragment(Some(PipCrop { x: 0.99, y: 0.0, width: 0.0, height: 1.0 })),
            "crop=w=iw*0.050000:h=ih*1.000000:x=iw*0.950000:y=ih*0.000000,"
        );
        assert_eq!(pip_crop_fragment(Some(PipCrop { x: f64::NAN, y: 0.0, width: 0.5, height: 0.5 })), "");
    }

    #[test]
    fn sanitize_pip_shape_passes_through_allowed_values_only() {
        assert_eq!(sanitize_pip_shape("circle"), "circle");
        assert_eq!(sanitize_pip_shape("rounded"), "rounded");
        assert_eq!(sanitize_pip_shape("hexagon"), "rectangle");
    }

    // ---- color_filter_chain / ken_burns_chain / crop_chain ---------------------------------------

    #[test]
    fn color_filter_chain_none_preset_is_a_noop() {
        let cf = ClipColorFilter {
            preset: "none".to_string(),
            intensity: 0.7,
        };
        assert_eq!(color_filter_chain(&cf), "");
    }

    #[test]
    fn color_filter_chain_bw_at_full_intensity_is_css_grayscale() {
        let cf = ClipColorFilter {
            preset: "bw".to_string(),
            intensity: 1.0,
        };
        // CSS grayscale(1): every channel = 0.2126 R + 0.7152 G + 0.0722 B.
        let chain = color_filter_chain(&cf);
        assert!(chain.starts_with(",format=rgba,colorchannelmixer=rr=0.212600:rg=0.715200:rb=0.072200:ra=0.000000:gr=0.212600:"), "{chain}");
        assert!(chain.ends_with(":aa=1,format=yuv420p"), "{chain}");
    }

    #[test]
    fn color_filter_chain_clamps_out_of_range_intensity() {
        let over = ClipColorFilter { preset: "bw".to_string(), intensity: 5.0 };
        let full = ClipColorFilter { preset: "bw".to_string(), intensity: 1.0 };
        assert_eq!(color_filter_chain(&over), color_filter_chain(&full)); // clamped to 1.0
        // Clamped to 0: grayscale(0) is the identity.
        let under = ClipColorFilter { preset: "bw".to_string(), intensity: -5.0 };
        assert!(color_filter_chain(&under).contains("rr=1.000000:rg=0.000000:rb=0.000000:ra=0.000000"), "{}", color_filter_chain(&under));
    }

    #[test]
    fn css_color_ops_compose_like_the_browser() {
        // contrast then saturate: M = S*C, o = S*(0.5-0.5c) - an affine map, applied in one pass.
        let (m, o) = compose_css_color_ops(&[CssColorOp::Contrast(2.0), CssColorOp::Saturate(1.0)]);
        assert!((m[0][0] - 2.0).abs() < 1e-9 && m[0][1].abs() < 1e-9 && (o[0] + 0.5).abs() < 1e-9);
        // A grey stays grey through any saturate / hue-rotate (their rows sum to 1).
        let (m, o) = compose_css_color_ops(&[CssColorOp::Saturate(1.6), CssColorOp::HueRotate(37.0)]);
        for r in 0..3 {
            assert!(((m[r][0] + m[r][1] + m[r][2]) * 0.4 + o[r] - 0.4).abs() < 1e-6);
        }
        // Every preset at zero intensity is the identity (only cinematic's fixed hue nudge isn't).
        for preset in ["vibrant", "bw", "warm", "cool"] {
            let chain = color_filter_chain(&ClipColorFilter { preset: preset.to_string(), intensity: 0.0 });
            assert!(chain.contains("rr=1.000000:rg=0.000000:rb=0.000000:ra=0.000000:gr=0.000000:gg=1.000000"), "{preset}: {chain}");
        }
    }

    #[test]
    fn a_vignette_is_a_layer_over_the_finished_frame() {
        let mut seg = base_segment();
        seg.color_filter = Some(ClipColorFilter { preset: "vignette".to_string(), intensity: 1.0 });
        let (end, graph) = segment_vignette(&seg, Some(1280), Some(720), "v2", 2);
        assert_eq!(end, "v2nv");
        assert!(graph.starts_with("color=black:s=320x180:") && graph.ends_with("[v2nv][vig2]overlay=shortest=1:format=auto[v2];"), "{graph}");
        // Not a colour map, and without a frame size, ffmpeg's own vignette.
        assert_eq!(color_filter_chain(seg.color_filter.as_ref().unwrap()), "");
        assert!(segment_effect_chain(&seg, None, None, false, None, None, None).contains(",vignette="));
        assert!(!segment_effect_chain(&seg, Some(1280), Some(720), false, None, None, None).contains("vignette"));
    }

    #[test]
    fn segments_seek_to_just_before_what_they_use() {
        let mut seg = base_segment();
        seg.start = 600.0;
        seg.end = 620.0;
        assert_eq!(segment_input_seek(&seg), 599.0);
        // A noise sample earlier in the file pulls the seek back to it.
        seg.audio_cleanup = Some(AudioCleanup { noise_sample: Some(NoiseSample { start: 100.0, end: 101.0 }), ..Default::default() });
        assert_eq!(segment_input_seek(&seg), 99.0);
        seg.speed_steps = Some(vec![SpeedStep { source_start: 600.0, source_end: 610.0, speed: 2.0 }]);
        shift_segment_times(&mut seg, 99.0);
        assert_eq!((seg.start, seg.end), (501.0, 521.0));
        assert_eq!(seg.speed_steps.as_ref().unwrap()[0].source_start, 501.0);
        let sample = seg.audio_cleanup.as_ref().unwrap().noise_sample.unwrap();
        assert_eq!((sample.start, sample.end), (1.0, 2.0));
        // Near the file's start, and stills: no seek.
        seg.start = 0.4;
        seg.audio_cleanup = None;
        assert_eq!(segment_input_seek(&seg), 0.0);
        seg.source_path = "photo.jpg".into();
        seg.start = 300.0;
        assert_eq!(segment_input_seek(&seg), 0.0);
        assert_eq!(trim_input_seek(42.5), 41.5);
        assert_eq!(trim_input_seek(0.3), 0.0);
    }

    #[test]
    fn overlays_animate_at_the_videos_rate_up_to_sixty() {
        assert_eq!(overlay_rate(60.0), 60.0);
        assert_eq!(overlay_rate(30000.0 / 1001.0), 30000.0 / 1001.0);
        assert_eq!(overlay_rate(25.0), 25.0);
        assert_eq!(overlay_rate(120.0), MAX_OVERLAY_FPS);
        assert_eq!(overlay_rate(0.0), DEFAULT_OVERLAY_FPS);
        assert_eq!(overlay_rate(f64::NAN), DEFAULT_OVERLAY_FPS);
        // A sequence keeps the rate it was drawn at; one from before the rate was sent is 30fps.
        let frames = |fps: Option<f64>| OverlayFrames { unique: vec![], sequence: vec![], fps };
        assert_eq!(frames(Some(60.0)).rate(), 60.0);
        assert_eq!(frames(None).rate(), DEFAULT_OVERLAY_FPS);
        assert_eq!(frames(Some(240.0)).rate(), MAX_OVERLAY_FPS);
        assert_eq!(frames(Some(-1.0)).rate(), DEFAULT_OVERLAY_FPS);
        let parsed: OverlayFrames = serde_json::from_str(r#"{"unique":[],"sequence":[]}"#).unwrap();
        assert_eq!(parsed.rate(), DEFAULT_OVERLAY_FPS);
        // An all-image timeline has no video rate to follow.
        assert_eq!(export_video_fps(&PathBuf::from("ffprobe-not-needed"), ["a.png", "b.HEIC"]), IMAGE_SEGMENT_FPS);
    }

    #[test]
    fn keyframed_opacity_is_per_frame_commands_only_where_it_changes() {
        let kf = |time: f64, opacity: f64| OverlayKeyframe { time, x: 0.0, y: 0.0, scale: 1.0, opacity, easing: "linear".into() };
        let cmds = opacity_commands(&[kf(10.0, 0.0), kf(11.0, 1.0)], "colorchannelmixer@ka0", 10.0, 60.0, 30.0);
        assert!(cmds.starts_with("sendcmd=c='10.0000 colorchannelmixer@ka0 aa 0.0000;"), "{cmds}");
        assert!(cmds.ends_with("11.0000 colorchannelmixer@ka0 aa 1.0000'"), "{cmds}");
        // 31 frames across the fade, nothing for the 49s it then holds.
        assert_eq!(cmds.matches("aa ").count(), 31, "{cmds}");
        // A 60fps overlay fades in every one of its frames.
        let cmds60 = opacity_commands(&[kf(10.0, 0.0), kf(11.0, 1.0)], "colorchannelmixer@ka0", 10.0, 60.0, 60.0);
        assert_eq!(cmds60.matches("aa ").count(), 61, "{cmds60}");
        assert!((keyframe_value(&[kf(0.0, 0.0), kf(2.0, 1.0)], 0.5, |k| k.opacity) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn crop_chain_clamps_position_so_the_window_never_crosses_the_far_edge() {
        // x=0.9 with width=0.5 would crop past the right edge (0.9+0.5 > 1.0) - x must clamp to
        // 1.0-width=0.5, not the raw 0.9 the caller passed.
        let c = ClipCrop {
            x: 0.9,
            y: 0.0,
            width: 0.5,
            height: 0.5,
        };
        assert_eq!(
            crop_chain(&c),
            ",crop=w='iw*0.5000':h='ih*0.5000':x='iw*0.5000':y='ih*0.0000'"
        );
    }

    #[test]
    fn crop_chain_rejects_a_degenerate_near_zero_area_crop() {
        let c = ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        // width/height floor at 0.05, never truly 0.
        assert_eq!(
            crop_chain(&c),
            ",crop=w='iw*0.0500':h='ih*0.0500':x='iw*0.0000':y='ih*0.0000'"
        );
    }

    #[test]
    fn ken_burns_chain_unrecognized_preset_is_a_noop() {
        let kb = ClipKenBurns {
            preset: "sparkle".to_string(),
            intensity: None,
            target_x: None,
            target_y: None,
            span: None,
        };
        assert_eq!(ken_burns_chain(&kb, 5.0, 1920, 1080, 30.0), "");
    }

    #[test]
    fn every_ken_burns_motion_animates_per_frame_on_the_source_clock() {
        for preset in [
            "zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "push", "punch-in", "bounce-in", "drift", "sway", "float", "breathe", "pulse",
            "shake", "vibrate",
        ] {
            let kb = ClipKenBurns { preset: preset.to_string(), intensity: Some(0.7), target_x: None, target_y: None, span: None };
            let chain = ken_burns_chain(&kb, 4.0, 1280, 720, 29.97);
            // Held to the source rate first, so the frame number is an exact clock.
            assert!(chain.starts_with(",fps=29.9700,perspective=x0='"), "{preset}: {chain}");
            assert!(chain.contains("(in-1)/29.9700/4.0000") && chain.contains(":eval=frame"), "{preset}: {chain}");
            assert!(chain.ends_with(",scale=1280:720"), "{preset}: {chain}");
        }
    }

    #[test]
    fn ken_burns_chain_zoom_in_ends_at_the_scaled_output_resolution() {
        let kb = ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(1.0),
            target_x: None,
            target_y: None,
            span: None,
        };
        let chain = ken_burns_chain(&kb, 5.0, 1920, 1080, 30.0);
        assert!(
            chain.contains(",perspective="),
            "expected a per-frame perspective window, got: {chain}"
        );
        assert!(
            chain.ends_with(",scale=1920:1080"),
            "expected a trailing scale to output resolution, got: {chain}"
        );
    }

    #[test]
    fn ken_burns_chain_continues_a_split_move_over_its_span() {
        let kb = ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(1.0),
            target_x: None,
            target_y: None,
            span: Some([0.5, 1.0]),
        };
        let chain = ken_burns_chain(&kb, 4.0, 1920, 1080, 30.0);
        assert!(chain.contains("(0.500000+0.500000*min((in-1)/30.0000/4.0000,1))"), "{chain}");
    }

    #[test]
    fn loudness_search_lands_on_a_limited_curve() {
        // A limiter wall: 1:1 up to -16 LUFS, then only 0.15 LU per dB.
        let curve = |g: f64| {
            let raw = -30.0 + g;
            if raw < -16.0 { raw } else { -16.0 + 0.15 * (raw + 16.0) }
        };
        let mut evals = 0;
        let (gain, result) = search_loudness_gain(-14.0, 16.0, |g| { evals += 1; Ok(curve(g)) }).unwrap();
        assert!((result + 14.0).abs() <= LOUDNESS_TOLERANCE_LU, "result {result} gain {gain} after {evals}");
        assert!(evals <= LOUDNESS_MAX_SEARCH_PASSES);
    }

    #[test]
    fn loudness_search_stops_at_the_gain_limit_when_unreachable() {
        let (gain, result) = search_loudness_gain(-5.0, 20.0, |g| Ok(-40.0 + 0.2 * g)).unwrap();
        assert!((gain - LOUDNESS_MAX_GAIN_DB).abs() < 1e-9);
        assert!((result - (-40.0 + 0.2 * LOUDNESS_MAX_GAIN_DB)).abs() < 1e-9);
    }

    #[test]
    fn loudness_chain_is_one_shape_for_every_gain() {
        assert_eq!(loudness_chain(-1.0, LOUDNESS_LIMIT), "volume=-1.000dB,alimiter=limit=0.79000:attack=2:release=8:level=false:latency=1");
        assert!(loudness_chain(12.0, LOUDNESS_LIMIT).starts_with("volume=12.000dB,alimiter"));
    }

    #[test]
    fn loudness_pass_never_limits_above_the_master_ceiling() {
        assert_eq!(loudness_limit(None), LOUDNESS_LIMIT);
        assert!((loudness_limit(Some(0.5)) - 0.5).abs() < 1e-12);
        assert_eq!(loudness_limit(Some(1.0)), LOUDNESS_LIMIT);
    }

    #[test]
    fn master_bus_filters_trim_then_limit_at_four_times_the_rate() {
        assert!(master_audio_filters(None).is_empty());
        let neutral = MasterBusSpec { trim_db: Some(0.0), limiter: None };
        assert!(master_audio_filters(Some(&neutral)).is_empty());
        let m = MasterBusSpec { trim_db: Some(-3.0), limiter: Some(MasterLimiterSpec { ceiling_db: -1.0, release_ms: 60.0 }) };
        let f = master_audio_filters(Some(&m));
        assert_eq!(f[0], "volume=-3.000dB");
        assert_eq!(f[1], "aresample=192000,alimiter=limit=0.89125:attack=5:release=60.0:level=false:latency=1,aresample=48000");
    }

    #[test]
    fn automation_is_a_flat_sum_of_ramps_in_db() {
        assert!(automation_volume_filter(&[]).is_none());
        assert!(automation_volume_filter(&[[0.0, 0.0], [2.0, 0.0]]).is_none());
        let f = automation_volume_filter(&[[-1.0, -6.0], [2.0, 0.0], [3.0, 0.0], [4.0, -60.0]]).unwrap();
        assert_eq!(
            f,
            "asetnsamples=n=256:p=0,volume='pow(10,(-6.000+(6.000)*clip((t+1.000)/3.0000,0,1)+(-60.000)*clip((t-3.000)/1.0000,0,1))/20)':eval=frame"
        );
    }

    // ---- segment_effect_chain - ordering matters (mirrored in VideoPlayer.tsx's own preview) -----

    #[test]
    fn segment_effect_chain_applies_hflip_before_color_before_crop() {
        let mut seg = base_segment();
        seg.flip_horizontal = Some(true);
        seg.color_filter = Some(ClipColorFilter {
            preset: "bw".to_string(),
            intensity: 1.0,
        });
        seg.crop = Some(ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None);
        let hflip_pos = chain.find("hflip").expect("hflip missing");
        let color_pos = chain.find("colorchannelmixer").expect("color filter missing");
        let crop_pos = chain.find("crop=").expect("crop missing");
        assert!(
            hflip_pos < color_pos && color_pos < crop_pos,
            "wrong order: {chain}"
        );
    }

    #[test]
    fn segment_effect_chain_skips_the_extra_scale_when_ken_burns_will_scale_anyway() {
        let mut seg = base_segment();
        seg.crop = Some(ClipCrop {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        });
        seg.ken_burns = Some(ClipKenBurns {
            preset: "zoom-in".to_string(),
            intensity: Some(0.5),
            target_x: None,
            target_y: None,
            span: None,
        });
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None);
        // Exactly one scale=1920:1080 (Ken Burns' own trailing one), not two.
        assert_eq!(chain.matches("scale=1920:1080").count(), 1);
    }

    #[test]
    fn a_cropped_clip_comes_out_with_square_pixels() {
        // A narrow crop stretched back to the frame would carry a 19:60 SAR into concat, which then
        // refuses the next clip - the crop chain ends by squaring the pixels.
        let mut seg = base_segment();
        seg.crop = Some(ClipCrop {
            x: 0.34,
            y: 0.0,
            width: 0.32,
            height: 1.0,
        });
        let chain = segment_effect_chain(&seg, Some(1080), Some(1920), false, None, None, None);
        assert!(chain.ends_with(",setsar=1"), "{chain}");
    }

    #[test]
    fn segment_effect_chain_with_no_effects_is_empty() {
        assert_eq!(
            segment_effect_chain(&base_segment(), Some(1920), Some(1080), false, None, None, None),
            ""
        );
    }

    // ---- audio_trim_chain -----------------------------------------------------------------------

    #[test]
    fn audio_trim_chain_no_audio_synthesizes_silence_of_the_right_output_duration() {
        // 10 source seconds at 2x speed -> 5 output seconds.
        let chain = audio_trim_chain(false, 0, 0.0, 10.0, 2.0, &(vec![], None), "outa");
        assert_eq!(
            chain,
            "anullsrc=channel_layout=stereo:sample_rate=44100:duration=5.000[outa];"
        );
    }

    #[test]
    fn audio_trim_chain_with_audio_includes_tempo_but_no_denoise_when_off() {
        let chain = audio_trim_chain(true, 0, 1.0, 5.0, 1.0, &(vec![], None), "outa");
        assert_eq!(
            chain,
            "[0:a]atrim=start=1.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000[outa];"
        );
    }

    #[test]
    fn audio_trim_chain_appends_afftdn_after_atempo_when_noise_reduction_is_set() {
        let chain = audio_trim_chain(true, 2, 0.0, 5.0, 1.0, &(vec!["afftdn=nr=22.00:nf=-35.0".to_string()], None), "a2");
        assert_eq!(
            chain,
            "[2:a]atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS,atempo=1.0000,afftdn=nr=22.00:nf=-35.0[a2];"
        );
    }

    // ---- audio_cleanup_filters --------------------------------------------------------------------

    #[test]
    fn audio_cleanup_filters_is_empty_when_nothing_is_on() {
        assert!(audio_cleanup_filters(None, None, None).is_empty());
        assert!(audio_cleanup_filters(Some(0.0), Some(&AudioCleanup::default()), Some("m")).is_empty());
    }

    #[test]
    fn audio_cleanup_filters_orders_lowcut_hum_denoise_gate() {
        let cleanup = AudioCleanup { low_cut: Some(true), hum: Some(50), gate: Some(true), ..Default::default() };
        let f = audio_cleanup_filters(Some(0.5), Some(&cleanup), None);
        assert_eq!(f[0], "highpass=f=80");
        assert_eq!(&f[1..4], ["bandreject=f=50:t=q:w=8", "bandreject=f=100:t=q:w=8", "bandreject=f=150:t=q:w=8"]);
        assert_eq!(f[4], "afftdn=nr=22.00:nf=-35.0");
        assert!(f[5].starts_with("agate="));
    }

    #[test]
    fn audio_cleanup_filters_remove_mode_uses_arnndn_and_falls_back_without_a_model() {
        let cleanup = AudioCleanup { mode: Some("remove".into()), ..Default::default() };
        assert_eq!(audio_cleanup_filters(Some(1.0), Some(&cleanup), Some("C\\:/m.rnnn")), ["arnndn=m='C\\:/m.rnnn':mix=1.00", ARNNDN_NAN_GUARD]);
        assert_eq!(audio_cleanup_filters(Some(1.0), Some(&cleanup), None), ["afftdn=nr=40.00:nf=-20.0"]);
    }

    #[test]
    fn audio_cleanup_filters_appends_levelling_last() {
        let cleanup = AudioCleanup { gate: Some(true), level: Some(true), ..Default::default() };
        let f = audio_cleanup_filters(None, Some(&cleanup), None);
        assert!(f[0].starts_with("agate="));
        assert_eq!(&f[1..], ["speechnorm=e=4:r=0.0001:l=1", "loudnorm=I=-16:TP=-1.5:LRA=11", "aresample=48000"]);
    }

    #[test]
    fn noise_sample_learns_from_the_prefix_then_trims_it_off() {
        let cleanup = AudioCleanup { noise_sample: Some(NoiseSample { start: 5.3, end: 6.3 }), ..Default::default() };
        let sample = cleanup_noise_sample(Some(1.0), Some(&cleanup), None);
        assert_eq!(sample, Some((5.3, 6.3)));
        let f = audio_cleanup_filters_with_sample(Some(1.0), Some(&cleanup), None, sample.map(|(s, e)| e - s));
        assert_eq!(f[0], "asendcmd=c='0.000 afftdn sample_noise start;0.999 afftdn sample_noise stop'");
        assert_eq!(f[1], "afftdn=nr=40.00:nf=-28.0");
        assert_eq!(f[2], "atrim=start=1.000000");
        assert_eq!(f[3], "asetpts=PTS-STARTPTS");
        let branch = audio_branch("[0:a]", 0.0, 40.0, 1.0, &f, sample, "a0");
        assert!(branch.starts_with("[0:a]asplit=2[a0_m][a0_s];[a0_s]atrim=start=5.300:end=6.300"));
        assert!(branch.contains("[a0_n][a0_t]concat=n=2:v=0:a=1,asendcmd="));
        assert!(branch.ends_with("[a0];"));
    }

    #[test]
    fn noise_sample_is_ignored_when_off_too_short_or_in_remove_mode() {
        let mut cleanup = AudioCleanup { noise_sample: Some(NoiseSample { start: 1.0, end: 1.05 }), ..Default::default() };
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), None), None);
        cleanup.noise_sample = Some(NoiseSample { start: 1.0, end: 30.0 });
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), None), Some((1.0, 11.0)));
        assert_eq!(cleanup_noise_sample(Some(0.0), Some(&cleanup), None), None);
        cleanup.mode = Some("remove".into());
        assert_eq!(cleanup_noise_sample(Some(1.0), Some(&cleanup), Some("m")), None);
    }

    #[test]
    fn bucket_peaks_takes_per_channel_maxima() {
        let frames = [0.1, -0.5, -0.3, 0.2, 0.05, 0.0, 0.0, 0.9];
        assert_eq!(bucket_peaks(&frames, 2), vec![0.3, 0.5, 0.05, 0.9]);
    }

    #[test]
    fn audio_cleanup_filters_ignores_unknown_hum_frequencies() {
        let cleanup = AudioCleanup { hum: Some(55), ..Default::default() };
        assert!(audio_cleanup_filters(None, Some(&cleanup), None).is_empty());
    }

    #[test]
    fn escape_filter_path_escapes_drive_colon_and_backslashes() {
        assert_eq!(escape_filter_path(std::path::Path::new(r"C:\a\b.rnnn")), r"C\:/a/b.rnnn");
    }

    // ---- overlay animation expressions ------------------------------------------------------------

    #[test]
    fn overlay_position_expr_none_and_fade_are_static_coordinates() {
        let ov = OverlayImage {
            blend_mode: None,
            data_base64: String::new(),
            x: 100,
            y: 200,
            start_time: 0.0,
            end_time: 5.0,
            animation: "none".to_string(),
            keyframes: None,
            frames: None,
            on_frame: false,
        };
        assert_eq!(
            overlay_position_expr(&ov, "none"),
            ("100".to_string(), "200".to_string())
        );
        assert_eq!(
            overlay_position_expr(&ov, "fade"),
            ("100".to_string(), "200".to_string())
        );
    }

    #[test]
    fn overlay_position_expr_slide_left_only_animates_x() {
        let ov = OverlayImage {
            blend_mode: None,
            data_base64: String::new(),
            x: 100,
            y: 200,
            start_time: 0.0,
            end_time: 5.0,
            animation: "slide-left".to_string(),
            keyframes: None,
            frames: None,
            on_frame: false,
        };
        let (x, y) = overlay_position_expr(&ov, "slide-left");
        assert_eq!(y, "200"); // y untouched
        assert!(
            x.contains("main_w"),
            "expected an x expression referencing main_w, got: {x}"
        );
    }

    // ---- parse_duration / parse_silence_ranges - real ffmpeg stderr text shapes ------------------

    #[test]
    fn parse_duration_reads_the_standard_ffmpeg_banner_line() {
        let output = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n  Duration: 00:02:03.45, start: 0.000000, bitrate: 1234 kb/s\n";
        assert_eq!(parse_duration(output), Some(123.45));
    }

    #[test]
    fn parse_duration_returns_none_when_no_duration_line_present() {
        assert_eq!(parse_duration("some unrelated ffmpeg output\n"), None);
    }

    #[test]
    fn parse_silence_ranges_pairs_start_and_end_lines() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 12.345
[silencedetect @ 0x1] silence_end: 15.678 | silence_duration: 3.333
[silencedetect @ 0x1] silence_start: 20.0
[silencedetect @ 0x1] silence_end: 21.5 | silence_duration: 1.5
";
        let ranges = parse_silence_ranges(stderr);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].start, 12.345);
        assert_eq!(ranges[0].end, 15.678);
        assert_eq!(ranges[1].start, 20.0);
        assert_eq!(ranges[1].end, 21.5);
    }

    #[test]
    fn parse_silence_ranges_drops_a_trailing_unmatched_silence_start() {
        // The file ends while still silent - no matching silence_end line at all.
        let stderr = "[silencedetect @ 0x1] silence_start: 12.345\n";
        assert_eq!(parse_silence_ranges(stderr).len(), 0);
    }

    // ---- resolve_export_quality / should_convert_file / unique_output_path ------------------------

    #[test]
    fn resolve_export_quality_unrecognized_and_missing_both_fall_back_to_standard() {
        assert_eq!(resolve_export_quality(None), ("medium", "23"));
        assert_eq!(resolve_export_quality(Some("ultra")), ("medium", "23"));
        assert_eq!(resolve_export_quality(Some("high")), ("slow", "18"));
        assert_eq!(resolve_export_quality(Some("small")), ("veryfast", "28"));
    }

    #[test]
    fn platform_presets_map_to_their_encoders_and_limits() {
        assert_eq!(resolve_export_quality(Some("youtube")), ("slow", "18"));
        assert_eq!(export_hw_tier(Some("youtube")), Some("high"));
        assert_eq!(export_hw_tier(Some("social")), None);
        assert_eq!(export_hw_tier(None), Some("standard"));
        assert_eq!(export_audio_bitrate(Some("youtube")), "320k");
        assert_eq!(export_audio_bitrate(None), "128k");
        assert!(export_extra_video_args(Some("social")).windows(2).any(|w| w[0] == "-level:v" && w[1] == "4.0"));
        assert!(export_extra_video_args(None).is_empty());
        // Every export ends on standard-range 4:2:0; only "social" resizes, and only drops the
        // rate of a source above 30 fps.
        let plain = export_delivery_filter(None, 60.0);
        assert_eq!(plain, "scale=out_range=tv,format=yuv420p|nv12");
        assert!(export_delivery_filter(Some("social"), 60.0).contains("fps=30"));
        assert!(!export_delivery_filter(Some("social"), 30.0).contains("fps="));
        assert!(export_delivery_filter(Some("social"), 30.0).ends_with(&plain));
    }

    #[test]
    fn should_convert_file_flags_only_the_documented_extensions() {
        assert!(should_convert_file("clip.mkv".to_string()));
        assert!(should_convert_file("clip.MOV".to_string())); // case-insensitive
        assert!(!should_convert_file("clip.mp4".to_string()));
        assert!(!should_convert_file("no_extension".to_string()));
    }

    #[test]
    fn export_names_drop_earlier_export_suffixes_and_count_versions() {
        assert_eq!(super::export_base_name("Demo"), "Demo");
        assert_eq!(super::export_base_name("Demo (edited) (edited) (2)"), "Demo");
        assert_eq!(super::export_base_name("Demo - v3"), "Demo");
        assert_eq!(super::export_base_name("Demo (share-ready)"), "Demo");
        assert_eq!(super::export_base_name("Untitled video (8)"), "Untitled video (8)");
        let dir = std::env::temp_dir().join(format!("briefcast_versions_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(super::next_version_path(&dir, "Demo", "mp4"), dir.join("Demo - v1.mp4"));
        std::fs::write(dir.join("Demo - v1.mp4"), b"").unwrap();
        std::fs::write(dir.join("Demo - v4.mov"), b"").unwrap();
        std::fs::write(dir.join("Demo two - v9.mp4"), b"").unwrap();
        assert_eq!(super::next_version_path(&dir, "Demo", "mp4"), dir.join("Demo - v5.mp4"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_output_path_appends_a_counter_when_the_target_already_exists() {
        let dir = std::env::temp_dir().join(format!("briefcast_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.mp4");
        std::fs::write(&target, b"existing").unwrap();

        let resolved = unique_output_path(target.clone());
        assert_eq!(resolved, dir.join("out (1).mp4"));

        // With "out (1).mp4" ALSO taken, the next free slot is "(2)".
        std::fs::write(&resolved, b"existing").unwrap();
        assert_eq!(unique_output_path(target.clone()), dir.join("out (2).mp4"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_output_path_returns_the_path_unchanged_when_free() {
        let dir = std::env::temp_dir().join(format!("briefcast_test_free_{}", std::process::id()));
        let target = dir.join("brand_new.mp4"); // dir deliberately never created - can't exist
        assert_eq!(unique_output_path(target.clone()), target);
    }

    // Real round-trip against libheif's own CLI tools (not a pure-function unit test like the
    // ones above) - encodes a tiny synthetic image to HEIC with heif-enc, then decodes it back via
    // heic_unix::decode_to_png, and checks a valid same-size PNG comes out. This is the one part
    // of the macOS/Linux HEIC gap that CI can fully prove correctness for (not just compilation) -
    // see heic_unix.rs's own doc comment for why this needs a system-installed libheif rather than
    // a bundled one, and the CI workflow for the exact install step this test relies on.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn heic_unix_decode_round_trip_produces_a_valid_png() {
        use image::{GenericImageView, Rgb, RgbImage};

        let dir = std::env::temp_dir().join(format!("briefcast_test_heic_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Dimensions/content don't matter for proving the decode round-trip works - heif-enc just
        // needs *some* valid source image.
        let source_png = dir.join("source.png");
        let mut img = RgbImage::new(16, 16);
        for pixel in img.pixels_mut() {
            *pixel = Rgb([200, 100, 50]);
        }
        img.save(&source_png)
            .expect("failed to write synthetic source PNG");

        let heic_path = dir.join("source.heic");
        let encode = std::process::Command::new("heif-enc")
            .arg(&source_png)
            .arg("-o")
            .arg(&heic_path)
            .output()
            .expect(
                "heif-enc not found - install libheif's example tools to run this test locally \
                 (see heic_unix.rs's own doc comment for the exact package per OS)",
            );
        // Making the input needs an HEVC *encoder*, which is a separate plugin on newer
        // distributions (Ubuntu: libheif-plugin-x265) and absent from a bare libheif-examples. That
        // is a missing tool, not a decode bug - this test is about decoding - so it says so and
        // stops instead of failing. CI installs the plugin, so there it still runs.
        let encode_error = String::from_utf8_lossy(&encode.stderr).to_string();
        if !encode.status.success() && encode_error.contains("No HEVC encoder") {
            eprintln!("SKIPPED heic_unix round trip: heif-enc has no HEVC encoder here ({})", encode_error.trim());
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        assert!(encode.status.success(), "heif-enc failed: {}", encode_error);
        assert!(heic_path.exists(), "heif-enc produced no output file");

        let decoded_png = dir.join("decoded.png");
        let decode = tauri::async_runtime::block_on(crate::services::heic_unix::decode_to_png(
            heic_path.clone(),
            decoded_png.clone(),
        ));
        // The encoder and the decoder are separate plugins on newer distributions. Having the first
        // without the second is a missing tool - the app reports it with an install hint (tested in
        // heic_unix) - not a decode bug, so it stops here. Any other failure is a real one.
        if let Err(e) = &decode {
            if crate::services::heic_unix::is_missing_hevc_decoder(e) {
                eprintln!("SKIPPED heic_unix round trip: {e}");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
        }
        decode.expect("heic_unix::decode_to_png failed");

        let decoded = image::open(&decoded_png).expect("decoded output is not a valid image");
        assert_eq!(decoded.dimensions(), (16, 16));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- image clips -----------------------------------------------------------------------------

    #[test]
    fn still_image_paths_are_recognized_case_insensitively() {
        assert!(is_still_image_path("C:/photos/IMG_0001.JPG"));
        assert!(is_still_image_path("shot.png"));
        assert!(is_still_image_path("scan.webp"));
        assert!(!is_still_image_path("clip.mp4"));
        assert!(is_still_image_path("photo.HEIC"));
        assert!(is_heic_path("photo.heif") && !is_heic_path("photo.jpg"));
        assert!(!is_still_image_path("My video.briefvideo"));
    }

    #[test]
    fn image_segments_always_need_the_filter_graph() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), end: 5.0, ..base_segment() };
        assert!(segment_needs_filter_graph(&seg));
        assert!(!segment_needs_filter_graph(&base_segment()));
    }

    #[test]
    fn frame_fit_letterboxes_before_any_clip_effect() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), flip_horizontal: Some(true), ..base_segment() };
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), true, None, None, None);
        let fit = chain.find("pad=1920:1080").expect("pads to the output frame");
        let flip = chain.find("hflip").expect("still applies the clip's own effects");
        assert!(fit < flip, "fit must come first so effects see the output-sized frame: {chain}");
        assert!(chain.contains("force_original_aspect_ratio=decrease"), "never stretches: {chain}");
        assert!(chain.contains("format=yuv420p"), "images get converted to the encode format: {chain}");
    }

    #[test]
    fn frame_fit_is_skipped_unless_requested() {
        let seg = KeepSegment { source_path: "photo.jpg".to_string(), ..base_segment() };
        assert_eq!(segment_effect_chain(&seg, Some(1920), Some(1080), false, None, None, None), "");
        assert!(!frame_fit_chain(1280, 720, false).contains("format="), "videos keep their own pixel format");
        let blur = frame_fit_blur_chain(1080, 1920, false, "fb3");
        assert!(blur.starts_with(",split=2[fb3b][fb3f];"), "{blur}");
        assert!(blur.contains("crop=270:480,boxblur") && blur.contains("overlay=(W-w)/2:(H-h)/2"), "{blur}");
    }

    #[test]
    fn proxy_size_caps_the_long_edge_and_stays_even() {
        assert_eq!(proxy_size(1920, 1080), (1920, 1080));
        assert_eq!(proxy_size(3840, 2160), (1920, 1080));
        assert_eq!(proxy_size(1080, 1920), (1080, 1920));
        let (w, h) = proxy_size(4001, 3001);
        assert!(w <= PROXY_MAX_EDGE && h <= PROXY_MAX_EDGE && w % 2 == 0 && h % 2 == 0);
    }

    // ---- transition_fold_step ------------------------------------------------------------------

    #[test]
    fn transition_draws_the_outgoing_tail_over_the_incoming_head() {
        let (step, v, a) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, Some((1920, 1080)), Some(("fade", 1.0)), None);
        assert_eq!((v.as_str(), a.as_str()), ("fold1v", "fold1a"));
        // The incoming clip's first second gets the transition, the rest follows untouched.
        assert!(step.starts_with("[v1]split[vh1][vr1];[vh1]trim=end=1.000000[head1];[vr1]trim=start=1.000000,setpts=PTS-STARTPTS,fps=30.000[rest1];"), "{step}");
        assert!(step.contains("[old1]format=yuva420p,fade=t=out:st=0:d=1.0000:alpha=1[oc1];[head1][oc1]overlay=eof_action=pass[tr1];"), "{step}");
        // Pinned to the timeline's rate - an unknown one would reach the encoder as 25fps.
        assert!(step.ends_with("[v0][tr1][rest1]concat=n=3:v=1:a=0,fps=30.000,settb=AVTB[fold1v];[a0][a1]concat=n=2:v=0:a=1[fold1a];"), "audio just cuts: {step}");
        assert!(!step.contains("xfade"), "{step}");
    }

    #[test]
    fn a_segment_reads_its_tail_handle_and_splits_it_off() {
        let mut seg = base_segment();
        seg.start = 2.0;
        seg.end = 6.0;
        seg.speed = Some(2.0);
        // Plays on at its end speed: 0.5s of transition = 1s of source, plus slack.
        assert!((tail_source_seconds(&seg, 0.5) - 1.1).abs() < 1e-9);
        assert!(segment_video_chain_with_tail("[0:v]", &seg, "", 1.1).starts_with("[0:v]trim=start=2.000:end=7.100,"));
        // Stabilized clips hold their last frame instead.
        seg.stabilize = Some(StabilizeSettings { strength: 0.5 });
        assert_eq!(tail_source_seconds(&seg, 0.5), 0.0);
        let split = transition_tail("full0", "v0", "old1", 2.0, 0.5, 30.0);
        assert!(split.starts_with("[full0]tpad=stop_mode=clone:stop_duration=0.500,split[full0m][full0t];"), "{split}");
        assert!(split.contains("[full0m]trim=end=2.000000[v0];"), "{split}");
        assert!(split.contains("[full0t]trim=start=2.000000,setpts=PTS-STARTPTS,fps=30.000,settb=AVTB,trim=end=0.500[old1];"), "{split}");
    }

    #[test]
    fn transition_is_capped_by_the_incoming_clip_only() {
        // A tiny first clip no longer limits the transition - it plays over the incoming clip.
        let (step, _, _) = transition_fold_step("v0", "a0", 1, 0.5, 2.0, 30.0, Some((1920, 1080)), Some(("wipeleft", 3.0)), None);
        assert!(step.contains("[vh1]trim=end=1.800000[head1]"), "{step}");
    }

    #[test]
    fn no_transition_is_a_plain_concat() {
        let (step, _, _) = transition_fold_step("fold1v", "fold1a", 2, 9.0, 4.0, 30.0, Some((1920, 1080)), None, None);
        assert_eq!(step, "[fold1v][fold1a][v2][a2]concat=n=2:v=1:a=1[fold2v][fold2a];");
    }

    #[test]
    fn every_transition_builds_a_window_and_unknown_sizes_crossfade() {
        for name in ALLOWED_TRANSITIONS {
            let (step, _, _) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, Some((1280, 720)), Some((name, 0.6)), None);
            assert!(step.contains("[tr1]") && step.contains("[old1]") && step.contains("[head1]"), "{name}: {step}");
            assert!(!step.contains("xfade") && !step.contains("st(") && !step.contains("ld("), "{name}: {step}");
        }
        // No known frame size: drawing at the output size is impossible, so a plain crossfade.
        let (step, _, _) = transition_fold_step("v0", "a0", 1, 5.0, 5.0, 30.0, None, Some(("pagecurl", 0.6)), None);
        assert!(step.contains("[old1]format=yuva420p,fade=t=out") && !step.contains("geq"), "{step}");
    }

    #[test]
    fn per_frame_values_follow_the_preview_curves() {
        // A whip's blur: sin(pi p) * 3% of the width, one command per frame of the window.
        let blur = sendcmd_series("gblur@w1", &["sigma"], 0.5, 30.0, |p| (std::f64::consts::PI * p).sin() * 0.03 * 1000.0);
        assert!(blur.starts_with("sendcmd=c='0.0000 gblur@w1 sigma 0.000;0.0333 gblur@w1 sigma 6.237;"), "{blur}");
        assert!(blur.ends_with("0.5000 gblur@w1 sigma 0.000'"), "{blur}");
        // Pixelize sets both block dimensions together.
        let px = sendcmd_series("pixelize@p1", &["w", "h"], 0.1, 10.0, |_| 5.0);
        // ...and only when it changes: a constant value is a single command.
        assert_eq!(px, "sendcmd=c='0.0000 pixelize@p1 w 5.000,pixelize@p1 h 5.000'");
        let step = transition_window_graph("whip", 1, 0.5, 30.0, (1000, 500), &TransitionLook::default());
        assert!(step.contains("gblur@w1=sigma=0") && step.contains("overlay=x='-0.3*main_w*min(t/0.5000,1)'"), "{step}");
    }

    #[test]
    fn transition_looks_are_parsed_never_interpolated_raw() {
        let hostile = TransitionLook {
            color: Some("'; drop".to_string()),
            intensity: Some(9.0),
            direction: Some("'; drop".to_string()),
            size: Some(1.0),
            orientation: Some("'; drop".to_string()),
            shape: Some("'; drop".to_string()),
            peel_from: Some("'; drop".to_string()),
            easing: Some("'; drop".to_string()),
            see_through: Some(f64::NAN),
            softness: Some(f64::INFINITY),
        };
        for name in ALLOWED_TRANSITIONS {
            let step = transition_window_graph(name, 1, 0.5, 30.0, (1280, 720), &hostile);
            assert!(!step.contains("drop") && !step.contains("NaN") && !step.contains("inf"), "{name}: {step}");
        }
        assert!(parse_hex_color("red").is_none() && parse_hex_color("#12345g").is_none());
        // Intensity is clamped to 1.5: the flash's sin() peak scale.
        let look = TransitionLook { color: Some("#3b82f6".into()), intensity: Some(9.0), ..Default::default() };
        let step = transition_window_graph("fadewhite", 1, 0.5, 30.0, (1280, 720), &look);
        assert!(step.contains("blend=all_mode=screen") && step.contains("min(1,1.500*sin(PI*"), "{step}");
        // A plain white flash dips through white like fadeblack does through black.
        let step = transition_window_graph("fadewhite", 1, 0.5, 30.0, (1280, 720), &TransitionLook::default());
        assert!(step.contains("geq=lum=235") && !step.contains("blend"), "{step}");
        // Doors: a vertical opening reads the x axis.
        let step = transition_window_graph("horzopen", 1, 0.5, 30.0, (1280, 720), &TransitionLook { orientation: Some("vertical".into()), ..Default::default() });
        assert!(step.contains("lte(X/W,"), "{step}");
    }

    // Not a unit test: writes the real export graph for two 2s clips joined by each transition
    // (1s) to $DUMP_TRANSITION_GRAPHS/<name>.txt, for rendering against the preview (parity check).
    #[test]
    #[ignore]
    fn dump_transition_graphs() {
        let Ok(dir) = std::env::var("DUMP_TRANSITION_GRAPHS") else { return };
        // Every colour preset at 80%, and the vignette layer at 640x360.
        for preset in ["vibrant", "cinematic", "bw", "warm", "cool"] {
            std::fs::write(format!("{dir}/color_{preset}.chain"), color_filter_chain(&ClipColorFilter { preset: preset.into(), intensity: 0.8 })).unwrap();
        }
        std::fs::write(format!("{dir}/color_vignette.graph"), vignette_layer(0.8, 640, 360, 30.0, "0:v", "out", 0)).unwrap();
        // And every Ken Burns motion over a 4s clip at 30fps, output 640x360.
        for preset in [
            "zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down", "push", "punch-in", "bounce-in", "drift", "sway", "float", "breathe", "pulse",
            "shake", "vibrate",
        ] {
            let kb = ClipKenBurns { preset: preset.to_string(), intensity: Some(0.8), target_x: None, target_y: None, span: None };
            std::fs::write(format!("{dir}/kb_{preset}.chain"), ken_burns_chain(&kb, 4.0, 640, 360, 30.0)).unwrap();
        }
        // Every clip effect over a 4s clip at 640x360, [0:v] -> [out].
        for kind in ["echo", "rgbsplit", "huecycle", "focus", "colorin", "flicker"] {
            let fx = ClipFx { kind: kind.into(), intensity: 0.6 };
            std::fs::write(format!("{dir}/fx_{kind}.graph"), clip_fx_graph(&fx, "0:v", "out", (640, 360), 4.0, 0).unwrap()).unwrap();
        }
        // The box animations' scale / squash / position expressions for an overlay shown 1s-3s.
        for anim in ["pop", "flip", "zoom", "drop"] {
            let s = overlay_anim_scale_expr(anim, 1.0, 3.0, "t").unwrap_or_else(|| "1".into());
            let sx = if anim == "flip" { overlay_flip_sx_expr(1.0, 3.0, "t") } else { "1".into() };
            let dy = if anim == "drop" { overlay_drop_offset_expr(1.0, 3.0) } else { "0".into() };
            std::fs::write(format!("{dir}/anim_{anim}.txt"), format!("{s}\n{sx}\n{dy}")).unwrap();
        }
        let look: TransitionLook = std::env::var("DUMP_TRANSITION_LOOK").ok().and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        let mut seg0 = base_segment();
        seg0.end = 2.0;
        let mut seg1 = base_segment();
        seg1.end = 2.0;
        for name in ALLOWED_TRANSITIONS {
            let mut graph = String::new();
            graph.push_str(&format!("{},fps=30.000,settb=AVTB[full0];", segment_video_chain_with_tail("[0:v]", &seg0, "", tail_source_seconds(&seg0, 1.0))));
            graph.push_str(&transition_tail("full0", "v0", "old1", 2.0, 1.0, 30.0));
            graph.push_str(&format!("{},fps=30.000,settb=AVTB[v1];", segment_video_chain("[1:v]", &seg1, "")));
            graph.push_str("anullsrc=channel_layout=stereo:sample_rate=44100:duration=2[a0];anullsrc=channel_layout=stereo:sample_rate=44100:duration=2[a1];");
            let size = std::env::var("DUMP_TRANSITION_SIZE")
                .ok()
                .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
                .unwrap_or((640, 360));
            let (step, v, _) = transition_fold_step("v0", "a0", 1, 2.0, 2.0, 30.0, Some(size), Some((name, 1.0)), Some(&look));
            graph.push_str(&step);
            graph.push_str(&format!("[{v}]format=yuv420p[out]"));
            std::fs::write(format!("{dir}/{name}.txt"), graph).unwrap();
        }
    }

    // Not a unit test: smart-renders three clips of $DUMP_SOURCE with the bundled ffmpeg in
    // $FFMPEG_DIR - mid-GOP cuts (copy + both edges), a cut starting on a keyframe, and a clip too
    // short to hold a GOP (encoded whole) - into $DUMP_TRANSITION_GRAPHS/smart.mp4, verifying it
    // exactly as smart_render_export does.
    #[test]
    #[ignore]
    fn smart_render_end_to_end() {
        use crate::services::smart_render::{plan_clip, probe_packets, probe_source};
        let (Ok(dir), Ok(source), Ok(bin)) = (std::env::var("DUMP_TRANSITION_GRAPHS"), std::env::var("DUMP_SOURCE"), std::env::var("FFMPEG_DIR")) else { return };
        let (ffmpeg, ffprobe) = (PathBuf::from(&bin).join("ffmpeg.exe"), PathBuf::from(&bin).join("ffprobe.exe"));
        let started = std::time::Instant::now();
        let segs: Vec<KeepSegment> = [(121.3, 140.7), (300.0, 320.0), (539.5, 541.0)]
            .iter()
            .map(|&(start, end)| KeepSegment { source_path: source.clone(), start, end, ..base_segment() })
            .collect();
        let video = probe_source(&ffprobe, &source).expect("probe");
        assert!(video.copyable(), "{video:?}");
        let plans: Vec<_> = segs.iter().map(|s| plan_clip(&probe_packets(&ffprobe, &source, s.start - 1.0, s.end + 1.0).unwrap(), s.start, s.end, video.fps())).collect();
        println!("plans: {plans:?}");
        let work = PathBuf::from(&dir).join("smart_work");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let build = smart_render_jobs(&segs, &plans, &video, &[true, true, true], 1.0, &work).unwrap();
        let flag = std::sync::atomic::AtomicBool::new(false);
        run_smart_jobs(&ffmpeg, build.jobs, 4, &flag, |d, t| println!("job {d}/{t} at {:.1}s", started.elapsed().as_secs_f64())).unwrap();
        std::fs::write(work.join("pieces.txt"), &build.list).unwrap();
        let out = PathBuf::from(&dir).join("smart.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(work.join("pieces.txt"))
            .arg("-i")
            .arg(&build.audio_out)
            .args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-tag:v", "avc3", "-movflags", "+faststart"])
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success());
        println!("smart render done in {:.1}s, {} frames expected, joins at {:?}", started.elapsed().as_secs_f64(), build.expected_frames, build.joins);
        let count = Command::new(&ffprobe).args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"]).arg(&out).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim().parse::<usize>().unwrap(), build.expected_frames);
        for j in &build.joins {
            let o = Command::new(&ffmpeg).args(["-v", "error", "-ss", &format!("{:.6}", (j - 1.0).max(0.0)), "-i"]).arg(&out).args(["-t", "2", "-map", "0:v:0", "-f", "null", "-"]).output().unwrap();
            assert!(o.status.success() && o.stderr.is_empty(), "join at {j}: {}", String::from_utf8_lossy(&o.stderr));
        }
    }

    // Not a unit test: writes an export graph (three 20s cuts from minutes 2, 5 and 9 of $DUMP_SOURCE,
    // joined by crossfade and page curl, colour preset + vignette on one) twice - as before input
    // seeking ("plain") and with it ("seek") - each as `<inputs args>\n<graph>` for benchmarking.
    #[test]
    #[ignore]
    fn dump_export_benchmark_graph() {
        let (Ok(dir), Ok(source)) = (std::env::var("DUMP_TRANSITION_GRAPHS"), std::env::var("DUMP_SOURCE")) else { return };
        for seeking in [false, true] {
            let mut segs: Vec<KeepSegment> = [(120.0, 140.0), (300.0, 320.0), (540.0, 560.0)]
                .iter()
                .map(|&(start, end)| KeepSegment { source_path: source.clone(), start, end, ..base_segment() })
                .collect();
            segs[1].transition_in = Some(ClipTransitionIn { transition_type: "fade".into(), duration: 0.8, look: None });
            segs[2].transition_in = Some(ClipTransitionIn { transition_type: "pagecurl".into(), duration: 0.8, look: None });
            segs[2].color_filter = Some(ClipColorFilter { preset: "cinematic".into(), intensity: 0.8 });
            let mut inputs = Vec::new();
            for seg in segs.iter_mut() {
                let seek = if seeking { segment_input_seek(seg) } else { 0.0 };
                shift_segment_times(seg, seek);
                inputs.push(if seek > 0.0 { format!("-ss {seek:.6} -i") } else { "-i".to_string() });
            }
            let mut g = String::new();
            for (i, seg) in segs.iter().enumerate() {
                let extra = segment_effect_chain(seg, Some(1920), Some(1080), true, None, None, None);
                match segs.get(i + 1).and_then(transition_window) {
                    Some(d) => {
                        g.push_str(&format!("{},fps=30.000,settb=AVTB[full{i}];", segment_video_chain_with_tail(&format!("[{i}:v]"), seg, &extra, tail_source_seconds(seg, d))));
                        g.push_str(&transition_tail(&format!("full{i}"), &format!("v{i}"), &format!("old{}", i + 1), segment_output_duration(seg), d, 30.0));
                    }
                    None => g.push_str(&format!("{},fps=30.000,settb=AVTB[v{i}];", segment_video_chain(&format!("[{i}:v]"), seg, &extra))),
                }
                g.push_str(&audio_trim_chain(true, i, seg.start, seg.end, 1.0, &(Vec::new(), None), &format!("a{i}")));
            }
            let (mut cv, mut ca) = ("v0".to_string(), "a0".to_string());
            for i in 1..segs.len() {
                let tr = segs[i].transition_in.as_ref().map(|t| (t.transition_type.as_str(), t.duration));
                let (step, v, a) = transition_fold_step(&cv, &ca, i, 0.0, segment_output_duration(&segs[i]), 30.0, Some((1920, 1080)), tr, None);
                g.push_str(&step);
                (cv, ca) = (v, a);
            }
            g.push_str(&format!("[{cv}]format=yuv420p[outv];[{ca}]anull[outa]"));
            let name = if seeking { "seek" } else { "plain" };
            std::fs::write(format!("{dir}/export_{name}.txt"), format!("{}\n{g}", inputs.join("|"))).unwrap();
        }
    }

    #[test]
    fn a_still_is_decoded_and_fitted_once_then_repeated() {
        let seg = KeepSegment { source_path: "photo.jpg".into(), end: 3.0, flip_horizontal: Some(true), prefitted: true, ..base_segment() };
        let chain = still_image_input_chain(2, &seg, Some(1920), Some(1080), 3.5);
        assert!(chain.starts_with("[2:v]null,scale=1920:1080:force_original_aspect_ratio=decrease"), "{chain}");
        assert!(chain.contains(",hflip,loop=loop=104:size=1:start=0,setpts=N/(30.000*TB)[img2];"), "{chain}");
        // Its effect chain then starts after the fit and mirror.
        let extra = segment_effect_chain(&seg, Some(1920), Some(1080), true, None, None, None);
        assert!(!extra.contains("scale=1920:1080:force") && !extra.contains("hflip"), "{extra}");
        assert_eq!(segment_input_label(2, &seg), "[img2]");
        assert_eq!(segment_input_label(2, &base_segment()), "[2:v]");
        // Not fitted first (a pointer goes on under the fit): repeated raw, fitted in its chain.
        let raw = KeepSegment { prefitted: false, ..seg };
        assert!(still_image_input_chain(0, &raw, Some(1920), Some(1080), 1.0).starts_with("[0:v]null,loop=loop=29:"));
    }

    // Not a unit test: renders a 4000x3000 photo through a Ken Burns zoom with the blurred canvas
    // background both ways - `-loop 1` (decoded and fitted every frame) and still_image_input_chain
    // (once) - with the ffmpeg in $FFMPEG_DIR, checking the frames match and printing both times.
    #[test]
    #[ignore]
    fn a_still_rendered_once_matches_the_looped_input() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_still_once_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let photo = tmp.join("photo.jpg");
        let made = Command::new(&ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=4000x3000:d=1", "-frames:v", "1", "-q:v", "3"]).arg(&photo).status().unwrap();
        assert!(made.success());
        let mut seg = KeepSegment {
            source_path: photo.to_string_lossy().into_owned(),
            end: 4.0,
            ken_burns: Some(ClipKenBurns { preset: "zoom-in".into(), intensity: Some(0.5), target_x: None, target_y: None, span: None }),
            fit_blur: Some(0),
            source_fps: Some(IMAGE_SEGMENT_FPS),
            ..base_segment()
        };
        let render = |seg: &KeepSegment, once: bool| -> (Vec<u8>, f64) {
            let extra = segment_effect_chain(seg, Some(1280), Some(720), true, None, None, None);
            let (input, pre): (Vec<String>, String) = if once {
                (vec!["-i".into(), seg.source_path.clone()], still_image_input_chain(0, seg, Some(1280), Some(720), 4.5))
            } else {
                (["-loop", "1", "-framerate", "30", "-t", "4.5", "-i"].iter().map(|s| s.to_string()).chain([seg.source_path.clone()]).collect(), String::new())
            };
            let graph = format!("{pre}{},format=rgb24,scale=160:90[out]", segment_video_chain(&segment_input_label(0, seg).replace("[img0]", if once { "[img0]" } else { "[0:v]" }), seg, &extra));
            let started = std::time::Instant::now();
            let out = Command::new(&ffmpeg).args(["-v", "error"]).args(&input).args(["-filter_complex", &graph, "-map", "[out]", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(out.status.success(), "{}\n{graph}", String::from_utf8_lossy(&out.stderr));
            (out.stdout, started.elapsed().as_secs_f64())
        };
        let (looped, t_looped) = render(&seg, false);
        seg.prefitted = true;
        let (once, t_once) = render(&seg, true);
        println!("looped input {t_looped:.2}s, decoded once {t_once:.2}s");
        assert_eq!(looped.len(), once.len(), "same number of frames");
        let worst = looped.iter().zip(&once).map(|(a, b)| (*a as i16 - *b as i16).unsigned_abs()).max().unwrap_or(0);
        assert!(worst <= 2, "frames differ by up to {worst}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn edge(name: &str, duration: f64) -> Option<ClipTransitionIn> {
        Some(ClipTransitionIn { transition_type: name.into(), duration, look: None })
    }

    #[test]
    fn edge_windows_never_overlap_and_ignore_empty_durations() {
        let both = EdgeTransitions { intro: edge("fade", 3.0), outro: edge("fade", 3.0) };
        assert_eq!(edge_windows(&both, 4.0), (Some(1.8), Some(1.8)));
        assert_eq!(edge_windows(&both, 20.0), (Some(3.0), Some(3.0)));
        let intro_only = EdgeTransitions { intro: edge("fade", 3.0), outro: None };
        assert_eq!(edge_windows(&intro_only, 2.0), (Some(1.8), None));
        let empty = EdgeTransitions { intro: edge("fade", 0.0), outro: edge("fade", f64::NAN) };
        assert_eq!(edge_windows(&empty, 10.0), (None, None));
    }

    #[test]
    fn edge_transitions_draw_from_and_to_black_without_changing_the_length() {
        let edges = EdgeTransitions { intro: edge("colorsweep", 1.0), outro: edge("'; drop", 0.5) };
        let g = edge_transition_graph("prebase", "base", &edges, 10.0, 30.0, (1280, 720));
        // Intro: black is the outgoing picture, the video's first second the incoming one.
        let k = EDGE_INTRO_TAG;
        assert!(g.contains(&format!("color=c=black:s=1280x720:r=30.000:d=1.000000,format=yuv420p,settb=AVTB,setsar=1[old{k}]")), "{g}");
        assert!(g.contains(&format!("trim=end=1.000000[head{k}]")) && g.contains(&format!("[tr{k}][rest{k}]concat=n=2")), "{g}");
        // Outro: the last half second gives way to black; an unknown name is a crossfade, never raw.
        let k = EDGE_OUTRO_TAG;
        assert!(g.contains(&format!("trim=start=9.500000,setpts=PTS-STARTPTS")) && g.contains(&format!("[old{k}]")), "{g}");
        assert!(g.contains(&format!("d=0.500000,format=yuv420p,settb=AVTB,setsar=1[head{k}]")) && g.contains(&format!("[body{k}][tr{k}]concat=n=2")), "{g}");
        assert!(!g.contains("drop") && g.ends_with("[edgeout]null[base];"), "{g}");
        // Neither: a pass-through.
        let none = edge_transition_graph("prebase", "base", &EdgeTransitions::default(), 10.0, 30.0, (1280, 720));
        assert!(none.ends_with("[edg]null[base];"), "{none}");
    }

    // Not a unit test: renders a 4s test pattern through an intro and an outro with the ffmpeg in
    // $FFMPEG_DIR, checking the length is unchanged, the first and last frames are black, the middle
    // is the untouched video and every transition kind renders at an edge.
    #[test]
    #[ignore]
    fn edge_transitions_render() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        // YAVG of frame n of [base], or -1 when there's no such frame.
        let luma_at = |graph: &str, n: usize| -> f64 {
            let full = format!("testsrc2=s=320x180:r=30:d=4,format=yuv420p,settb=AVTB[prebase];{graph}[base];[base]select='eq(n,{n})',signalstats,metadata=print:key=lavfi.signalstats.YAVG[y]");
            let out = Command::new(&ffmpeg).args(["-v", "info", "-hide_banner", "-filter_complex", &full, "-map", "[y]", "-f", "null", "-"]).output().unwrap();
            let log = String::from_utf8_lossy(&out.stderr);
            assert!(out.status.success(), "{log}");
            log.lines().find_map(|l| l.split("YAVG=").nth(1)).and_then(|v| v.trim().parse().ok()).unwrap_or(-1.0)
        };
        for name in ALLOWED_TRANSITIONS {
            let edges = EdgeTransitions { intro: edge(name, 1.0), outro: edge(name, 1.0) };
            let g = edge_transition_graph("prebase", "base", &edges, 4.0, 30.0, (320, 180));
            let g = g.trim_end_matches("[base];").to_string();
            let (first, mid, last) = (luma_at(&g, 0), luma_at(&g, 60), luma_at(&g, 119));
            assert!(mid > 60.0, "{name}: the middle should be the untouched video - {mid}");
            assert!((0.0..40.0).contains(&first), "{name}: the first frame should still be (nearly) black - {first}");
            assert!((0.0..40.0).contains(&last), "{name}: the last frame should be (nearly) black - {last}");
            // There's no 121st frame: the length is exactly the video's.
            assert!(luma_at(&g, 120) < 0.0, "{name}: the video grew past 4s");
        }
    }

    #[test]
    fn drawn_transitions_slide_sprites_over_the_incoming_head() {
        assert_eq!(sanitize_transition_name("colorsweep"), "colorsweep");
        let step = drawn_transition("colorsweep", 1, 0.8, &TransitionLook::default());
        assert!(step.contains("[old1]") && step.contains("[head1]") && step.ends_with("[tr1];"), "{step}");
        // The sweep's colour and direction come from the look - parsed, never interpolated raw.
        let look = TransitionLook { color: Some("#2563eb".into()), direction: Some("left".into()), ..Default::default() };
        let step = drawn_transition("colorsweep", 1, 0.8, &look);
        let (y, u, v) = rgb_to_yuv((37.0, 99.0, 235.0));
        assert!(step.contains(&format!("lutyuv=y={y}:u={u}:v={v}")) && step.contains("x='main_w*(1-"), "{step}");
        let hostile = TransitionLook { color: Some("'; drop".into()), direction: Some("'; drop".into()), ..Default::default() };
        let step = drawn_transition("colorsweep", 1, 0.8, &hostile);
        assert!(step.contains("y='main_h*(1-") && !step.contains("drop"), "{step}");
    }

    #[test]
    fn graded_segments_get_their_color_preset_after_the_lut3d() {
        // The preview's order: the graded frame (GradeCanvas), the preset's CSS filter on top.
        let seg = KeepSegment {
            color_filter: Some(ClipColorFilter { preset: "warm".to_string(), intensity: 0.5 }),
            lut_cube: Some("LUT_3D_SIZE 2".to_string()),
            ..base_segment()
        };
        assert!(segment_needs_filter_graph(&seg));
        let chain = segment_effect_chain(&seg, Some(1920), Some(1080), false, Some(r"C\:/tmp/g.cube"), None, None);
        let lut = chain.find(r"lut3d=file='C\:/tmp/g.cube':interp=trilinear").expect("lut3d step");
        assert!(lut < chain.find("colorchannelmixer").unwrap(), "{chain}");
    }

    #[test]
    fn a_ramp_is_one_segment_with_a_continuous_time_map_and_stepped_audio() {
        let seg = KeepSegment {
            start: 10.0,
            end: 14.0,
            speed_steps: Some(vec![
                SpeedStep { source_start: 10.0, source_end: 12.0, speed: 1.0 },
                SpeedStep { source_start: 12.0, source_end: 14.0, speed: 0.5 },
            ]),
            ..base_segment()
        };
        assert!(segment_needs_filter_graph(&seg));
        assert!((segment_output_duration(&seg) - 6.0).abs() < 1e-9); // 2s + 2s at half speed
        assert_eq!(
            segment_speed_filter(&seg),
            "setpts='(if(lt(T,2.000000),(0.000000+(T-0.000000)/1.000000),(2.000000+(T-2.000000)/0.500000)))/TB'"
        );
        let audio = segment_audio_chain(true, 3, &seg, &(vec![], None), "a3");
        assert!(audio.contains("[a3_src]asplit=2[a3_p0][a3_p1];"), "{audio}");
        assert!(audio.contains("[a3_p1]atrim=start=2.000000:end=4.250000,asetpts=PTS-STARTPTS,apad=pad_dur=0.25,atempo=0.5000,atrim=end=4.000000[a3_q1];"), "{audio}");
        assert!(audio.ends_with("[a3_q0][a3_q1]concat=n=2:v=0:a=1[a3];"), "{audio}");
        // Silent clip: silence as long as the ramped output.
        assert!(segment_audio_chain(false, 3, &seg, &(vec![], None), "a3").contains("duration=6.000"));
    }

    #[test]
    fn constant_speed_keeps_its_plain_chain() {
        let seg = KeepSegment { speed: Some(2.0), ..base_segment() };
        assert_eq!(segment_video_chain("[0:v]", &seg, ",hflip"), "[0:v]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS,hflip,setpts=PTS/2.0000");
        assert!((segment_output_duration(&seg) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn reframe_modes_produce_the_output_size() {
        let frame = |mode: &str| OutputFrame { width: 1080, height: 1920, mode: mode.to_string(), anchor_x: None, anchor_y: None , track: None};
        assert_eq!(
            reframe_chain("base", "framed", &frame("fill")),
            "[base]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[framed];"
        );
        assert!(reframe_chain("base", "framed", &frame("fit")).contains("pad=1080:1920"));
        let blur = reframe_chain("base", "framed", &frame("fit-blur"));
        assert!(blur.starts_with("[base]split=2") && blur.contains("boxblur") && blur.ends_with("[framed];"), "{blur}");
    }

    #[test]
    fn eased_knots_build_a_balanced_tree_that_holds_and_eases() {
        assert_eq!(eased_knots_expr(&[(0.0, 0.3)], "t"), "0.30000");
        let two = eased_knots_expr(&[(1.0, 0.2), (2.0, 0.2)], "t");
        assert_eq!(two, "0.20000"); // a hold is a constant
        let k: Vec<(f64, f64)> = (0..64).map(|i| (i as f64, (i % 2) as f64)).collect();
        let e = eased_knots_expr(&k, "t");
        // 63 segments -> nesting depth ~6, not 63.
        let mut depth = 0i32;
        let mut max_depth = 0;
        for c in e.chars() {
            if c == '(' { depth += 1; max_depth = max_depth.max(depth); }
            if c == ')' { depth -= 1; }
        }
        assert!(max_depth < 20, "depth {max_depth}");
        assert_eq!(e.matches("if(").count(), 62);
    }

    #[test]
    fn a_tracked_fill_crops_on_the_track() {
        let frame = OutputFrame { width: 1080, height: 1920, mode: "fill".into(), anchor_x: None, anchor_y: None, track: Some(vec![[0.0, 0.3, 0.5], [2.0, 0.7, 0.5]]) };
        let chain = reframe_chain("base", "framed", &frame);
        assert!(chain.contains("x='clip(((0.30000+(0.40000)*"), "{chain}");
        assert!(chain.contains(":y='clip((0.50000)*ih-oh/2,0,ih-oh)'"), "{chain}");
    }

    #[test]
    fn keyframe_expressions_hold_ease_and_hold_again() {
        let kf = |time: f64, x: f64, easing: &str| OverlayKeyframe { time, x, y: 0.0, scale: 1.0, opacity: 1.0, easing: easing.to_string() };
        assert_eq!(keyframe_expr(&[kf(1.0, 50.0, "linear")], "t", |k| k.x), "50.0000");
        let e = keyframe_expr(&[kf(2.0, 100.0, "linear"), kf(1.0, 0.0, "ease")], "t", |k| k.x);
        assert_eq!(e, "if(lt(t,2.0000),(0.0000+(100.0000)*(clip((t-1.0000)/1.0000,0,1))*(clip((t-1.0000)/1.0000,0,1))*(3-2*(clip((t-1.0000)/1.0000,0,1)))),100.0000)");
        assert!(keyframe_expr(&[kf(0.0, 0.0, "hold"), kf(1.0, 10.0, "linear")], "t", |k| k.x).contains("(0.0000+(10.0000)*0)"));
    }

    #[test]
    fn keyframe_expressions_stay_shallow() {
        // A motion track's worth of keyframes: the comparisons nest log2(n) deep, not n.
        let kfs: Vec<OverlayKeyframe> = (0..300)
            .map(|i| OverlayKeyframe { time: i as f64 / 30.0, x: (i * 3) as f64, y: 0.0, scale: 1.0, opacity: 1.0, easing: "linear".into() })
            .collect();
        let e = keyframe_expr(&kfs, "t", |k| k.x);
        // How many if()s are open at once: each remembers the paren depth it opened at.
        let (mut parens, mut open_ifs, mut max_depth) = (0usize, Vec::<usize>::new(), 0usize);
        for (i, c) in e.char_indices() {
            match c {
                '(' => {
                    if e[..i].ends_with("if") {
                        open_ifs.push(parens);
                        max_depth = max_depth.max(open_ifs.len());
                    }
                    parens += 1;
                }
                ')' => {
                    parens -= 1;
                    if open_ifs.last() == Some(&parens) {
                        open_ifs.pop();
                    }
                }
                _ => {}
            }
        }
        assert!(max_depth <= 10, "nested {max_depth} deep");
        assert!(e.starts_with("if(lt(t,"), "{}", &e[..60]);
    }

    #[test]
    fn three_boxes_make_the_gaussian() {
        for sigma in [1.5, 4.0, 12.0, 40.0, 130.0] {
            let widths = box_widths_for_sigma(sigma, 3);
            let variance: f64 = widths.iter().map(|w| ((w * w - 1) as f64) / 12.0).sum();
            // Whole-pixel box widths can't land a tiny sigma exactly; at real blur sizes they do.
            let tolerance = if sigma < 3.0 { 0.08 } else if sigma < 8.0 { 0.05 } else { 0.02 };
            assert!((variance.sqrt() - sigma).abs() / sigma < tolerance, "sigma {sigma}: {widths:?} -> {}", variance.sqrt());
        }
        assert_eq!(gaussian_blur_chain(0.1, 100, 100, None), "");
        // Radii never exceed what boxblur accepts on a small region.
        let chain = gaussian_blur_chain(80.0, 40, 30, None);
        assert!(!chain.is_empty() && !chain.contains("luma_radius=20") && !chain.contains("luma_radius=4"), "{chain}");
    }

    #[test]
    fn only_measured_blend_modes_reach_ffmpeg() {
        assert_eq!(blend_mode_ffmpeg("hard-light"), Some("hardlight"));
        assert_eq!(blend_mode_ffmpeg("plus-lighter"), Some("addition"));
        for unsafe_mode in ["soft-light", "color-dodge", "normal", "multiply'; drop", ""] {
            assert_eq!(blend_mode_ffmpeg(unsafe_mode), None, "{unsafe_mode}");
        }
    }

    // Not a unit test: renders each new compositing path with the real ffmpeg ($FFMPEG_DIR) and
    // checks pixels against the formula the preview's CSS uses (W3C compositing / CSS filters).
    #[test]
    #[ignore]
    fn new_effects_render_like_the_spec() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_fx_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (w, h) = (320usize, 240usize);
        let run = |args: &[String]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}\n{:?}", String::from_utf8_lossy(&out.stderr), args);
            out.stdout
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
        // One rgb24 frame of [out] at output time t.
        let frame = |inputs: &[Vec<String>], graph: &str, t: f64| -> Vec<u8> {
            let mut args: Vec<String> = Vec::new();
            for i in inputs {
                args.extend(i.iter().cloned());
            }
            args.extend(s(&["-filter_complex", graph, "-map", "[out]", "-ss"]));
            args.push(format!("{t:.3}"));
            args.extend(s(&["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]));
            let px = run(&args);
            assert_eq!(px.len(), w * h * 3, "graph: {graph}");
            px
        };
        let at = |px: &[u8], x: usize, y: usize| -> [f64; 3] {
            let i = (y * w + x) * 3;
            [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64]
        };
        let near = |got: [f64; 3], want: [f64; 3], tol: f64, what: &str| {
            for c in 0..3 {
                assert!((got[c] - want[c]).abs() <= tol, "{what}: got {got:?}, want {want:?}");
            }
        };
        let base_rgb = [200.0, 100.0, 50.0];
        let base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=3"]);
        // A 64x64 layer of (100, 200, 250) at half alpha.
        let layer_png = tmp.join("layer.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=0x64C8FA@0.5:s=64x64,format=rgba", "-frames:v", "1", &layer_png.to_string_lossy()]));
        let layer = s(&["-loop", "1", "-framerate", "30", "-t", "1.1", "-i", &layer_png.to_string_lossy()]);
        let alpha = 128.0 / 255.0;
        let src = [100.0, 200.0, 250.0];
        let w3c = |mode: &str, b: f64, s: f64| -> f64 {
            let (b, s) = (b / 255.0, s / 255.0);
            let multiply = |a: f64, c: f64| a * c;
            let screen = |a: f64, c: f64| a + c - a * c;
            let r = match mode {
                "multiply" => multiply(b, s),
                "screen" => screen(b, s),
                // Overlay is hard-light with the roles swapped: the backdrop decides.
                "overlay" => if b <= 0.5 { multiply(s, 2.0 * b) } else { screen(s, 2.0 * b - 1.0) },
                "difference" => (b - s).abs(),
                _ => unreachable!(),
            };
            r * 255.0
        };
        for mode in ["multiply", "screen", "overlay", "difference"] {
            let ff = blend_mode_ffmpeg(mode).unwrap();
            let l = BlendLayer { label: "lay", x: "100".into(), y: "80".into(), width: 64, height: 64, moving: false, fps: 30.0 };
            let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), ff, 0.5, 1.5, "t0", "out"));
            let graph = graph.trim_end_matches(';');
            let px = frame(&[base.clone(), layer.clone()], graph, 1.0);
            let want: Vec<f64> = (0..3).map(|c| base_rgb[c] + alpha * (w3c(mode, base_rgb[c], src[c]) - base_rgb[c])).collect();
            near(at(&px, 132, 112), [want[0], want[1], want[2]], 4.0, mode);
            near(at(&px, 20, 20), base_rgb, 3.0, &format!("{mode} outside"));
            let before = frame(&[base.clone(), layer.clone()], graph, 0.2);
            near(at(&before, 132, 112), base_rgb, 3.0, &format!("{mode} before its window"));
        }
        // Add (plus-lighter): min(1, alpha * source + backdrop).
        let l = BlendLayer { label: "lay", x: "100".into(), y: "80".into(), width: 64, height: 64, moving: false, fps: 30.0 };
        let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), "addition", 0.5, 1.5, "t1", "out"));
        let px = frame(&[base.clone(), layer.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 132, 112), [(200.0 + alpha * 100.0f64).min(255.0), 100.0 + alpha * 200.0, 50.0 + alpha * 250.0], 4.0, "add");
        // Moving: x goes 0 -> 200 over 0.5..1.5s, so at 1.0s the layer's centre is at 132.
        let kfs = vec![
            OverlayKeyframe { time: 0.5, x: 0.0, y: 80.0, scale: 1.0, opacity: 1.0, easing: "linear".into() },
            OverlayKeyframe { time: 1.5, x: 200.0, y: 80.0, scale: 1.0, opacity: 1.0, easing: "linear".into() },
        ];
        let l = BlendLayer { label: "lay", x: keyframe_expr(&kfs, "t", |k| k.x), y: keyframe_expr(&kfs, "t", |k| k.y), width: 64, height: 64, moving: true, fps: 30.0 };
        let graph = format!("[0:v]format=yuv420p[base];[1:v]format=rgba,setpts=PTS-STARTPTS+0.5/TB[lay];{}", blend_composite("base", &l, (320, 240), "multiply", 0.5, 1.5, "t2", "out"));
        let px = frame(&[base.clone(), layer.clone()], graph.trim_end_matches(';'), 1.0);
        let want: Vec<f64> = (0..3).map(|c| base_rgb[c] + alpha * (w3c("multiply", base_rgb[c], src[c]) - base_rgb[c])).collect();
        near(at(&px, 132, 112), [want[0], want[1], want[2]], 5.0, "moving multiply");
        near(at(&px, 40, 112), base_rgb, 3.0, "where the moving layer has left");

        // Adjustment layers: CSS brightness(0.5) over 0.5..1.5s.
        let adj = |ops: Vec<CssOpSpec>, extra: &dyn Fn(&mut AdjustmentLayerSpec)| {
            let mut a = AdjustmentLayerSpec { start_time: 0.5, end_time: 1.5, placement: "under".into(), color_ops: ops, blur_sigma: None, vignette: None, opacity: 1.0, fade_in: 0.0, fade_out: 0.0, mask_data_base64: None, mask_x: 0, mask_y: 0, mask_keyframes: None, mask_invert: false, fill: None };
            extra(&mut a);
            a
        };
        let dim = vec![CssOpSpec { op: "brightness".into(), value: 0.5 }];
        let a = adj(dim.clone(), &|_| {});
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a0", "out", 30.0));
        let px = frame(&[base.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 160, 120), [100.0, 50.0, 25.0], 3.0, "brightness");
        let px = frame(&[base.clone()], graph.trim_end_matches(';'), 0.2);
        near(at(&px, 160, 120), base_rgb, 3.0, "brightness before its window");
        // Half opacity mixes halfway; a fade-in is halfway up half-way through it.
        let a = adj(dim.clone(), &|a| a.opacity = 0.5);
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a1", "out", 30.0));
        near(at(&frame(&[base.clone()], graph.trim_end_matches(';'), 1.0), 160, 120), [150.0, 75.0, 37.5], 3.0, "opacity");
        let a = adj(dim.clone(), &|a| a.fade_in = 0.5);
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a2", "out", 30.0));
        near(at(&frame(&[base.clone()], graph.trim_end_matches(';'), 0.75), 160, 120), [150.0, 75.0, 37.5], 6.0, "fade in");
        // A mask confines it: the left half only.
        let mask_png = tmp.join("mask.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=white:s=160x240,format=gray", "-frames:v", "1", &mask_png.to_string_lossy()]));
        let mask = s(&["-loop", "1", "-framerate", "30", "-t", "1.1", "-i", &mask_png.to_string_lossy()]);
        let a = adj(dim.clone(), &|_| {});
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, Some((1, 160, 240)), (320, 240), "base", "a3", "out", 30.0));
        let px = frame(&[base.clone(), mask.clone()], graph.trim_end_matches(';'), 1.0);
        near(at(&px, 40, 120), [100.0, 50.0, 25.0], 3.0, "masked in");
        near(at(&px, 280, 120), base_rgb, 3.0, "masked out");
        // Blur: a black|white edge comes out as the Gaussian's integral - 1 sigma in, ~84%.
        let edge = s(&["-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=3,drawbox=x=160:y=0:w=160:h=240:color=white:t=fill"]);
        let a = adj(vec![], &|a| a.blur_sigma = Some(10.0));
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a4", "out", 30.0));
        let px = frame(&[edge.clone()], graph.trim_end_matches(';'), 1.0);
        let phi = |z: f64| 0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2));
        for x in [150usize, 155, 160, 165, 170, 180] {
            let want = 255.0 * phi((x as f64 + 0.5 - 160.0) / 10.0);
            assert!((at(&px, x, 120)[1] - want).abs() < 10.0, "blur at x={x}: {} vs {want}", at(&px, x, 120)[1]);
        }
        // A vignette layer and a colour look together still render.
        let a = adj(vec![CssOpSpec { op: "saturate".into(), value: 1.6 }, CssOpSpec { op: "hue-rotate".into(), value: 10.0 }], &|a| a.vignette = Some(0.8));
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&a, None, (320, 240), "base", "a5", "out", 30.0));
        frame(&[base.clone()], graph.trim_end_matches(';'), 1.0);

        // A keyframed blur region lands where its keyframes put it.
        let checker = s(&["-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=3,geq=lum='if(mod(floor(X/4)+floor(Y/4),2),235,16)':cb=128:cr=128"]);
        let bv = OverlayBlur {
            x: 0,
            y: 80,
            width: 64,
            height: 64,
            intensity: 0.5,
            mask_data_base64: None,
            start_time: 0.5,
            end_time: 1.5,
            sigma: Some(8.0),
            keyframes: Some(kfs.clone()),
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", blur_region_chain(&bv, 0, None, "base", "out"));
        let px = frame(&[checker.clone()], graph.trim_end_matches(';'), 1.0);
        let variance = |x0: usize, y0: usize| {
            let v: Vec<f64> = (0..16).flat_map(|j| (0..16).map(move |i| (i, j))).map(|(i, j)| at(&px, x0 + i, y0 + j)[1]).collect();
            let m = v.iter().sum::<f64>() / v.len() as f64;
            v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64
        };
        assert!(variance(124, 104) < 200.0, "inside the moved region it's blurred: {}", variance(124, 104));
        assert!(variance(20, 104) > 2000.0, "where it was isn't: {}", variance(20, 104));

        // Picture-in-picture starting at 3s, 2s into its source, shows source 3s at output 4s.
        let pip_src = s(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=10"]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 2.0,
            start_time: 3.0,
            end_time: 5.0,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.0,
            fade_out: 0.0,
            chroma_key: None,
            mask_data_base64: None,
            source_color: None,
            mask_input: None,
            cutout_path: None,
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let long_base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=6"]);
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        let px = frame(&[long_base.clone(), pip_src.clone()], graph.trim_end_matches(';'), 4.0);
        let reference = |t: f64| run(&s(&["-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=10", "-ss", &format!("{t:.3}"), "-frames:v", "1", "-vf", "scale=160:120,format=yuv420p,format=rgb24", "-f", "rawvideo", "pipe:1"]));
        let mse = |r: &[u8]| {
            let mut sum = 0.0;
            for y in 0..120 {
                for x in 0..160 {
                    for c in 0..3 {
                        let d = px[(y * w + x) * 3 + c] as f64 - r[(y * 160 + x) * 3 + c] as f64;
                        sum += d * d;
                    }
                }
            }
            sum / (160.0 * 120.0 * 3.0)
        };
        let (right, wrong) = (mse(&reference(3.0)), mse(&reference(4.0)));
        assert!(right < 60.0 && right * 4.0 < wrong, "pip timing: mse {right} at the right moment vs {wrong}");
        // ...and blends: screen over the base.
        let pip = PipOverlay { blend_mode: Some("screen".into()), ..pip };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        frame(&[long_base.clone(), pip_src.clone()], graph.trim_end_matches(';'), 4.0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7) - plenty for a pixel check.
    fn erf(x: f64) -> f64 {
        let t = 1.0 / (1.0 + 0.3275911 * x.abs());
        let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
        if x >= 0.0 { y } else { -y }
    }

    #[test]
    fn decodes_colours_the_way_the_webview_does() {
        assert_eq!(browser_color_for("unknown", "unknown", 720), ("bt709", "tv"));
        assert_eq!(browser_color_for("", "", 718), ("bt601", "tv"));
        assert_eq!(browser_color_for("smpte170m", "pc", 1080), ("bt601", "pc"));
        assert_eq!(browser_color_for("bt709", "tv", 480), ("bt709", "tv"));
        assert_eq!(output_matrix(1080), "bt709");
        assert_eq!(output_matrix(480), "bt601");
    }

    #[test]
    fn keys_with_the_chain_the_preview_is_checked_against() {
        let k = ChromaKeySpec { color: "#18a848".into(), similarity: 0.1, blend: 0.12, spill: 0.7 };
        // chromaKey.test.ts runs this same chain (after the source's own RGB conversion) in ffmpeg
        // and compares it with the preview shader's maths.
        assert_eq!(
            chroma_key_filters(&k, ("bt709", "tv")),
            "scale=in_color_matrix=bt709:in_range=tv,format=gbrp,scale=out_color_matrix=bt601:out_range=pc,format=yuv444p,\
             chromakey=color=0x18a848:similarity=0.1:blend=0.12,scale=in_color_matrix=bt601:in_range=pc,format=rgba,\
             despill=type=green:mix=0.5:expand=0:red=0:green=-0.7:blue=0:brightness=0:alpha=0"
        );
        let blue = ChromaKeySpec { color: "1040d0".into(), similarity: 5.0, blend: f64::NAN, spill: 0.0 };
        let f = chroma_key_filters(&blue, ("bt601", "tv"));
        assert!(f.contains("chromakey=color=0x1040d0:similarity=1:blend=0.08,"), "{f}");
        assert!(!f.contains("despill"), "{f}");
    }

    // Not a unit test: a green-screen layer keyed, masked and faded in through pip_overlay_chain with
    // the real ffmpeg ($FFMPEG_DIR), checked pixel by pixel.
    #[test]
    #[ignore]
    fn video_layers_key_mask_and_fade() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_layer_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (w, h) = (320usize, 240usize);
        let run = |args: &[String]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}\n{:?}", String::from_utf8_lossy(&out.stderr), args);
            out.stdout
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
        // Grey subject on a green screen, 160x120 - placed 1:1 at the frame's top-left.
        let screen = s(&["-f", "lavfi", "-i", "color=c=0x00B140:s=160x120:r=30:d=3,drawbox=x=50:y=30:w=60:h=60:color=0x808080:t=fill"]);
        let base = s(&["-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=3"]);
        // Mask: the left half shows.
        let mask_png = tmp.join("mask.png");
        run(&s(&["-f", "lavfi", "-i", "color=c=white:s=160x120,format=gray,geq=lum='if(lt(X,80),255,0)'", "-frames:v", "1", &mask_png.to_string_lossy()]));
        let mask = s(&["-i", &mask_png.to_string_lossy()]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 0.0,
            start_time: 0.5,
            end_time: 2.5,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.5,
            fade_out: 0.0,
            chroma_key: Some(ChromaKeySpec { color: "#00b140".into(), similarity: 0.1, blend: 0.05, spill: 0.0 }),
            mask_data_base64: None,
            source_color: Some(("bt601", "tv")),
            mask_input: Some(2),
            cutout_path: None,
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        let frame = |t: f64| -> Vec<u8> {
            let mut args: Vec<String> = [base.clone(), screen.clone(), mask.clone()].concat();
            args.extend(s(&["-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss"]));
            args.push(format!("{t:.3}"));
            args.extend(s(&["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]));
            let px = run(&args);
            assert_eq!(px.len(), w * h * 3);
            px
        };
        let at = |px: &[u8], x: usize, y: usize| -> [f64; 3] {
            let i = (y * w + x) * 3;
            [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64]
        };
        let near = |got: [f64; 3], want: [f64; 3], tol: f64, what: &str| {
            for c in 0..3 {
                assert!((got[c] - want[c]).abs() <= tol, "{what}: got {got:?}, want {want:?}");
            }
        };
        let base_rgb = [200.0, 100.0, 50.0];
        let grey = [128.0, 128.0, 128.0];
        let px = frame(1.5);
        near(at(&px, 20, 20), base_rgb, 6.0, "the screen is keyed out");
        near(at(&px, 65, 60), grey, 6.0, "the subject shows");
        near(at(&px, 100, 60), base_rgb, 6.0, "the masked-off half of the subject doesn't");
        near(at(&px, 200, 60), base_rgb, 6.0, "outside the layer");
        // Halfway through its half-second fade-in: half subject, half video.
        let px = frame(0.75);
        let half = [(grey[0] + base_rgb[0]) / 2.0, (grey[1] + base_rgb[1]) / 2.0, (grey[2] + base_rgb[2]) / 2.0];
        near(at(&px, 65, 60), half, 10.0, "fading in");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Not a unit test: a cut-out (VP9 with alpha, as background_removal.rs writes) composited through
    // pip_overlay_chain with the real ffmpeg ($FFMPEG_DIR) - its transparency must survive.
    #[test]
    #[ignore]
    fn cutout_layers_keep_their_alpha() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_cutout_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // A grey picture whose left half is transparent, written the way the cut-outs are.
        let cutout = tmp.join("cut.webm");
        run(&[
            "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=25:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,80),0,255)'",
            "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva420p",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "18", "-b:v", "0", "-auto-alt-ref", "0", "-colorspace", "bt709", &cutout.to_string_lossy(),
        ]);
        let pip = PipOverlay {
            source_path: String::new(),
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            shape: "rectangle".into(),
            corner_radius: None,
            crop: None,
            trim_start: 0.0,
            start_time: 0.0,
            end_time: 2.0,
            volume: 0.0,
            blend_mode: None,
            fx: None,
            opacity: None,
            fade_in: 0.0,
            fade_out: 0.0,
            chroma_key: None,
            mask_data_base64: None,
            source_color: None,
            mask_input: None,
            cutout_path: Some(cutout.to_string_lossy().to_string()),
            cutout_background: None,
            video_input: 1,
            audio_input: None,
            background_input: None,
            mask_motion: None,
            mask_motion_input: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=25:d=2",
            "-c:v", "libvpx-vp9", "-i", &cutout.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 6.0), "{what}: got {got:?}, want {want:?}");
        near(at(30, 60), [200.0, 100.0, 50.0], "the transparent half shows the video under it");
        near(at(130, 60), [128.0, 128.0, 128.0], "the opaque half shows the cut-out");
        // With a colour behind the person, the see-through half shows that colour instead.
        let pip = PipOverlay { cutout_background: Some(CutoutBackgroundSpec { kind: "color".into(), color: Some("#2050e0".into()), image_base64: None, blur_sigma: None, blur_margin: None, source_crop: None }), ..pip };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=25:d=2",
            "-c:v", "libvpx-vp9", "-i", &cutout.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        near(at(30, 60), [32.0, 80.0, 224.0], "the background colour fills behind the person");
        near(at(130, 60), [128.0, 128.0, 128.0], "the person stays in front");
        near(at(250, 60), [200.0, 100.0, 50.0], "outside the layer");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Not a unit test: a spotlight sliding across the frame, a fill, and a reveal mask sliding inside
    // a layer, through the real ffmpeg ($FFMPEG_DIR), checked where each should be at mid-move.
    #[test]
    #[ignore]
    fn moving_masks_and_fill() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_moving_mask_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // A hard-edged 40x40 white mask.
        let square = tmp.join("square.png");
        run(&["-f", "lavfi", "-i", "color=c=white:s=40x40,format=gray", "-frames:v", "1", &square.to_string_lossy()]);
        let b64 = BASE64.encode(std::fs::read(&square).unwrap());
        let kf = |time: f64, x: f64, y: f64| OverlayKeyframe { time, x, y, scale: 1.0, opacity: 1.0, easing: "linear".into() };
        let frame_at = |inputs: &[&str], graph: &str, t: &str| -> Vec<u8> {
            let mut args: Vec<&str> = inputs.to_vec();
            args.extend(["-filter_complex", graph, "-map", "[out]", "-ss", t, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
            run(&args)
        };
        let at = |px: &[u8], x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 8.0), "{what}: got {got:?}, want {want:?}");
        let base = "color=c=0xC86432:s=320x240:r=30:d=3";
        let orange = [200.0, 100.0, 50.0];

        // Spotlight: everything but a 40x40 square goes black; the square slides from x=20 to x=220
        // between 0.5 s and 1.5 s - at 1.0 s it's at x=120.
        let spot = AdjustmentLayerSpec {
            start_time: 0.0, end_time: 3.0, placement: "under".into(), color_ops: vec![CssOpSpec { op: "brightness".into(), value: 0.0 }], blur_sigma: None, vignette: None,
            opacity: 1.0, fade_in: 0.0, fade_out: 0.0, mask_data_base64: None, mask_x: 0, mask_y: 0,
            mask_keyframes: Some(vec![kf(0.5, 20.0, 100.0), kf(1.5, 220.0, 100.0)]), mask_invert: true, fill: None,
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&spot, Some((1, 40, 40)), (320, 240), "base", "spot", "out", 30.0));
        let sq = square.to_string_lossy().to_string();
        let px = frame_at(&["-f", "lavfi", "-i", base, "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 140, 120), orange, "inside the spotlight at mid-move");
        near(at(&px, 40, 120), [0.0, 0.0, 0.0], "where it started is dark now");
        near(at(&px, 240, 120), [0.0, 0.0, 0.0], "where it's going is still dark");

        // Fill: the whole frame one colour.
        let fill = AdjustmentLayerSpec { color_ops: vec![], mask_keyframes: None, mask_invert: false, fill: Some("#2050e0".into()), ..spot };
        let graph = format!("[0:v]format=yuv420p[base];{}", adjustment_layer_chain(&fill, None, (320, 240), "base", "fill", "out", 30.0));
        let px = frame_at(&["-f", "lavfi", "-i", base], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 160, 120), [32.0, 80.0, 224.0], "filled");

        // Reveal: a grey 160x120 layer shows only inside a 40x40 mask sliding from x=0 to x=120
        // (within the layer) between 0.5 s and 1.5 s.
        let pip = PipOverlay {
            source_path: String::new(), x: 0, y: 0, width: 160, height: 120, shape: "rectangle".into(), corner_radius: None, crop: None,
            trim_start: 0.0, start_time: 0.0, end_time: 3.0, volume: 0.0, blend_mode: None, fx: None, opacity: None, fade_in: 0.0, fade_out: 0.0,
            chroma_key: None, mask_data_base64: None, source_color: None, mask_input: None, cutout_path: None, cutout_background: None,
            video_input: 1, audio_input: None, background_input: None,
            mask_motion: Some(MaskMotionSpec { image_base64: b64, keyframes: vec![
                MaskKeyframeSpec { time: 0.5, x: 0.0, y: 40.0, w: 40.0, h: 40.0, easing: "linear".into() },
                MaskKeyframeSpec { time: 1.5, x: 120.0, y: 40.0, w: 40.0, h: 40.0, easing: "linear".into() },
            ], invert: false }),
            mask_motion_input: Some(2),
        };
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&pip, 1, 0, "base", "out", Some((320, 240)), 30.0));
        let px = frame_at(&["-f", "lavfi", "-i", base, "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=30:d=3", "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq], graph.trim_end_matches(';'), "1.0");
        near(at(&px, 80, 60), [128.0, 128.0, 128.0], "the layer shows inside the mask at mid-move");
        near(at(&px, 20, 60), orange, "and not where the mask started");

        // An iris opening from nothing at the layer's centre: fully hidden on its first frame (no
        // 2 px dot), open by 1 s; inverted, the whole layer shows on the first frame.
        let iris = |invert: bool| PipOverlay {
            mask_motion: Some(MaskMotionSpec { image_base64: BASE64.encode(std::fs::read(&square).unwrap()), keyframes: vec![
                MaskKeyframeSpec { time: 0.0, x: 80.0, y: 60.0, w: 0.0, h: 0.0, easing: "ease-out".into() },
                MaskKeyframeSpec { time: 1.0, x: 60.0, y: 40.0, w: 40.0, h: 40.0, easing: "hold".into() },
            ], invert }),
            mask_motion_input: Some(2),
            source_path: String::new(), x: 0, y: 0, width: 160, height: 120, shape: "rectangle".into(), corner_radius: None, crop: None,
            trim_start: 0.0, start_time: 0.0, end_time: 3.0, volume: 0.0, blend_mode: None, fx: None, opacity: None, fade_in: 0.0, fade_out: 0.0,
            chroma_key: None, mask_data_base64: None, source_color: None, mask_input: None, cutout_path: None, cutout_background: None,
            video_input: 1, audio_input: None, background_input: None,
        };
        let inputs = ["-f", "lavfi", "-i", base, "-f", "lavfi", "-i", "color=c=0x808080:s=160x120:r=30:d=3", "-loop", "1", "-framerate", "30", "-t", "3.1", "-i", &sq];
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&iris(false), 1, 0, "base", "out", Some((320, 240)), 30.0));
        let first = frame_at(&inputs, graph.trim_end_matches(';'), "0");
        for (x, y) in [(79, 59), (80, 60), (81, 61), (80, 59)] {
            near(at(&first, x, y), orange, "nothing of the layer on the closed iris's first frame");
        }
        near(at(&frame_at(&inputs, graph.trim_end_matches(';'), "1.2"), 80, 60), [128.0, 128.0, 128.0], "open after the iris");
        let graph = format!("[0:v]format=yuv420p[base];{}", pip_overlay_chain(&iris(true), 1, 0, "base", "out", Some((320, 240)), 30.0));
        near(at(&frame_at(&inputs, graph.trim_end_matches(';'), "0"), 80, 60), [128.0, 128.0, 128.0], "inverted: the whole layer on the first frame");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // Evaluates what step_expr builds: nested if(lt(t,X),A,B) over integer leaves.
    fn eval_step(expr: &str, t: f64) -> i64 {
        if let Some(rest) = expr.strip_prefix("if(lt(t,") {
            let close = rest.find(')').unwrap();
            let threshold: f64 = rest[..close].parse().unwrap();
            let body = &rest[close + 2..rest.len() - 1];
            // Split the two branches at the top-level comma.
            let mut depth = 0;
            let split = body.char_indices().find(|&(_, c)| {
                match c {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    ',' if depth == 0 => return true,
                    _ => {}
                }
                false
            });
            let (a, b) = body.split_at(split.unwrap().0);
            return if t < threshold { eval_step(a, t) } else { eval_step(&b[1..], t) };
        }
        expr.parse().unwrap()
    }

    #[test]
    fn step_expressions_hold_each_value_until_the_next() {
        assert_eq!(step_expr(&[], "t"), "0");
        assert_eq!(step_expr(&[(0.0, 10)], "t"), "10");
        assert_eq!(step_expr(&[(0.0, 10), (1.0, 20), (2.0, 30)], "t"), "if(lt(t,1.000000),10,if(lt(t,2.000000),20,30))");
        let points: Vec<(f64, i64)> = (0..37).map(|i| (i as f64 * 0.25 - 1.0, i * 7)).collect();
        for k in 0..200 {
            let t = k as f64 * 0.05 - 2.0;
            let want = points.iter().rev().find(|p| p.0 <= t).map_or(points[0].1, |p| p.1);
            assert_eq!(eval_step(&step_expr(&points, "t"), t), want, "at {t}");
        }
    }

    fn tiny_png(w: u32, h: u32, rgba: [u8; 4]) -> String {
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(w, h, image::Rgba(rgba)))
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        format!("data:image/png;base64,{}", BASE64.encode(out))
    }

    #[test]
    fn sprite_lists_hold_each_picture_for_its_run() {
        let dir = std::env::temp_dir().join(format!("briefcast_sprite_list_test_{}", std::process::id()));
        let track = SpriteTrack {
            sprites: vec![tiny_png(4, 4, [255, 0, 0, 255]), tiny_png(4, 4, [0, 0, 255, 255])],
            width: 4,
            height: 4,
            runs: vec![(0.5, 0, 2, 2), (0.75, -1, 2, 2), (1.0, 1, 4, 4)],
            end: 1.5,
        };
        // Timed from 0.25: blank first, then each run - and everything before 0 dropped.
        let list = std::fs::read_to_string(write_sprite_track(&track, &dir, 0.25).unwrap()).unwrap();
        let entries: Vec<(&str, &str)> = list
            .lines()
            .filter(|l| !l.starts_with("option ") && !l.starts_with("ffconcat"))
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|c| (c[0], c.get(1).copied().unwrap_or("")))
            .collect();
        assert_eq!(
            entries,
            vec![
                ("file 'blank.png'", "duration 0.250000"),
                ("file 's0.png'", "duration 0.250000"),
                ("file 'blank.png'", "duration 0.250000"),
                ("file 's1.png'", "duration 0.500000"),
                ("file 'blank.png'", "duration 1"),
                ("file 'blank.png'", ""),
            ]
        );
        // Every picture at a microsecond timebase (see write_sprite_track).
        assert_eq!(list.matches("option framerate 1000000").count(), 6);
        let list = std::fs::read_to_string(write_sprite_track(&track, &dir, 0.6).unwrap()).unwrap();
        assert!(list.starts_with("ffconcat version 1.0\nfile 's0.png'\noption framerate 1000000\nduration 0.150000\n"), "{list}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sprites_become_rgba_of_the_tracks_size() {
        // An opaque RGB picture one pixel short.
        let mut rgb = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(3, 4, image::Rgb([9, 8, 7])))
            .write_to(&mut std::io::Cursor::new(&mut rgb), image::ImageFormat::Png)
            .unwrap();
        let fixed = image::load_from_memory(&normalized_sprite_png(&BASE64.encode(rgb), 4, 4).unwrap()).unwrap();
        assert!(matches!(fixed, image::DynamicImage::ImageRgba8(_)));
        let px = fixed.to_rgba8();
        assert_eq!(px.dimensions(), (4, 4));
        assert_eq!(px.get_pixel(0, 0).0, [9, 8, 7, 255]);
        assert_eq!(px.get_pixel(3, 0).0[3], 0);
        // Already right: passed through untouched.
        let ok = tiny_png(4, 4, [1, 2, 3, 4]);
        assert_eq!(normalized_sprite_png(&ok, 4, 4).unwrap(), BASE64.decode(ok.rsplit(',').next().unwrap()).unwrap());
    }

    // Not a unit test: the editor-drawn pointer through a clip's real chain and the screen frame,
    // rendered by the real ffmpeg ($FFMPEG_DIR) and checked frame by frame. The sprite alternates
    // red/blue every frame while it moves 2 px a frame, so a picture or a position one frame early
    // or late shows up as the wrong colour or a coloured pixel where the box just was.
    #[test]
    #[ignore]
    fn pointer_sprites_land_on_their_frames_and_zoom_with_the_clip() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let tmp = std::env::temp_dir().join(format!("briefcast_pointer_test_{}", std::process::id()));
        let run = |args: &[&str]| {
            let out = Command::new(&ffmpeg).args(["-v", "error", "-y"]).args(args).output().unwrap();
            assert!(out.status.success(), "ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        };
        // Cells centred on k/60 of SOURCE time, boundaries half a cell before - as pointerTrack.ts.
        let runs: Vec<(f64, i64, i64, i64)> = (30..91).map(|k: i64| ((k as f64 - 0.5) / 60.0, k % 2, 2 * (k - 30), 40)).collect();
        let track = SpriteTrack { sprites: vec![tiny_png(8, 8, [255, 0, 0, 255]), tiny_png(8, 8, [0, 0, 255, 255])], width: 8, height: 8, runs, end: 90.5 / 60.0 };
        let list = write_sprite_track(&track, &tmp.join("ptr"), 0.5).unwrap();
        let list_path = list.to_string_lossy().to_string();
        // The clip: 0.5..1.5 s of a grey 60 fps source, cropped to its top-left quarter (2x zoom).
        let seg = KeepSegment { start: 0.5, end: 1.5, crop: Some(ClipCrop { x: 0.0, y: 0.0, width: 0.5, height: 0.5 }), ..base_segment() };
        let fragment = pointer_fragment(0, std::slice::from_ref(&track), &[1], 0.5);
        let extra = segment_effect_chain(&seg, Some(320), Some(240), false, None, None, Some(&fragment));
        let graph = format!("{}[out]", segment_video_chain("[0:v]", &seg, &extra));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0x808080:s=320x240:r=60:d=3",
            "-f", "concat", "-safe", "0", "-i", &list_path,
            "-filter_complex", &graph, "-map", "[out]", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let frame_bytes = 320 * 240 * 3;
        let frames = px.len() / frame_bytes;
        assert!(frames >= 58, "only {frames} frames");
        let at = |f: usize, x: usize, y: usize| { let i = f * frame_bytes + (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        let near = |got: [f64; 3], want: [f64; 3], what: &str| assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 12.0), "{what}: got {got:?}, want {want:?}");
        for f in 0..frames.min(60) {
            let k = 30 + f as i64;
            // Zoomed 2x: the 8 px box at (2j, 40) of the source is 16 px at (4j, 80).
            let x = 4 * (k - 30) as usize;
            let want = if k % 2 == 0 { [255.0, 0.0, 0.0] } else { [0.0, 0.0, 255.0] };
            near(at(f, x + 8, 88), want, &format!("the pointer on frame {f}"));
            if x >= 4 {
                // A frame late, the box would still cover x-4 (red or blue are far darker than the
                // grey) - luma, since 4:2:0 chroma smears across the edge either way.
                let [r, g, b] = at(f, x - 4, 88);
                let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                assert!((luma - 128.0).abs() <= 12.0, "nothing where it was, frame {f}: luma {luma}");
            }
        }

        // The screen frame: a green backdrop with a transparent hole at (40, 30) 240 x 180.
        let mut backdrop = image::RgbaImage::from_pixel(320, 240, image::Rgba([0, 200, 0, 255]));
        for y in 30..210 {
            for x in 40..280 {
                backdrop.put_pixel(x, y, image::Rgba([0, 0, 0, 0]));
            }
        }
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(backdrop).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        let backdrop_path = tmp.join("backdrop.png");
        std::fs::write(&backdrop_path, &bytes).unwrap();
        let ss = ScreenStyleSpec { backdrop_base64: String::new(), x: 40, y: 30, width: 240, height: 180 };
        let graph = format!("[0:v]format=yuv420p[base];{}", screen_style_chain("base", 1, &ss, (320, 240), "out"));
        let px = run(&[
            "-f", "lavfi", "-i", "color=c=0xC86432:s=320x240:r=30:d=2", "-i", &backdrop_path.to_string_lossy(),
            "-filter_complex", graph.trim_end_matches(';'), "-map", "[out]", "-ss", "1.0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ]);
        let at = |x: usize, y: usize| { let i = (y * 320 + x) * 3; [px[i] as f64, px[i + 1] as f64, px[i + 2] as f64] };
        near(at(10, 10), [0.0, 200.0, 0.0], "the wallpaper");
        near(at(160, 120), [200.0, 100.0, 50.0], "the video in the hole");
        near(at(42, 32), [200.0, 100.0, 50.0], "right to the hole's edge");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_wrap_jpeg_in_pdf() {
        let dummy_jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9];
        let pdf = wrap_jpeg_in_pdf(&dummy_jpeg, 640, 480);
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.ends_with(b"%%EOF\n"));
        let pdf_str = String::from_utf8_lossy(&pdf);
        assert!(pdf_str.contains("/MediaBox [0 0 640 480]"));
        assert!(pdf_str.contains("/Width 640 /Height 480"));
        assert!(pdf_str.contains("/Filter /DCTDecode"));
    }

    #[test]
    fn test_convert_image_file_to_pdf() {
        let tmp = std::env::temp_dir().join("briefcast_test_img_to_pdf");
        let _ = std::fs::create_dir_all(&tmp);
        let img_path = tmp.join("test_img.png");
        let pdf_path = tmp.join("test_img.pdf");

        // Create a 100x80 test PNG image
        let test_img = image::RgbaImage::from_pixel(100, 80, image::Rgba([120, 180, 240, 255]));
        test_img.save(&img_path).unwrap();

        let res = convert_image_file_to_pdf(&img_path, &pdf_path);
        assert!(res.is_ok(), "Image to PDF conversion failed: {:?}", res.err());
        assert!(pdf_path.exists());
        let pdf_bytes = std::fs::read(&pdf_path).unwrap();
        assert!(pdf_bytes.starts_with(b"%PDF-1.4"));
        assert!(pdf_bytes.ends_with(b"%%EOF\n"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
