// components/docs/DocShareDialog.tsx
//
// "Email this file" / "Share this file" - getting the document to someone without first saving it
// somewhere and going looking for it. The chosen format is exported into a staging folder
// (share_staging_path in services/share.rs) under the document's own title, then handed on:
//   Email - straight into the desktop mail client with the file attached (Simple MAPI), or into
//           Gmail / Outlook / Yahoo / the default mail app with the file on the clipboard to paste.
//   Share - the Windows share sheet (every share target installed on the PC), or a chat app opened
//           with the file on the clipboard, or the file / its formatted contents copied to paste
//           anywhere.
// Each format is exported at most once per opening of the dialog; the document can't change while
// it's open.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoClose } from "react-icons/io5";
import { MdAttachFile, MdCheckCircle, MdContentCopy, MdContentPaste, MdErrorOutline, MdFileDownload, MdIosShare, MdMailOutline } from "react-icons/md";
import { FaDiscord, FaSlack, FaTelegramPlane, FaWhatsapp, FaYahoo } from "react-icons/fa";
import { SiGmail, SiMicrosoftoutlook, SiMicrosoftteams } from "react-icons/si";

export type ShareFormat = "pdf" | "docx" | "html" | "md" | "txt";
export type ShareMode = "email" | "share";

interface DocShareDialogProps {
  title: string;
  pageCount: number;
  wordCount: number;
  initialMode: ShareMode;
  /** Writes the document as `format` to outputPath; resolves to the path written. */
  writeExport: (format: ShareFormat, outputPath: string) => Promise<string>;
  /** The document as clipboard-ready formatted HTML plus a plain-text fallback. */
  getClipboardContent: () => Promise<{ html: string; text: string }>;
  /** The regular Save-dialog export, for "Save a copy". */
  onSaveCopy: (format: ShareFormat) => void;
  onClose: () => void;
}

const FORMATS: { id: ShareFormat; label: string }[] = [
  { id: "pdf", label: "PDF" },
  { id: "docx", label: "Word" },
  { id: "html", label: "Web page" },
  { id: "md", label: "Markdown" },
  { id: "txt", label: "Text" },
];

const FORMAT_NAMES: Record<ShareFormat, string> = { pdf: "PDF", docx: "Word document", html: "web page", md: "Markdown file", txt: "text file" };

type IconType = React.ComponentType<{ size?: number; className?: string }>;

// Chat apps: opened through their own URL scheme when installed (share_capabilities checks), else
// their web app. Neither takes a file through a URL, so the file goes on the clipboard first.
const CHAT_APPS: { id: string; name: string; scheme: string; app: string; web: string; icon: IconType; color: string }[] = [
  { id: "whatsapp", name: "WhatsApp", scheme: "whatsapp", app: "whatsapp://", web: "https://web.whatsapp.com/", icon: FaWhatsapp, color: "#25D366" },
  { id: "telegram", name: "Telegram", scheme: "tg", app: "tg://", web: "https://web.telegram.org/", icon: FaTelegramPlane, color: "#26A5E4" },
  { id: "teams", name: "Teams", scheme: "msteams", app: "msteams:", web: "https://teams.microsoft.com/", icon: SiMicrosoftteams, color: "#5B5FC7" },
  { id: "slack", name: "Slack", scheme: "slack", app: "slack://open", web: "https://app.slack.com/client", icon: FaSlack, color: "#E01E5A" },
  { id: "discord", name: "Discord", scheme: "discord", app: "discord://", web: "https://discord.com/app", icon: FaDiscord, color: "#5865F2" },
];

const enc = encodeURIComponent;
const WEB_MAIL: { id: string; name: string; icon: IconType; color: string; url: (to: string, subject: string, body: string) => string }[] = [
  { id: "gmail", name: "Gmail", icon: SiGmail, color: "#EA4335", url: (to, su, body) => `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(su)}&body=${enc(body)}` },
  { id: "outlook", name: "Outlook", icon: SiMicrosoftoutlook, color: "#0078D4", url: (to, su, body) => `https://outlook.live.com/mail/0/deeplink/compose?to=${enc(to)}&subject=${enc(su)}&body=${enc(body)}` },
  { id: "yahoo", name: "Yahoo Mail", icon: FaYahoo, color: "#6001D2", url: (to, su, body) => `https://compose.mail.yahoo.com/?to=${enc(to)}&subject=${enc(su)}&body=${enc(body)}` },
  { id: "mailto", name: "Mail app", icon: MdMailOutline, color: "#5f6368", url: (to, su, body) => `mailto:${to.split(",").map((a) => enc(a.trim())).join(",")}?subject=${enc(su)}&body=${enc(body)}` },
];

