# Brief Studio

This is studio for streaming, recording videos, screen recording, audio recording, editing and manipulation of media files of any format.

## More
Show the List of all devices
ffmpeg -list_devices true -f dshow -i dummy

ffmpeg -list_options true -f dshow -i video="Integrated Webcam" 

Record Video + audio with webcam and System Microphone and save as video-audio-out.avi
ffmpeg -f dshow -video_size 320x240 -i video="Integrated Webcam":audio="Microphone (Realtek Audio)" video-audio-out7.avi

Record Video only
ffmpeg -f dshow -video_size 320x240 -i video="Integrated Webcam" video-audio-out6.avi

Record audio with system microphone. You can replace the "Microphone (Realtek Audio)" with your any of your listed audio device.
ffmpeg -f dshow -i audio="Microphone (Realtek Audio)" audio-out.mp3

Full screen recording
ffmpeg -f gdigrab -show_region 1 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outssscreens.avi

To pick selected screen size
ffmpeg -f gdigrab -video_size 1600x1200 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outscreens-size.avi
ffmpeg -f gdigrab -video_size 1600x1200 -S 55 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outscreens-size.avi

Capture video from webcam and overlay it on the recorded screen with audio
ffmpeg -f gdigrab -framerate sntsc -i desktop -f dshow -video_size 320x240 -i "video=Integrated Webcam":audio="Microphone (Realtek Audio)" -c:v mpeg4 -c:a aac -ac 2 -filter_complex [0:v][1:v]overlay=x=W-w-100:y=H-h-50 -segment_time 10 -segment_format avi vidplusaudio.avi

// #[tauri::command]
// async fn create_folder() {
//     let video_path = "c:\\Users\\HP\\Videos";
//     let audio_path = "c:\\Users\\HP\\Musics";
//     let picture_path = "c:\\Users\\HP\\Pictures";
//     let path = "Recordings";
//     DirBuilder::new().recursive(true).create(path).unwrap();
// }

"-show_video_device_dialog", "true",
"-crossbar_video_input_pin_number", "0",
"-crossbar_audio_input_pin_number", "3",
Video size ¶
Specify the size of the sourced video, it may be a string of the form widthxheight, or the name of a size abbreviation.

The following abbreviations are recognized:
‘ntsc’
720x480

‘pal’
720x576

‘qntsc’
352x240

‘qpal’
352x288

‘sntsc’
640x480

‘spal’
768x576

‘film’
352x240

‘ntsc-film’
352x240

‘sqcif’
128x96

‘qcif’
176x144

‘cif’
352x288

‘4cif’
704x576

‘16cif’
1408x1152

‘qqvga’
160x120

‘qvga’
320x240

‘vga’
640x480

‘svga’
800x600

‘xga’
1024x768

‘uxga’
1600x1200

‘qxga’
2048x1536

‘sxga’
1280x1024

‘qsxga’
2560x2048

‘hsxga’
5120x4096

‘wvga’
852x480

‘wxga’
1366x768

‘wsxga’
1600x1024

‘wuxga’
1920x1200

‘woxga’
2560x1600

‘wqsxga’
3200x2048

‘wquxga’
3840x2400

‘whsxga’
6400x4096

‘whuxga’
7680x4800

‘cga’
320x200

‘ega’
640x350

‘hd480’
852x480

‘hd720’
1280x720

‘hd1080’
1920x1080

‘2k’
2048x1080

‘2kflat’
1998x1080

‘2kscope’
2048x858

‘4k’
4096x2160

‘4kflat’
3996x2160

‘4kscope’
4096x1716

‘nhd’
640x360

‘hqvga’
240x160

‘wqvga’
400x240

‘fwqvga’
432x240

‘hvga’
480x320

‘qhd’
960x540

‘2kdci’
2048x1080

‘4kdci’
4096x2160

‘uhd2160’
3840x2160

‘uhd4320’
7680x4320



- [Briefstudio](https://studio.briefbrew.com/)
