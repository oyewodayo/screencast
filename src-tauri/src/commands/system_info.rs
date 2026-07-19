// commands/system_info.rs
//
// Physical RAM (total, available) in MB, shown in the docker bar's CPU RAM readout. Was
// previously inline in main.rs calling Win32's GlobalMemoryStatusEx unconditionally, which
// meant the whole binary couldn't compile on macOS/Linux regardless of anything else — moved
// here and given a real implementation per platform, same pattern as recording.rs.

#[tauri::command]
pub fn get_ram_info() -> Result<(u64, u64), String> {
    #[cfg(target_os = "windows")]
    return windows::ram_info();
    #[cfg(target_os = "linux")]
    return linux::ram_info();
    #[cfg(target_os = "macos")]
    return macos::ram_info();
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    return Err("RAM info is not supported on this platform".to_string());
}

#[cfg(target_os = "windows")]
mod windows {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    pub fn ram_info() -> Result<(u64, u64), String> {
        let mut mem_status = MEMORYSTATUSEX::default();
        mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;

        unsafe { GlobalMemoryStatusEx(&mut mem_status) }
            .map_err(|e| format!("Failed to get memory info: {}", e))?;

        Ok((
            mem_status.ullTotalPhys / (1024 * 1024),
            mem_status.ullAvailPhys / (1024 * 1024),
        ))
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs;

    // /proc/meminfo is a standard, always-present kernel interface — no external tool or extra
    // dependency needed. Relevant lines look like:
    //   MemTotal:       16269588 kB
    //   MemAvailable:   10321444 kB
    // MemAvailable (not MemFree) is used deliberately: MemFree alone excludes reclaimable cache/
    // buffer memory the kernel would happily hand back to a new allocation, so it dramatically
    // understates what's actually usable — MemAvailable is the kernel's own "true" estimate,
    // the same number tools like `free -h` base their "available" column on.
    pub fn ram_info() -> Result<(u64, u64), String> {
        let contents = fs::read_to_string("/proc/meminfo")
            .map_err(|e| format!("Failed to read /proc/meminfo: {}", e))?;

        let mut total_kb: Option<u64> = None;
        let mut available_kb: Option<u64> = None;

        for line in contents.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                total_kb = parse_kb_value(rest);
            } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                available_kb = parse_kb_value(rest);
            }
            if total_kb.is_some() && available_kb.is_some() {
                break;
            }
        }

        let total_kb = total_kb.ok_or_else(|| "MemTotal not found in /proc/meminfo".to_string())?;
        let available_kb = available_kb.ok_or_else(|| "MemAvailable not found in /proc/meminfo".to_string())?;

        Ok((total_kb / 1024, available_kb / 1024))
    }

    // "   16269588 kB" -> 16269588
    fn parse_kb_value(rest: &str) -> Option<u64> {
        rest.trim().split_whitespace().next()?.parse::<u64>().ok()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;

    // No extra dependency: `sysctl`/`vm_stat` are standard macOS command-line tools present on
    // every install, in the same spirit as reading /proc/meminfo directly on Linux.
    //
    // UNVERIFIED: written against documented sysctl/vm_stat output format, not exercised on
    // real macOS hardware from this (Windows) environment.
    pub fn ram_info() -> Result<(u64, u64), String> {
        let total_bytes = run(&["sysctl", "-n", "hw.memsize"])?
            .trim()
            .parse::<u64>()
            .map_err(|e| format!("Failed to parse hw.memsize: {}", e))?;

        let vm_stat = run(&["vm_stat"])?;
        let page_size = extract_page_size(&vm_stat).unwrap_or(4096);
        let free_pages = extract_stat(&vm_stat, "Pages free")
            + extract_stat(&vm_stat, "Pages inactive")
            + extract_stat(&vm_stat, "Pages speculative");

        Ok((total_bytes / (1024 * 1024), (free_pages * page_size) / (1024 * 1024)))
    }

    fn run(args: &[&str]) -> Result<String, String> {
        let output = Command::new(args[0])
            .args(&args[1..])
            .output()
            .map_err(|e| format!("Failed to run {}: {}", args[0], e))?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    // "Mach Virtual Memory Statistics: (page size of 16384 bytes)" -> 16384
    fn extract_page_size(vm_stat: &str) -> Option<u64> {
        let start = vm_stat.find("page size of ")? + "page size of ".len();
        let rest = &vm_stat[start..];
        rest.split_whitespace().next()?.parse::<u64>().ok()
    }

    // "Pages free:                              12345." -> 12345
    fn extract_stat(vm_stat: &str, label: &str) -> u64 {
        vm_stat
            .lines()
            .find(|line| line.starts_with(label))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    }
}
