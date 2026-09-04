// components/board/BoardHome.tsx
//
// The Board feature's landing screen - shown whenever the sidebar's Board icon is clicked, "just
// like the home screen" (same empty-state visual language as Dashboard.tsx's own selectedFile ===
// null branch) but listing saved boards instead of recent files, plus a prominent "New board"
// tile. Makes resume-vs-start-fresh an explicit choice rather than silently guessing which one
// the user wants.
import React, { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { IoAdd, IoChevronDown, IoCopyOutline, IoEllipsisVertical, IoImagesOutline, IoSearchOutline, IoTrashOutline } from "react-icons/io5";
import { BoardSummary, createEmptyBoardDocument, DEFAULT_BOARD_HEIGHT, DEFAULT_BOARD_WIDTH } from "../../utils/boardTypes";
import { applyBoardTemplate, BOARD_TEMPLATES, BoardTemplate } from "../../utils/boardTemplates";
import { BOARD_SIZE_PRESET_GROUPS, BOARD_SIZE_PRESETS, BoardSizePreset } from "../../utils/boardCanvasSizes";

// Small CSS-only preview swatch for a template card - no need for a real canvas render just to
// preview a background choice, since a template only ever sets background/padding fields.
function templatePreviewStyle(template: BoardTemplate): React.CSSProperties {
  if (template.backgroundMode === "grid" && template.backgroundGrid) {
    const { spacing, lineColor, baseColor } = template.backgroundGrid;
    // Scaled down from the board's own (much larger) spacing to something that reads as a grid
    // inside a small card rather than a handful of stray lines.
    const previewSpacing = Math.max(8, Math.round(spacing / 3));
    return {
      backgroundColor: baseColor ?? "transparent",
      backgroundImage: `linear-gradient(${lineColor} 1px, transparent 1px), linear-gradient(90deg, ${lineColor} 1px, transparent 1px)`,
      backgroundSize: `${previewSpacing}px ${previewSpacing}px`,
    };
  }
  return { backgroundColor: template.backgroundColor ?? "transparent" };
}

interface BoardHomeProps {
  onOpenBoard: (id: string) => void;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const BoardHome: React.FC<BoardHomeProps> = ({ onOpenBoard }) => {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which card's 3-dot menu is open, if any - and, within that menu, whether "Delete" has already
  // been clicked once (turning it into "Confirm delete?"). Board deletion is permanent (unlike
  // regular file deletion elsewhere in this app, which goes to Trash first - see boards.rs's
  // delete_board), so it gets this in-menu two-step confirm rather than the single-click delete
  // the sidebar's own file menu uses. A real native confirm dialog would be cleaner, but the
  // Tauri dialog allowlist only enables "message"/"open", not "ask" - not worth widening just
  // for this one case.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const refresh = useCallback(() => {
    invoke<BoardSummary[]>("list_boards")
      .then(setBoards)
      .catch((err) => {
        console.error("Failed to list boards:", err);
        setError(err instanceof Error ? err.message : String(err));
        setBoards([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Closes an open card menu (and drops any pending delete confirmation with it) on any click
  // outside it - the menu/menu-button themselves stopPropagation their own "click" so this only
  // ever fires for genuine "clicked elsewhere" clicks. Must be "click", not "mousedown": mousedown
  // fires before click for the same tap, so listening on mousedown here closed the menu (and wiped
  // confirmDeleteId) before a click on "Delete board"/"Confirm delete?" - whose stopPropagation is
  // on *click* - ever got a chance to run, silently eating every delete click.
  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (): void => {
      setOpenMenuId(null);
      setConfirmDeleteId(null);
    };
    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [openMenuId]);

  const handleDeleteBoard = useCallback(async (id: string): Promise<void> => {
    try {
      await invoke("delete_board", { id });
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      setBoards((prev) => prev?.filter((b) => b.id !== id) ?? prev);
    } catch (err) {
      console.error("Failed to delete board:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const handleDuplicateBoard = useCallback(
    async (board: BoardSummary): Promise<void> => {
      setDuplicatingId(board.id);
      setOpenMenuId(null);
      setConfirmDeleteId(null);
      try {
        const newId = crypto.randomUUID();
        // duplicate_board (Rust) only copies files verbatim - see its own doc comment for why.
        // Load the copy back and patch id/name/timestamps ourselves here, same "frontend owns the
        // document shape" division of labor every other board command already follows.
        await invoke("duplicate_board", { sourceId: board.id, newId });
        const json = await invoke<string>("load_board", { id: newId });
        const doc = JSON.parse(json);
        doc.id = newId;
        doc.name = `${board.name || "Untitled board"} copy`;
        const now = new Date().toISOString();
        doc.createdAt = now;
        doc.updatedAt = now;
        await invoke("save_board", { id: newId, json: JSON.stringify(doc) });
        refresh();
      } catch (err) {
        console.error("Failed to duplicate board:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDuplicatingId(null);
      }
    },
    [refresh]
  );

  // Which card's 3-dot menu is open reuses the click-outside pattern above; the template picker
  // below is its own toggle since it's a completely separate popover off a different button.
  const [showTemplates, setShowTemplates] = useState(false);
  // Paired with the style template below, not a replacement for it - this picks the new board's
  // starting canvasWidth/Height (see boardCanvasSizes.ts), the style template picks its background/
  // padding; a click on a style tile creates the board using whichever size is selected here. null =
  // createEmptyBoardDocument's own default size (1600x1000), same as if this row never existed.
  const [selectedSize, setSelectedSize] = useState<BoardSizePreset | null>(null);

  useEffect(() => {
    if (!showTemplates) return;
    const close = () => setShowTemplates(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showTemplates]);

  const handleCreate = useCallback(
    async (template: BoardTemplate) => {
      setIsCreating(true);
      setShowTemplates(false);
      setError(null);
      try {
        const id = crypto.randomUUID();
        const existingCount = boards?.length ?? 0;
        let doc = applyBoardTemplate(createEmptyBoardDocument(id, `Board ${existingCount + 1}`), template);
        if (selectedSize) doc = { ...doc, canvasWidth: selectedSize.width, canvasHeight: selectedSize.height };
        await invoke("create_board", { id, name: doc.name, json: JSON.stringify(doc) });
        onOpenBoard(id);
      } catch (err) {
        console.error("Failed to create board:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsCreating(false);
      }
    },
    [boards, onOpenBoard]
  );

  return (
    <div className="relative flex flex-col items-center justify-start h-full w-full gap-6 px-8 py-10 overflow-y-auto">
      <div className="relative flex flex-col items-center gap-3 text-center">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-gray-200 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
          <IoImagesOutline size={28} />
        </div>
        <div>
          <p className="text-gray-700 dark:text-neutral-200 font-medium">Boards</p>
          <p className="text-gray-500 dark:text-neutral-400 text-sm mt-1">
            Arrange several images into one composed layout, then export it as a new image.
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowTemplates((prev) => !prev);
            }}
            disabled={isCreating}
            className="mt-1 flex items-center gap-1.5 px-4 py-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <IoAdd size={16} /> New board
            <IoChevronDown size={14} className={`transition-transform ${showTemplates ? "rotate-180" : ""}`} />
          </button>

          {/* Template picker - a starting background/padding preset, not a locked-in choice (see
              boardTemplates.ts's own doc comment: every field it sets stays freely editable
              afterward). No portal needed here (unlike BoardEditor.tsx's own dropdowns) - nothing
              in this tree uses a stacking-context-creating filter/backdrop-blur. */}
          {showTemplates && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-80 rounded-xl bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 shadow-xl p-3 z-20"
            >
              {/* Paired with the style template grid below (see selectedSize's own doc comment) -
                  picks the new board's starting canvas size, most usefully one of the named
                  social-platform presets (Instagram Post/Story, etc. - see boardCanvasSizes.ts) so
                  a board meant for a specific platform starts at that platform's exact pixel
                  dimensions instead of needing a resize later. */}
              <label className="flex items-center justify-between gap-2 mb-3 px-1">
                <span className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500">Size</span>
                <select
                  value={selectedSize?.id ?? "default"}
                  onChange={(e) => setSelectedSize(BOARD_SIZE_PRESETS.find((p) => p.id === e.target.value) ?? null)}
                  className="flex-1 max-w-[190px] h-7 px-1.5 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-700 dark:text-neutral-200 text-xs outline-none"
                >
                  <option value="default">
                    Default ({DEFAULT_BOARD_WIDTH}×{DEFAULT_BOARD_HEIGHT})
                  </option>
                  {BOARD_SIZE_PRESET_GROUPS.map((group) => (
                    <optgroup key={group} label={group}>
                      {BOARD_SIZE_PRESETS.filter((preset) => preset.group === group).map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label} ({preset.width}×{preset.height})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 px-1">Start from a template</p>
              <div className="grid grid-cols-3 gap-2">
                {BOARD_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => void handleCreate(template)}
                    disabled={isCreating}
                    className="group flex flex-col gap-1.5 rounded-lg text-left disabled:opacity-50"
                  >
                    <div
                      style={templatePreviewStyle(template)}
                      className="aspect-square rounded-md border border-gray-200 dark:border-neutral-700 group-hover:border-blue-400 dark:group-hover:border-blue-500 transition-colors"
                    />
                    <span className="text-[11px] text-gray-600 dark:text-neutral-300 truncate px-0.5">{template.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {error && <p className="text-red-500 dark:text-red-400 text-xs">{error}</p>}
      </div>

      {boards && boards.length > 0 && (
        <div className="relative w-full max-w-3xl">
          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">Your boards</p>
          {/* Only worth the extra chrome once there's enough boards that scanning the grid by eye
              stops being faster than typing a name - a handful of boards doesn't need a search box
              sitting above them. */}
          {boards.length > 6 && (
            <div className="relative max-w-xs mx-auto mb-3">
              <IoSearchOutline size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search boards..."
                className="w-full h-8 pl-8 pr-2.5 rounded-md border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-sm text-gray-700 dark:text-neutral-200 outline-none focus:border-blue-400 dark:focus:border-blue-500 transition-colors"
              />
            </div>
          )}
          {(() => {
            const query = searchQuery.trim().toLowerCase();
            const filteredBoards = query ? boards.filter((board) => (board.name || "Untitled board").toLowerCase().includes(query)) : boards;
            if (filteredBoards.length === 0) {
              return <p className="text-center text-sm text-gray-400 dark:text-neutral-500 py-6">No boards match "{searchQuery.trim()}"</p>;
            }
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {filteredBoards.map((board) => (
              // A plain div (not <button>) - it needs to contain the 3-dot menu's own <button>,
              // and nested interactive elements aren't valid HTML/accessible; role="button" +
              // tabIndex + onKeyDown keep it keyboard-operable instead.
              <div
                key={board.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpenBoard(board.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenBoard(board.id);
                  }
                }}
                // No overflow-hidden here - it would clip the dropdown menu below, since the menu
                // is a descendant of this card. Only the thumbnail image itself needs clipping to
                // the card's rounded top corners, so that lives on its own inner div instead.
                className="group relative flex flex-col rounded-md bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors cursor-pointer"
              >
                <div className="absolute top-1.5 right-1.5 z-10">
                  <button
                    type="button"
                    title="Board options"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                      setOpenMenuId((prev) => (prev === board.id ? null : board.id));
                    }}
                    className={`p-1 rounded-md bg-black/40 hover:bg-black/60 text-white transition-opacity ${
                      openMenuId === board.id ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    <IoEllipsisVertical size={14} />
                  </button>

                  {openMenuId === board.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => void handleDuplicateBoard(board)}
                        disabled={duplicatingId === board.id}
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 disabled:opacity-50"
                      >
                        <IoCopyOutline size={14} />
                        {duplicatingId === board.id ? "Duplicating…" : "Duplicate board"}
                      </button>
                      <div className="border-t border-gray-100 dark:border-neutral-700/70" />
                      <button
                        type="button"
                        onClick={() => (confirmDeleteId === board.id ? void handleDeleteBoard(board.id) : setConfirmDeleteId(board.id))}
                        className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                      >
                        <IoTrashOutline size={14} />
                        {confirmDeleteId === board.id ? "Confirm delete?" : "Delete board"}
                      </button>
                    </div>
                  )}
                </div>

                <div className="aspect-video rounded-t-md overflow-hidden bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                  {board.thumbnail_path ? (
                    <img src={convertFileSrc(board.thumbnail_path)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <IoImagesOutline size={22} className="text-gray-300 dark:text-neutral-600" />
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <p className="text-sm text-gray-700 dark:text-neutral-200 truncate">{board.name || "Untitled board"}</p>
                  <p className="text-xs text-gray-400 dark:text-neutral-500">{formatUpdatedAt(board.updated_at)}</p>
                </div>
              </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

export default BoardHome;
