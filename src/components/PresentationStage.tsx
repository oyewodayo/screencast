import { IoVideocamOffOutline } from "react-icons/io5";
import { cameraStatusText } from "../hooks/useCameraStreams";
import { PHONE_CAMERA_DEVICE } from "../services/phoneCamera";
import { PresentationFit, PresentationLayout, cameraDisplayName } from "../services/presentation";

// Draws the live display's picture: the shown cameras in the chosen layout. Used at full size by
// the display window and scaled down in the Screen Options modal, so the operator's preview is
// the same arrangement the room sees.

interface PresentationStageProps {
    // Shown cameras, in order.
    cameras: string[];
    live: string | null;
    layout: PresentationLayout;
    fit: PresentationFit;
    showNames: boolean;
    streams: Record<string, MediaStream>;
    errors: Record<string, string>;
    // Smaller type and gaps for the modal's preview.
    compact?: boolean;
    // Clicking a tile puts that camera on air (the modal's preview); the display has no clicks.
    onPick?: (camera: string) => void;
}

// Columns for an even grid: 1, 2, 2x2, 3x2, 3x3, ... - as close to the screen's shape as tiles
// allow.
const gridColumns = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);

const Tile = ({
    camera,
    stream,
    error,
    fit,
    showName,
    compact,
    isLive,
    onPick,
}: {
    camera: string;
    stream?: MediaStream;
    error?: string;
    fit: PresentationFit;
    showName: boolean;
    compact?: boolean;
    isLive?: boolean;
    onPick?: (camera: string) => void;
}) => (
    <div
        className={`relative w-full h-full min-w-0 min-h-0 overflow-hidden bg-black ${onPick ? "cursor-pointer group" : ""}`}
        onClick={onPick ? () => onPick(camera) : undefined}
    >
        {stream ? (
            <video
                autoPlay
                muted
                playsInline
                className={`w-full h-full ${fit === "fill" ? "object-cover" : "object-contain"}`}
                ref={(el) => {
                    if (el && el.srcObject !== stream) el.srcObject = stream;
                }}
            />
        ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-neutral-900 text-white/60" title={error}>
                <IoVideocamOffOutline className={compact ? "text-base" : "text-4xl"} />
                <span className={compact ? "text-[10px]" : "text-lg"}>
                    {camera === PHONE_CAMERA_DEVICE ? "Phone not connected" : cameraStatusText(error)}
                </span>
            </div>
        )}
        {showName && (
            <span
                className={`absolute left-0 bottom-0 m-[1.5%] rounded bg-black/60 text-white font-medium truncate max-w-[90%] ${
                    compact ? "px-1.5 py-0.5 text-[10px]" : "px-3 py-1 text-xl"
                }`}
            >
                {cameraDisplayName(camera)}
            </span>
        )}
        {onPick && isLive !== undefined && (
            <span
                className={`absolute inset-0 pointer-events-none transition-shadow ${
                    isLive ? "shadow-[inset_0_0_0_3px_rgb(239,68,68)]" : "group-hover:shadow-[inset_0_0_0_2px_rgba(255,255,255,0.5)]"
                }`}
            />
        )}
    </div>
);

const PresentationStage = ({ cameras, live, layout, fit, showNames, streams, errors, compact, onPick }: PresentationStageProps) => {
    const gap = compact ? "gap-0.5" : "gap-1";

    if (cameras.length === 0) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-black text-white/50">
                <span className={compact ? "text-xs" : "text-2xl"}>No camera on display</span>
            </div>
        );
    }

    const onAir = live && cameras.includes(live) ? live : cameras[0];
    const tile = (camera: string) => (
        <Tile
            key={camera}
            camera={camera}
            stream={streams[camera]}
            error={errors[camera]}
            fit={fit}
            showName={showNames}
            compact={compact}
            isLive={onPick ? camera === onAir && layout !== "grid" : undefined}
            onPick={onPick}
        />
    );

    if (layout === "single" || cameras.length === 1) {
        return <div className="w-full h-full bg-black">{tile(onAir)}</div>;
    }

    if (layout === "spotlight") {
        const others = cameras.filter((c) => c !== onAir);
        return (
            <div className={`w-full h-full flex bg-black ${gap}`}>
                <div className="flex-[3] min-w-0">{tile(onAir)}</div>
                <div className={`flex-1 min-w-0 flex flex-col justify-center ${gap}`}>
                    {others.map((c) => (
                        <div key={c} className="w-full aspect-video max-h-full min-h-0">
                            {tile(c)}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    const cols = gridColumns(cameras.length);
    const rows = Math.ceil(cameras.length / cols);
    return (
        <div
            className={`w-full h-full grid bg-black ${gap}`}
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        >
            {cameras.map(tile)}
        </div>
    );
};

export default PresentationStage;