interface Capabilities {
  native_share: boolean;
  mail_client: string | null;
  apps: string[];
}

interface Status {
  tone: "busy" | "ok" | "error";
  text: string;
  /** Offers "Show file" so the staged file can be dragged in where pasting doesn't take. */
  path?: string;
}

// Per-viewer conveniences only - the dialog works the same without them.
const STORE_FORMAT = "briefcast.share.format";
const STORE_RECIPIENTS = "briefcast.share.recipients";
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function fileBaseName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "Document").slice(0, 120);
}

function splitRecipients(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

const field =
  "w-full px-3 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400";
const fieldLabel = "block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1";
const tileClass =
  "group flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-xs text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 disabled:opacity-50 disabled:pointer-events-none transition-colors";
const secondaryButton =
  "inline-flex items-center gap-2 h-9 px-3.5 rounded-full text-sm font-medium border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 disabled:opacity-50 disabled:pointer-events-none transition-colors";

const DocShareDialog: React.FC<DocShareDialogProps> = ({ title, pageCount, wordCount, initialMode, writeExport, getClipboardContent, onSaveCopy, onClose }) => {
  const [mode, setMode] = useState<ShareMode>(initialMode);
  const [format, setFormat] = useState<ShareFormat>(() => {
    const stored = readStored<string>(STORE_FORMAT, "pdf");
    return FORMATS.some((f) => f.id === stored) ? (stored as ShareFormat) : "pdf";
  });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(title || "Document");
  const [message, setMessage] = useState("");
  const [messageEdited, setMessageEdited] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readStored<string[]>(STORE_RECIPIENTS, []).filter((r) => typeof r === "string").slice(0, 8));

  const baseName = fileBaseName(title);
  const fileName = `${baseName}.${format}`;

  // The default message follows the format until the user writes their own.
  useEffect(() => {
    if (messageEdited) return;
    const size = format === "pdf" || format === "docx" ? ` (${pageCount} ${pageCount === 1 ? "page" : "pages"})` : "";
    setMessage(`Hi,\n\nPlease find attached "${title || "Document"}"${size}.\n\nBest regards,\n`);
  }, [format, title, pageCount, messageEdited]);

  useEffect(() => {
    let live = true;
    invoke<Capabilities>("share_capabilities", { schemes: CHAT_APPS.map((a) => a.scheme) })
      .then((c) => live && setCaps(c))
      .catch(() => live && setCaps({ native_share: false, mail_client: null, apps: [] }));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const pickFormat = (f: ShareFormat) => {
    setFormat(f);
    writeStored(STORE_FORMAT, f);
  };

  // One export per format per dialog opening; a failed one is dropped so a retry re-exports.
  const staged = useRef(new Map<ShareFormat, Promise<string>>());
  const stage = useCallback(
    (f: ShareFormat): Promise<string> => {
      const cached = staged.current.get(f);
      if (cached) return cached;
      const job = (async () => {
        const target = await invoke<string>("share_staging_path", { fileName: `${baseName}.${f}` });
        return writeExport(f, target);
      })();
      staged.current.set(f, job);
      job.catch(() => staged.current.delete(f));
      return job;
    },
    [baseName, writeExport]
  );

  // Every action: export (if needed), then the action itself, with one status line throughout.
  const run = useCallback(
    async (action: (path: string) => Promise<Status | null>) => {
      if (busy) return;
      setBusy(true);
      setStatus({ tone: "busy", text: staged.current.has(format) ? "Preparing…" : `Preparing ${fileName}…` });
      try {
        const path = await stage(format);
        setStatus(await action(path));
      } catch (err) {
        setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusy(false);
      }
    },
    [busy, format, fileName, stage]
  );

  const rememberRecipients = () => {
    const added = splitRecipients(to);
    if (!added.length) return;
    const next = [...added, ...recent.filter((r) => !added.some((a) => a.toLowerCase() === r.toLowerCase()))].slice(0, 8);
    setRecent(next);
    writeStored(STORE_RECIPIENTS, next);
  };

  const toggleRecipient = (address: string) => {
    const list = splitRecipients(to);
    const has = list.some((a) => a.toLowerCase() === address.toLowerCase());
    setTo((has ? list.filter((a) => a.toLowerCase() !== address.toLowerCase()) : [...list, address]).join(", "));
  };

  // Neither web mail nor chat apps take a file through a URL: the file goes on the clipboard, the
  // app opens, and the status line says where to paste (with "Show file" for drag and drop).
  const copyAndOpen = async (path: string, url: string, hint: string): Promise<Status> => {
    await invoke("copy_file_to_clipboard", { path });
    await invoke("open_share_url", { url });
    return { tone: "ok", text: `${fileName} is copied. ${hint}`, path };
  };

  const emailWithClient = () =>
    run(async (path) => {
      rememberRecipients();
      const outcome = await invoke<"opened" | "cancelled" | "unavailable">("email_file", { path, subject, body: message, to: splitRecipients(to) });
      if (outcome === "opened") return { tone: "ok", text: `Email draft opened in ${caps?.mail_client ?? "your mail app"} with ${fileName} attached.` };
      if (outcome === "cancelled") return null;
      setCaps((c) => (c ? { ...c, mail_client: null } : c));
      return { tone: "error", text: "Your mail app didn't accept the attachment. Pick a mail service below instead." };
    });

  const emailWithWeb = (service: (typeof WEB_MAIL)[number]) =>
    run(async (path) => {
      rememberRecipients();
      const where = service.id === "mailto" ? "the new message" : `the ${service.name} message`;
      // A compose link can't carry an attachment (no web mail accepts one), so the file's folder
      // opens alongside with it selected - one drag into the message attaches it.
      await invoke("open_file_from_directory", { filepath: path });
      return copyAndOpen(
        path,
        service.url(splitRecipients(to).join(","), subject, message),
        `Web mail can't receive attachments through a link - drag the selected file from the folder that opened into ${where}, or press Ctrl+V there.`
      );
    });

  const shareNative = () =>
    run(async (path) => {
      await invoke("share_file_native", { path, title: title || "Document", description: `${FORMAT_NAMES[format]} · ${fileName}` });
      return null;
    });

  const shareToApp = (app: (typeof CHAT_APPS)[number]) =>
    run(async (path) => {
      const installed = caps?.apps.includes(app.scheme) ?? false;
      return copyAndOpen(path, installed ? app.app : app.web, `In ${app.name}, open a chat and press Ctrl+V to send it.`);
    });

  const copyFile = () =>
    run(async (path) => {
      await invoke("copy_file_to_clipboard", { path });
      return { tone: "ok", text: `${fileName} is copied - paste it into any chat, email or folder.`, path };
    });

  const copyContents = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { html, text } = await getClipboardContent();
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) }),
      ]);
      setStatus({ tone: "ok", text: "Contents copied with formatting - paste straight into an email body, chat or another document." });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const recipientsList = useMemo(() => splitRecipients(to).map((a) => a.toLowerCase()), [to]);
  const mailClient = caps?.mail_client ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 print:hidden" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-share-title"
        className="w-full max-w-[540px] max-h-full overflow-y-auto rounded-2xl bg-white dark:bg-neutral-800 border border-neutral-200/70 dark:border-neutral-700 shadow-[0_8px_32px_rgba(60,64,67,0.28)]"
      >
        <div className="flex items-start gap-3 px-6 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id="doc-share-title" className="text-lg font-medium text-neutral-900 dark:text-neutral-50 truncate">
              {mode === "email" ? "Email" : "Share"} “{title || "Untitled document"}”
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {pageCount} {pageCount === 1 ? "page" : "pages"} · {wordCount.toLocaleString()} words
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -mr-2 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div role="tablist" className="inline-flex p-0.5 rounded-full bg-neutral-100 dark:bg-neutral-900/60 text-sm">
            {(["email", "share"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1.5 h-8 px-4 rounded-full font-medium transition-colors ${
                  mode === m ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm" : "text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {m === "email" ? <MdMailOutline size={16} /> : <MdIosShare size={16} />}
                {m === "email" ? "Email" : "Share"}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <span className={fieldLabel}>Send as</span>
            <div className="flex flex-wrap gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={format === f.id}
                  onClick={() => pickFormat(f.id)}
                  className={`h-8 px-3 rounded-full text-sm border transition-colors ${
                    format === f.id
                      ? "border-transparent bg-[#c2e7ff] text-[#001d35] dark:bg-blue-500/30 dark:text-blue-50 font-medium"
                      : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {mode === "email" ? (
          <div className="px-6 pt-4 space-y-3">
            <div>
              <label htmlFor="doc-share-to" className={fieldLabel}>
                To <span className="font-normal text-neutral-400">(optional)</span>
              </label>
              <input id="doc-share-to" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, …" className={field} />
              {recent.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {recent.map((r) => {
                    const on = recipientsList.includes(r.toLowerCase());
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => toggleRecipient(r)}
                        className={`h-6 px-2 rounded-full text-xs border transition-colors ${
                          on ? "border-blue-500 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/15" : "border-neutral-200 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
                        }`}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <label htmlFor="doc-share-subject" className={fieldLabel}>
                Subject
              </label>
              <input id="doc-share-subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
            </div>
            <div>
              <label htmlFor="doc-share-message" className={fieldLabel}>
                Message
              </label>
              <textarea
                id="doc-share-message"
                rows={5}
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setMessageEdited(true);
                }}
                className={`${field} resize-none leading-relaxed`}
              />
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-neutral-50 dark:bg-neutral-900/50 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200">
              <MdAttachFile size={18} className="shrink-0 text-neutral-500" />
              <span className="truncate">{fileName}</span>
            </div>

            {mailClient && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void emailWithClient()}
                className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium bg-[#0b57d0] hover:bg-[#0a4dbb] text-white disabled:opacity-60 transition-colors"
              >
                <MdMailOutline size={18} />
                Open in {mailClient}
                <span className="font-normal opacity-80">· attached for you</span>
              </button>
            )}
            <div>
              <span className={fieldLabel}>{mailClient ? "Or write it in" : "Write it in"}</span>
              <div className="grid grid-cols-4 gap-1">
                {WEB_MAIL.map((s) => (
                  <button key={s.id} type="button" disabled={busy} onClick={() => void emailWithWeb(s)} className={tileClass}>
                    <span className="h-11 w-11 inline-flex items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-700" style={{ color: s.color }}>
                      <s.icon size={22} />
                    </span>
                    <span>{s.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="px-6 pt-4 space-y-4">
            {caps?.native_share && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void shareNative()}
                className="w-full flex items-center gap-3 rounded-xl border border-neutral-200 dark:border-neutral-700 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-700/40 disabled:opacity-60 transition-colors"
              >
                <span className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-full bg-[#c2e7ff] text-[#001d35] dark:bg-blue-500/25 dark:text-blue-50">
                  <MdIosShare size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">Share with an app…</span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">Nearby Share, Outlook, WhatsApp, Teams and every other share target on this PC</span>
                </span>
              </button>
            )}
            <div>
              <span className={fieldLabel}>Send in a chat</span>
              <div className="grid grid-cols-5 gap-1">
                {CHAT_APPS.map((a) => (
                  <button key={a.id} type="button" disabled={busy} onClick={() => void shareToApp(a)} className={tileClass} title={caps?.apps.includes(a.scheme) ? `Opens the ${a.name} app` : `Opens ${a.name} on the web`}>
                    <span className="h-11 w-11 inline-flex items-center justify-center rounded-full text-white" style={{ background: a.color }}>
                      <a.icon size={22} />
                    </span>
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void copyFile()} className={secondaryButton}>
                <MdContentCopy size={16} />
                Copy file
              </button>
              <button type="button" disabled={busy} onClick={() => void copyContents()} className={secondaryButton}>
                <MdContentPaste size={16} />
                Copy contents
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onClose();
                  onSaveCopy(format);
                }}
                className={secondaryButton}
              >
                <MdFileDownload size={16} />
                Save a copy…
              </button>
            </div>
          </div>
        )}

        <div className="px-6 pt-4 pb-5 min-h-[3.25rem]" aria-live="polite">
          {status && (
            <div
              className={`flex items-start gap-2 text-sm ${
                status.tone === "error" ? "text-red-600 dark:text-red-400" : status.tone === "ok" ? "text-green-700 dark:text-green-400" : "text-neutral-500 dark:text-neutral-400"
              }`}
            >
              {status.tone === "busy" ? (
                <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />
              ) : status.tone === "ok" ? (
                <MdCheckCircle size={18} className="shrink-0 mt-px" />
              ) : (
                <MdErrorOutline size={18} className="shrink-0 mt-px" />
              )}
              <span className="flex-1">{status.text}</span>
              {status.path && (
                <button type="button" onClick={() => void invoke("open_file_from_directory", { filepath: status.path })} className="shrink-0 font-medium underline-offset-2 hover:underline">
                  Show file
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DocShareDialog;
