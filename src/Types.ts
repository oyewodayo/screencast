export type WindowInfo = {
    title: string;
    image_path?: string;
    hwnd: number;
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