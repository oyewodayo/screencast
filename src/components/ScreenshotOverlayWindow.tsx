// ScreenshotOverlayWindow.tsx
//
// Window-targeted screenshots can't reliably auto-focus their target first: Windows deliberately
// restricts which process can steal foreground focus (SetForegroundWindow can silently no-op),
// so an app calling it on itself right after the user clicked *its own* button routinely fails,
// which is exactly what made window capture grab whatever was actually on top (Briefcast) instead
// of the intended window. This sidesteps that entirely, the same way Greenshot/ShareX/Snipping
// Tool do: stop trying to steal focus programmatically, and instead let the user bring the real
// target window forward themselves (genuine user input always wins), then confirm capture here.
//
// Pre-declared in tauri.conf.json (visible: false) and only ever shown/hidden after that —
// mirroring RecordingOverlayWindow's proven lifecycle — rather than created fresh via
// `new WebviewWindow(...)` each time, which turned out to be an unproven path in this app: every
// other overlay window here (recording-overlay, and completed_recording built on the Rust side)
// already existed by the time anything tried to show it. Data arrives via an event
// (screenshot-overlay-armed) instead of URL params for the same reason recording-overlay uses
// recording-state-update rather than baking state into its URL: this window's content is already
// loaded and listening long before any particular capture request exists.
import { useEffect, useRef, useState } from 'react';
import { IoCameraOutline, IoClose } from 'react-icons/io5';
import { appWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/tauri';
import { emit, listen } from '@tauri-apps/api/event';

// However this overlay got shown (a mouse click, or a keyboard Enter/Space used to activate the
// "Take Screenshot" button), a trailing key event can land on this window the instant it gains
// focus — before the user has had any real chance to look at it, let alone click into the target
// window — and instantly self-trigger a capture of whatever's still on top (usually Briefcast
// itself). Keydown is ignored for this long after each time the overlay is (re-)armed.
const KEY_GUARD_MS = 400;

const ScreenshotOverlayWindow = () => {
  const [title, setTitle] = useState('');
  const [formData, setFormData] = useState<Record<string, unknown> | null>(null);
  const [capturing, setCapturing] = useState(false);
  const armedAtRef = useRef<number>(0);

  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<{ title: string; formData: Record<string, unknown> }>(
        'screenshot-overlay-armed',
        (event) => {
          setTitle(event.payload.title);
          setFormData(event.payload.formData);
          setCapturing(false);
          armedAtRef.current = Date.now();
        }
      );
      return unlisten;
    };

    let unlistenFn: (() => void) | undefined;
    setupListener().then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const cancel = async (): Promise<void> => {
    await appWindow.hide();
  };

  const capture = async (): Promise<void> => {
    if (capturing || !formData) return;
    setCapturing(true);
    try {
      // Hidden before the actual grab so this overlay is never part of the captured pixels,
      // regardless of whether it happens to have focus (e.g. the user clicked Capture rather
      // than pressed Enter with the target window focused) — the short wait gives the hide time
      // to actually flush to the compositor before ffmpeg reads the screen.
      await appWindow.hide();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const savedPath = await invoke<string>('take_screenshot', { formData });
      const fileName = savedPath.split(/[\\/]/).pop() ?? savedPath;
      await emit('screenshot-captured', { message: `Screenshot saved: ${fileName}` });
    } catch (error) {
      console.error('Error taking screenshot:', error);
      await emit('screenshot-captured', { message: `Failed to take screenshot: ${error}`, isError: true });
    } finally {
      setCapturing(false);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (Date.now() - armedAtRef.current < KEY_GUARD_MS) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        capture();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing, formData]);

  return (
    <div className="w-full h-full flex flex-col bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm rounded-lg overflow-hidden">
      <div
        data-tauri-drag-region
        className="bg-gray-800 dark:bg-neutral-950 px-3 py-1.5 cursor-move flex justify-between items-center shrink-0"
      >
        <span className="text-xs font-medium text-white">Screenshot</span>
        <button onClick={cancel} className="text-white hover:text-gray-300" title="Cancel (Esc)">
          <IoClose size={16} />
        </button>
      </div>
      <div className="flex-1 flex flex-col justify-center gap-2 px-3 py-2">
        <p className="text-xs text-neutral-600 dark:text-neutral-300 leading-snug">
          {typeof formData?.screen_size === 'string' && formData.screen_size.startsWith('window:') ? (
            <>Click on <strong className="font-semibold">{title || 'the target window'}</strong> to bring it forward, then capture.</>
          ) : (
            <>Get <strong className="font-semibold">{title || 'the screen'}</strong> ready, then capture.</>
          )}
        </p>
        <div className="flex gap-2">
          <button
            onClick={capture}
            disabled={capturing || !formData}
            className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            <IoCameraOutline size={14} />
            {capturing ? 'Capturing…' : 'Capture (Enter)'}
          </button>
          <button
            onClick={cancel}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
          >
            Esc
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScreenshotOverlayWindow;
