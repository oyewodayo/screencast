// components/docker/ExportQueueChip.tsx
//
// The background export queue on screen (exportQueue.ts): a small chip in the corner while
// anything is queued, rendering or freshly done - the frame being rendered right now, how far it
// has got, how long is left - and, opened, every job with what can be done with it: cancel a
// render, retry a failed one, open / show / share a finished file, or put it on a phone - over the
// USB cable in one click when an Android phone is plugged in, or through Transfer to phone.
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoAlertCircleOutline, IoCheckmarkCircle, IoClose, IoCloudUploadOutline, IoFilmOutline, IoFolderOpenOutline, IoPhonePortraitOutline, IoPlayOutline, IoRefreshOutline } from "react-icons/io5";
import { MdUsb } from "react-icons/md";
import { ExportJob, cancel, clearFinished, formatEta, isActive, remove, retry, useExportQueue } from "../../utils/exportQueue";
import { openPhoneTransfer } from "../../services/phoneTransfer";
import { getUsbState, sendOverUsb, subscribeUsb, type UsbPhone } from "../../services/usbPhone";

interface Props {
  onOpen: (job: ExportJob) => void;
  onShare: (job: ExportJob) => void;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const Thumb: React.FC<{ job: ExportJob; size: "sm" | "lg" }> = ({ job, size }) => (
  <div className={`relative shrink-0 overflow-hidden rounded-md bg-neutral-800 ring-1 ring-white/10 ${size === "lg" ? "w-28 h-16" : "w-10 h-6"}`}>
    {job.previewUrl ? (
      <img src={job.previewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-white/30">
        <IoFilmOutline size={size === "lg" ? 20 : 12} />
      </div>
    )}
    {job.status === "rendering" && (
      <div className="absolute left-0 right-0 bottom-0 h-1 bg-black/50">
        <div className="h-full bg-blue-500 transition-[width] duration-300" style={{ width: `${job.progress}%` }} />
      </div>
    )}
    {job.status === "done" && size === "lg" && <IoCheckmarkCircle size={18} className="absolute right-1 top-1 text-emerald-400 drop-shadow" />}
  </div>
);

const statusLine = (job: ExportJob): string => {
  switch (job.status) {
    case "queued":
      return "Waiting its turn";
    case "rendering":
      return `${Math.floor(job.progress)}%${job.etaSec !== undefined ? ` · ${formatEta(job.etaSec)}` : ""}`;
    case "done":
      return job.resultPath ? fileName(job.resultPath) : "Saved";
    case "failed":
      return job.error ?? "Failed";
    case "cancelled":
      return "Cancelled";
  }
};

const JobRow: React.FC<{ job: ExportJob; usbPhone?: UsbPhone } & Props> = ({ job, usbPhone, onOpen, onShare }) => {
  const btn = "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-white/75 hover:text-white hover:bg-white/10";
  return (
    <div className="flex gap-2.5 p-2 rounded-lg hover:bg-white/[0.04]">
      <Thumb job={job} size="lg" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-white/90" title={job.title}>
            {job.title}
          </span>
          {isActive(job) ? (
            <button type="button" title={job.status === "queued" ? "Take out of the queue" : "Stop this export"} onClick={() => void cancel(job.id)} className="p-0.5 rounded text-white/40 hover:text-white hover:bg-white/10">
              <IoClose size={13} />
            </button>
          ) : (
            <button type="button" title="Remove from the list" onClick={() => remove(job.id)} className="p-0.5 rounded text-white/30 hover:text-white hover:bg-white/10">
              <IoClose size={13} />
            </button>
          )}
        </div>
        <span className="truncate text-[10px] text-white/40">{job.detail}</span>
        <span className={`truncate text-[11px] ${job.status === "failed" ? "text-red-300" : job.status === "done" ? "text-emerald-300/90" : "text-white/60"}`} title={statusLine(job)}>
          {job.status === "failed" && <IoAlertCircleOutline size={11} className="inline -mt-0.5 mr-1" />}
          {statusLine(job)}
        </span>
        {job.status === "done" && job.resultPath && (
          <div className="flex items-center gap-0.5 -ml-1.5 mt-0.5">
            <button type="button" className={btn} onClick={() => onOpen(job)} title="Open it in Briefcast">
              <IoPlayOutline size={12} /> Open
            </button>
            <button type="button" className={btn} onClick={() => void invoke("open_file_from_directory", { filepath: job.resultPath })} title="Show it in File Explorer">
              <IoFolderOpenOutline size={12} /> Folder
            </button>
            <button type="button" className={btn} onClick={() => onShare(job)} title="Upload to YouTube or make a share link">
              <IoCloudUploadOutline size={12} /> Share
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => openPhoneTransfer([{ path: job.resultPath!, name: fileName(job.resultPath!) }])}
              title="Send it to a phone over Wi-Fi or a USB cable"
            >
              <IoPhonePortraitOutline size={12} /> Phone
            </button>
          </div>
        )}
        {job.status === "done" && job.resultPath && usbPhone && (
          <button
            type="button"
            onClick={() => void sendOverUsb(usbPhone.id, [{ path: job.resultPath!, name: fileName(job.resultPath!) }])}
            title="Copy it to the phone on the USB cable - progress shows in the phone's card"
            className="self-start mt-1 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
          >
            <MdUsb size={12} /> Send to {usbPhone.name}
          </button>
        )}
        {(job.status === "failed" || job.status === "cancelled") && (
          <div className="flex items-center gap-0.5 -ml-1.5 mt-0.5">
            <button type="button" className={btn} onClick={() => retry(job.id)} title="Render it again, as it was set up">
              <IoRefreshOutline size={12} /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const ExportQueueChip: React.FC<Props> = (props) => {
  const jobs = useExportQueue();
  // An Android phone ready on the USB cable gets a one-click "Send to" on every finished export.
  const [usbPhones, setUsbPhones] = useState<UsbPhone[]>(getUsbState().phones);
  useEffect(() => subscribeUsb((s) => setUsbPhones(s.phones)), []);
  const usbPhone = usbPhones.find((p) => p.state === "ready" && p.can_receive);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Opens by itself when a job is added, so Save visibly "goes somewhere".
  const count = jobs.length;
  const lastCount = useRef(count);
  useEffect(() => {
    if (count > lastCount.current) setOpen(true);
    lastCount.current = count;
  }, [count]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  if (jobs.length === 0) return null;

  const rendering = jobs.find((j) => j.status === "rendering");
  const queued = jobs.filter((j) => j.status === "queued").length;
  const done = jobs.filter((j) => j.status === "done").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const label = rendering
    ? `Exporting ${Math.floor(rendering.progress)}%${queued ? ` · ${queued} waiting` : ""}`
    : queued
      ? `${queued} waiting`
      : failed
        ? `${failed} export${failed === 1 ? "" : "s"} failed`
        : `${done} export${done === 1 ? "" : "s"} done`;

  return (
    <div ref={rootRef} className="fixed right-4 top-14 z-[60] flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={rendering ? `${rendering.title} - ${statusLine(rendering)}` : "Exports"}
        className={`flex items-center gap-2 pl-1 pr-3 py-1 rounded-full shadow-lg ring-1 text-[12px] backdrop-blur-md transition-colors ${
          failed && !rendering ? "bg-red-950/90 ring-red-800 text-red-100" : "bg-neutral-900/90 ring-white/10 text-white/90 hover:bg-neutral-800/90"
        }`}
      >
        {rendering ? <Thumb job={rendering} size="sm" /> : <span className="w-6 h-6 flex items-center justify-center">{failed ? <IoAlertCircleOutline size={15} /> : <IoCheckmarkCircle size={15} className="text-emerald-400" />}</span>}
        <span className="tabular-nums">{label}</span>
        {rendering?.etaSec !== undefined && <span className="text-white/45 tabular-nums">{formatEta(rendering.etaSec)}</span>}
      </button>
      {open && (
        <div className="w-[360px] max-h-[70vh] overflow-y-auto rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 p-1.5 flex flex-col">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/45">Exports</span>
            <span className="text-[10px] text-white/35">Keep editing - these render in the background</span>
          </div>
          {[...jobs].reverse().map((job) => (
            <JobRow key={job.id} job={job} usbPhone={usbPhone} {...props} />
          ))}
          {jobs.some((j) => !isActive(j)) && (
            <button type="button" onClick={clearFinished} className="self-end m-1 px-2 py-0.5 rounded text-[10px] text-white/40 hover:text-white/80">
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ExportQueueChip;
