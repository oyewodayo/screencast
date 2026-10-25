// components/video/SharePanel.tsx
//
// Share a finished export without leaving Briefcast (google_share.rs does the uploading):
//   - YouTube: title, description with the video's chapters as timestamps (YouTube turns those
//     into chapters), tags, category, privacy, the made-for-kids answer YouTube requires, and the
//     timeline's captions attached as the video's subtitle track;
//   - Share link: the file on the user's own Google Drive, viewable by anyone with the link;
//   - Send: the Windows share sheet, or the file on the clipboard to paste into any chat or mail.
// Everything starts from the export's own snapshot (ShareMeta, exportQueue.ts), so it describes
// the file that was rendered - not whatever the timeline has become since.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IoClose, IoCopyOutline, IoLinkOutline, IoLogoYoutube, IoOpenOutline, IoShareSocialOutline } from "react-icons/io5";
import type { ShareMeta } from "../../utils/exportQueue";
import { youtubeChapterLines } from "../../utils/videoChapters";

interface Props {
  filePath: string;
  meta: ShareMeta;
  durationSec: number;
  onClose: () => void;
}

interface GoogleAccount {
  email: string;
  name?: string | null;
  picture?: string | null;
}
interface GoogleStatus {
  configured: boolean;
  account: GoogleAccount | null;
}
interface YouTubeResult {
  videoId: string;
  url: string;
  studioUrl: string;
  privacy: string;
  captionsError: string | null;
}

type Tab = "youtube" | "link" | "send";
type Privacy = "private" | "unlisted" | "public";
type Upload = { jobId: string; sent: number; total: number; stage: string } | null;

const CATEGORIES: [string, string][] = [
  ["27", "Education"],
  ["28", "Science & Technology"],
  ["26", "Howto & Style"],
  ["22", "People & Blogs"],
  ["24", "Entertainment"],
  ["25", "News & Politics"],
  ["20", "Gaming"],
  ["10", "Music"],
  ["1", "Film & Animation"],
  ["17", "Sports"],
  ["19", "Travel & Events"],
  ["29", "Nonprofits & Activism"],
];

const PREFS_KEY = "briefcast.youtubeShare";
const loadPrefs = (): { privacy?: Privacy; category?: string; tab?: Tab } => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const savePrefs = (p: { privacy?: Privacy; category?: string; tab?: Tab }) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    // Per-viewer convenience only.
  }
};

const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const openUrl = (url: string) => invoke("open_share_url", { url }).catch(() => {});
const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

