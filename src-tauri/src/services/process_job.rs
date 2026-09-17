// services/process_job.rs
//
// Ties every recording ffmpeg child's lifetime to this app's own process, using a Windows Job
// Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Exists because of a real orphan: the app's
// normal "stop recording" flow works by writing 'q' to ffmpeg's stdin (see win.rs) so it shuts
// down gracefully and finalizes the file - but that only runs if the app's own shutdown code gets
// to execute. If the app is instead killed from outside (Task Manager "End task" escalating to a
// force kill, `taskkill /F`, a crash, the exe being force-terminated to unlock it for a rebuild),
// no application code runs at all, and ffmpeg - a separate process - just keeps going, still
// holding the camera/mic open.
//
// A job object fixes this at the OS level rather than the application level: assigning a child
// process to a job with KILL_ON_JOB_CLOSE means that when every handle to the job closes, Windows
// itself terminates every process still in it. Handles are closed automatically by the OS as part
// of tearing down a dying process - true whether that process exited normally, panicked, or was
// forcibly terminated - so this cleanup fires even in the exact case an in-process shutdown hook
// can't run. The tradeoff: the OS kill is a hard TerminateProcess, same as before, so a file being
// recorded at that moment can still end up unfinalized - but the camera/mic get released
// immediately either way, which is the actual problem this solves.
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

// HANDLE isn't Send/Sync by default; sound to force it here because a job object handle, once
// created, is only ever read (passed by value into Win32 calls), never mutated, and carries no
// thread affinity the way e.g. a GUI handle might.
struct JobHandle(HANDLE);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

// None means job-object creation itself failed (e.g. a locked-down environment that restricts
// it) - in that case every recording just falls back to the pre-existing behavior (an ffmpeg
// child can outlive the app if it's killed from outside), same fallback assign_to_job already
// has for an assignment failure. That's a real but non-fatal loss of protection, not a reason to
// crash the whole app on the first recording of the session.
static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

fn job() -> Option<HANDLE> {
    JOB.get_or_init(|| {
        let handle = match unsafe { CreateJobObjectW(None, PCWSTR::null()) } {
            Ok(h) => h,
            Err(e) => {
                log::warn!("Failed to create job object, recordings won't be force-cleaned up if the app is killed externally: {e}");
                return None;
            }
        };

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if let Err(e) = result {
            log::warn!("Failed to configure job object, recordings won't be force-cleaned up if the app is killed externally: {e}");
            return None;
        }

        Some(JobHandle(handle))
    })
    .as_ref()
    .map(|h| h.0)
}

// Best-effort: a failure here just means this particular recording falls back to the old
// behavior (can outlive the app if it's killed from outside) rather than failing the recording
// itself, which is otherwise perfectly fine.
pub fn assign_to_job(child: &Child) {
    let Some(job) = job() else {
        return;
    };
    let handle = HANDLE(child.as_raw_handle() as isize);
    if let Err(e) = unsafe { AssignProcessToJobObject(job, handle) } {
        log::warn!("Failed to assign recording process to job object: {e}");
    }
}
