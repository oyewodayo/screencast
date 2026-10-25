// services/orphan_guard.rs
//
// Makes sure a recording's ffmpeg child dies with the app rather than outliving it.
//
// This matters more than it sounds. An orphaned ffmpeg keeps the camera and microphone open, keeps
// writing to a file nothing will ever finalize, and keeps competing for the CPU and GPU of the
// machine it was recording - all invisibly, because the window it belonged to is gone. It was hit
// for real during development on Windows: stray capture processes from a killed app kept running
// and measurably degraded every recording made afterwards, with no indication of why.
//
// The mechanism is entirely different per platform and, importantly, applies at a different moment
// in the spawn - Windows attaches the child to a Job Object *after* it exists, Linux asks the
// kernel for a parent-death signal *before* exec. Exposing both halves here means call sites just
// bracket their spawn with the two functions and never have to know which platform does what.

use std::process::{Child, Command};

/// Called on the `Command` immediately before spawning.
///
/// Linux does its work here: `PR_SET_PDEATHSIG` is a property of the child process that has to be
/// set from inside the child, between fork and exec.
pub fn before_spawn(cmd: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        // SAFETY: the closure runs in the forked child between fork() and exec(), where only
        // async-signal-safe calls are permitted. `prctl` and `getppid` are both on that list;
        // nothing here allocates, locks, or touches the Rust runtime.
        unsafe {
            cmd.pre_exec(|| {
                // Ask the kernel to SIGKILL us the moment our parent dies.
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }

                // Closes the race the flag alone leaves open: if the parent had already exited
                // before that prctl ran, the death signal it registers will never be delivered
                // and this process would survive as exactly the orphan it was meant to prevent.
                // A parent PID of 1 means we have already been reparented to init.
                if libc::getppid() == 1 {
                    std::process::exit(1);
                }

                Ok(())
            });
        }
    }

    // Windows does its work in after_spawn; macOS has no equivalent (see the module note below).
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cmd;
    }
}

/// Called with the spawned `Child`.
///
/// Windows does its work here: the child is added to a Job Object configured to kill everything in
/// it when the app's own handle closes, which covers a force-kill of the app as well as a clean
/// exit.
pub fn after_spawn(child: &Child) {
    #[cfg(target_os = "windows")]
    {
        crate::services::process_job::assign_to_job(child);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
    }
}

// macOS deliberately has neither half, and that is a real remaining gap rather than an oversight.
//
// Darwin has no PR_SET_PDEATHSIG and no Job Object. The usual substitutes are a kqueue watcher on
// the parent (needs a supervising thread in the child, which ffmpeg obviously does not have) or a
// process-group kill on the way out (which handles a clean exit - already covered by
// stop_recording - but not the crash case that actually strands processes). The realistic option
// is a startup sweep: record the ffmpeg pid while recording and kill any survivor on next launch.
// Worth doing, but it is a different mechanism from either of the above and belongs in its own
// change, on hardware where it can be verified. See RECORDING_UPGRADE_NOTES.md.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn before_spawn_leaves_a_command_runnable() {
        // The Linux path installs a pre_exec hook; the others must leave the Command untouched.
        // Either way the command still has to work, which is the thing worth asserting.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit 0"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        before_spawn(&mut cmd);
        let status = cmd.status().expect("spawn after before_spawn");
        assert!(status.success());
    }

    #[test]
    fn after_spawn_accepts_a_live_child() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit 0"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        let mut child = cmd.spawn().expect("spawn");
        after_spawn(&child);
        let _ = child.wait();
    }
}