const SharePanel: React.FC<Props> = ({ filePath, meta, durationSec, onClose }) => {
  const prefs = useMemo(loadPrefs, []);
  const [tab, setTab] = useState<Tab>(prefs.tab ?? "youtube");
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chapterInfo = useMemo(() => youtubeChapterLines(meta.chapters, durationSec), [meta.chapters, durationSec]);
  const [title, setTitle] = useState(meta.title);
  const [includeChapters, setIncludeChapters] = useState(chapterInfo.lines.length > 0 && !chapterInfo.problem);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [category, setCategory] = useState(prefs.category ?? "27");
  const [privacy, setPrivacy] = useState<Privacy>(prefs.privacy ?? "private");
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null);
  const [includeCaptions, setIncludeCaptions] = useState(!!meta.srt);
  const [upload, setUpload] = useState<Upload>(null);
  const [ytResult, setYtResult] = useState<YouTubeResult | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const description = useMemo(() => {
    const parts = [body.trim()];
    if (includeChapters && chapterInfo.lines.length) parts.push(chapterInfo.lines.join("\n"));
    return parts.filter(Boolean).join("\n\n");
  }, [body, includeChapters, chapterInfo]);

  useEffect(() => {
    invoke<GoogleStatus>("google_account_status").then(setStatus).catch(() => setStatus({ configured: false, account: null }));
  }, []);
  useEffect(() => {
    const p = listen<{ jobId: string; sent: number; total: number; stage: string }>("share-upload-progress", (e) => {
      setUpload((u) => (u && u.jobId === e.payload.jobId ? { ...u, ...e.payload } : u));
    });
    return () => {
      void p.then((un) => un());
    };
  }, []);
  // Esc closes - unless an upload is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !upload) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, upload]);

  const signIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      const account = await invoke<GoogleAccount>("google_sign_in");
      setStatus((s) => ({ configured: s?.configured ?? true, account }));
    } catch (err) {
      setError(String(err));
    } finally {
      setSigningIn(false);
    }
  };
  const signOut = async () => {
    await invoke("google_sign_out").catch(() => {});
    setStatus((s) => (s ? { ...s, account: null } : s));
  };

  const uploadToYouTube = async () => {
    if (madeForKids === null) {
      setError("YouTube needs to know whether this video is made for kids");
      return;
    }
    const jobId = crypto.randomUUID();
    setError(null);
    setYtResult(null);
    setUpload({ jobId, sent: 0, total: 1, stage: "starting" });
    savePrefs({ privacy, category });
    try {
      const result = await invoke<YouTubeResult>("youtube_upload", {
        request: {
          jobId,
          path: filePath,
          title,
          description,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          categoryId: category,
          privacy,
          madeForKids,
          captionsSrt: includeCaptions ? meta.srt : null,
          captionsLanguage: meta.language,
        },
      });
      setYtResult(result);
    } catch (err) {
      if (!/cancel/i.test(String(err))) setError(String(err));
    } finally {
      setUpload(null);
    }
  };
  const makeLink = async () => {
    const jobId = crypto.randomUUID();
    setError(null);
    setLink(null);
    setUpload({ jobId, sent: 0, total: 1, stage: "starting" });
    try {
      const result = await invoke<{ fileId: string; link: string }>("drive_share_link", { request: { jobId, path: filePath, name: fileName(filePath) } });
      setLink(result.link);
    } catch (err) {
      if (!/cancel/i.test(String(err))) setError(String(err));
    } finally {
      setUpload(null);
    }
  };
  const cancelUpload = () => upload && void invoke("cancel_share_upload", { jobId: upload.jobId });

  const needsGoogle = tab === "youtube" || tab === "link";
  const account = status?.account ?? null;
  const pct = upload ? Math.min(100, Math.round((upload.sent / Math.max(1, upload.total)) * 100)) : 0;
  const tabBtn = (t: Tab, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => {
        setTab(t);
        savePrefs({ tab: t });
        setError(null);
      }}
      disabled={!!upload}
      className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md text-[12px] transition-colors ${tab === t ? "bg-white/15 text-white" : "text-white/55 hover:text-white hover:bg-white/5"}`}
    >
      {icon}
      {label}
    </button>
  );
  const field = "w-full bg-white/[0.07] rounded-md px-2.5 py-1.5 text-[12px] text-white outline-none ring-1 ring-white/10 focus:ring-blue-400/60";

  const progressBlock = upload && (
    <div className="flex flex-col gap-1.5 rounded-lg bg-white/[0.05] p-2.5">
      <div className="flex items-center justify-between text-[11px] text-white/70">
        <span>
          {upload.stage === "processing" ? "Finishing up…" : upload.stage === "captions" ? "Adding captions…" : upload.stage === "starting" ? "Starting…" : `Uploading ${megabytes(upload.sent)} of ${megabytes(upload.total)}`}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-blue-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <button type="button" onClick={cancelUpload} className="self-end px-2 py-0.5 rounded text-[11px] text-white/60 hover:text-white hover:bg-white/10">
        Cancel upload
      </button>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onPointerDown={(e) => e.target === e.currentTarget && !upload && onClose()}>
      <div className="w-[480px] max-w-[94vw] max-h-[90vh] overflow-y-auto rounded-2xl bg-neutral-900 ring-1 ring-white/10 shadow-2xl text-white/90 flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <IoShareSocialOutline size={16} />
          <span className="flex-1 min-w-0 truncate text-[14px] font-semibold" title={filePath}>
            Share {fileName(filePath)}
          </span>
          <button type="button" title="Close" disabled={!!upload} onClick={onClose} className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30">
            <IoClose size={16} />
          </button>
        </div>
        <div className="flex gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
          {tabBtn("youtube", <IoLogoYoutube size={14} className="text-red-400" />, "YouTube")}
          {tabBtn("link", <IoLinkOutline size={14} />, "Share link")}
          {tabBtn("send", <IoShareSocialOutline size={14} />, "Send")}
        </div>

        {needsGoogle && status && !status.configured && (
          <p className="text-[12px] leading-relaxed text-white/60 rounded-lg bg-amber-500/10 ring-1 ring-amber-400/20 p-3">
            Uploading to YouTube and Drive needs Briefcast's Google sign-in, which isn't set up in this build. You can still use <b>Send</b> to share the file.
          </p>
        )}
        {needsGoogle && status?.configured && (
          <div className="flex items-center gap-2 text-[12px] rounded-lg bg-white/[0.04] px-2.5 py-2">
            {account ? (
              <>
                {account.picture ? <img src={account.picture} alt="" className="w-6 h-6 rounded-full" referrerPolicy="no-referrer" /> : <span className="w-6 h-6 rounded-full bg-white/10" />}
                <span className="flex-1 min-w-0 truncate">
                  {account.name ? `${account.name} · ` : ""}
                  <span className="text-white/55">{account.email}</span>
                </span>
                <button type="button" disabled={!!upload} onClick={() => void signOut()} className="text-[11px] text-white/45 hover:text-white/80">
                  Sign out
                </button>
              </>
            ) : (
              <>
                <span className="flex-1 text-white/60">{signingIn ? "Finish signing in in your browser…" : "Sign in to your Google account to upload"}</span>
                {signingIn ? (
                  <button type="button" onClick={() => void invoke("google_cancel_sign_in")} className="px-2.5 py-1 rounded-md text-white/70 hover:bg-white/10">
                    Cancel
                  </button>
                ) : (
                  <button type="button" onClick={() => void signIn()} className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white font-medium">
                    Sign in with Google
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {tab === "youtube" && (
          <div className={`flex flex-col gap-2.5 ${!account || !status?.configured ? "opacity-50 pointer-events-none" : ""}`}>
            {ytResult ? (
              <div className="flex flex-col gap-2 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/25 p-3 text-[12px]">
                <span className="font-medium text-emerald-200">It's on YouTube{ytResult.privacy !== privacy ? ` (as ${ytResult.privacy})` : ""}.</span>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 truncate rounded bg-black/30 px-2 py-1 text-[11px]">{ytResult.url}</code>
                  <button type="button" title="Copy the link" onClick={() => void copy(ytResult.url)} className="p-1.5 rounded hover:bg-white/10">
                    <IoCopyOutline size={13} />
                  </button>
                  <button type="button" title="Open it" onClick={() => void openUrl(ytResult.url)} className="p-1.5 rounded hover:bg-white/10">
                    <IoOpenOutline size={13} />
                  </button>
                </div>
                {ytResult.privacy !== privacy && (
                  <span className="text-[11px] text-amber-200/80">
                    YouTube kept it {ytResult.privacy}: apps that haven't completed YouTube's API audit can only upload private videos. Change it in YouTube Studio.
                  </span>
                )}
                {ytResult.captionsError && <span className="text-[11px] text-amber-200/80">The video is up, but the captions weren't added: {ytResult.captionsError}</span>}
                <button type="button" onClick={() => void openUrl(ytResult.studioUrl)} className="self-start text-[11px] text-white/60 hover:text-white underline-offset-2 hover:underline">
                  Open in YouTube Studio
                </button>
              </div>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-[11px] text-white/55">
                  <span className="flex justify-between">
                    Title <span className="tabular-nums text-white/30">{title.length}/100</span>
                  </span>
                  <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} className={field} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-white/55">
                  Description
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What's this video about?" className={`${field} resize-y`} />
                </label>
                {chapterInfo.lines.length > 0 && (
                  <div className="flex flex-col gap-1.5 rounded-lg bg-white/[0.04] p-2.5">
                    <label className="flex items-center gap-2 text-[12px]">
                      <input type="checkbox" checked={includeChapters} onChange={(e) => setIncludeChapters(e.target.checked)} />
                      Chapters in the description <span className="text-white/40">({chapterInfo.lines.length})</span>
                    </label>
                    {chapterInfo.problem ? (
                      <span className="text-[11px] text-amber-200/80">{chapterInfo.problem} - they'll show as timestamps but not as chapters.</span>
                    ) : null}
                    {includeChapters && <pre className="max-h-28 overflow-y-auto text-[11px] leading-relaxed text-white/65 font-mono whitespace-pre-wrap">{chapterInfo.lines.join("\n")}</pre>}
                  </div>
                )}
                {meta.srt && (
                  <label className="flex items-center gap-2 text-[12px] rounded-lg bg-white/[0.04] p-2.5">
                    <input type="checkbox" checked={includeCaptions} onChange={(e) => setIncludeCaptions(e.target.checked)} />
                    Add the captions as subtitles{meta.language ? <span className="text-white/40">({meta.language})</span> : null}
                  </label>
                )}
                <label className="flex flex-col gap-1 text-[11px] text-white/55">
                  Tags <span className="text-white/30">comma separated</span>
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="research, lecture, tutorial" className={field} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-white/55">
                    Visibility
                    <select value={privacy} onChange={(e) => setPrivacy(e.target.value as Privacy)} className={field}>
                      <option value="private" className="bg-neutral-900">Private - only you</option>
                      <option value="unlisted" className="bg-neutral-900">Unlisted - anyone with the link</option>
                      <option value="public" className="bg-neutral-900">Public - everyone</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-white/55">
                    Category
                    <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
                      {CATEGORIES.map(([id, name]) => (
                        <option key={id} value={id} className="bg-neutral-900">
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <fieldset className="flex flex-col gap-1 text-[12px]">
                  <legend className="text-[11px] text-white/55 mb-1">Is it made for kids? (YouTube asks every upload)</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="kids" checked={madeForKids === false} onChange={() => setMadeForKids(false)} /> No, it's not made for kids
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="kids" checked={madeForKids === true} onChange={() => setMadeForKids(true)} /> Yes, it's made for kids
                  </label>
                </fieldset>
                {progressBlock}
                {!upload && (
                  <button
                    type="button"
                    onClick={() => void uploadToYouTube()}
                    disabled={!title.trim()}
                    className="self-end flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-[12px] font-medium"
                  >
                    <IoLogoYoutube size={14} /> Upload to YouTube
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {tab === "link" && (
          <div className={`flex flex-col gap-2.5 ${!account || !status?.configured ? "opacity-50 pointer-events-none" : ""}`}>
            <p className="text-[12px] leading-relaxed text-white/60">
              Puts the video on your Google Drive and makes a link anyone can watch it from - no sign-in needed to view. Only you can change or delete it, from Drive.
            </p>
            {link ? (
              <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-400/25 p-2.5">
                <code className="flex-1 min-w-0 truncate rounded bg-black/30 px-2 py-1 text-[11px]">{link}</code>
                <button type="button" title="Copy the link" onClick={() => void copy(link)} className="p-1.5 rounded hover:bg-white/10">
                  <IoCopyOutline size={13} />
                </button>
                <button type="button" title="Open it" onClick={() => void openUrl(link)} className="p-1.5 rounded hover:bg-white/10">
                  <IoOpenOutline size={13} />
                </button>
              </div>
            ) : (
              <>
                {progressBlock}
                {!upload && (
                  <button type="button" onClick={() => void makeLink()} className="self-end flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-medium">
                    <IoLinkOutline size={14} /> Create share link
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {tab === "send" && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() =>
                invoke("share_file_native", { path: filePath, title: title || fileName(filePath), description: "" })
                  .then(() => setSent("Pick where to send it in the share window"))
                  .catch((e) => setError(String(e)))
              }
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[12px] text-left"
            >
              <IoShareSocialOutline size={15} /> Share with an app (Mail, Teams, WhatsApp, Nearby Share…)
            </button>
            <button
              type="button"
              onClick={() =>
                invoke("copy_file_to_clipboard", { path: filePath })
                  .then(() => setSent("Copied - paste it into a chat, an email or a folder"))
                  .catch((e) => setError(String(e)))
              }
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[12px] text-left"
            >
              <IoCopyOutline size={15} /> Copy the file to paste anywhere
            </button>
            {sent && <span className="text-[11px] text-emerald-300/90">{sent}</span>}
          </div>
        )}

        {error && <div className="rounded-md bg-red-950/60 ring-1 ring-red-800 px-2.5 py-1.5 text-[11px] text-red-200 break-words">{error}</div>}
      </div>
    </div>,
    document.body
  );
};

export default SharePanel;
