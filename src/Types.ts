export type WindowInfo = {
    title: string;
    image_path?: string;
    hwnd: number;
    exe_path?: string;
    // "Google Chrome", "Visual Studio Code" - the executable's own description, else its name.
    app_name?: string;
    icon_path?: string;
    is_minimized?: boolean;
    // One of Briefcast's own windows.
    is_own?: boolean;
    width?: number;
    height?: number;
};

export type CaptureCapabilities = {
    // The picked window alone is captured, even while covered or while another app is in use.
    window_isolated: boolean;
};

export type MonitorInfo = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    is_primary: boolean;
};

export type RecordingConfig = {
    type: 'fullscreen' | 'monitor' | 'window' | 'region';
    monitorId?: string;
    windowHwnd?: number;
    windowTitle?: string;
    overlayPosition: string;
    overlayShape: string;
    overlaySize: string;
};