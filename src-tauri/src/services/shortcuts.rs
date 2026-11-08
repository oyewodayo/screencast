// services/shortcuts.rs
//
// Every system-wide shortcut, owned by Rust. Before this, each was registered from the main
// window's JavaScript, which had three costs:
//   - a shortcut only worked while that page was alive, so the WebView could never be released
//     while Briefcast sat in the tray;
//   - after a page reload the plugin still held the shortcut bound to the dead page's callback, so
//     every registration had to unregister-then-register defensively (the old `bindShortcut`);
//   - unregistering is asynchronous, so StrictMode's mount/unmount/mount could land a late
//     unregister after the new register and silently remove it.
// Here a shortcut is registered once, by a process that outlives every page, and a press is
// broadcast as a `global-shortcut` event that any window may act on. Pages subscribe and
// unsubscribe freely; nothing they do can drop a registration.
//
// Shortcuts come in groups that are switched on and off together:
//   always       - for as long as the app runs
//   annotation   - while Settings > "annotation tool" is on (follows the settings file itself)
//   recording    - while a recording runs (overlay toggle)
//   view-switch  - while a recording that can cut between screen and camera runs
//   presentation - while the live display is up
//
// Desktop only: the global-shortcut plugin does not exist on Android/iOS (see Cargo.toml). The
// commands below exist everywhere so the frontend can call them unconditionally.

use serde::Serialize;
use tauri::AppHandle;

/// One shortcut: what it does (sent to the frontend) and its key combination.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDef {
    pub action: &'static str,
    pub accelerator: &'static str,
}

const fn def(action: &'static str, accelerator: &'static str) -> ShortcutDef {
    ShortcutDef { action, accelerator }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    Always,
    Annotation,
    Recording,
    ViewSwitch,
    Presentation,
}

const ALWAYS: &[ShortcutDef] = &[
    def("record-toggle", "CommandOrControl+Shift+R"),
    def("panel-buttons-toggle", "CommandOrControl+Shift+B"),
    def("snip", "Alt+Shift+S"),
];
const ANNOTATION: &[ShortcutDef] = &[
    def("annotation-toggle", "CommandOrControl+Shift+D"),
    def("blur-window", "CommandOrControl+Alt+B"),
];
const RECORDING: &[ShortcutDef] = &[def("overlay-toggle", "CommandOrControl+Shift+H")];
// Alt+Shift rather than Ctrl+Alt (AltGr on many keyboards); not Ctrl+Shift+V, which is "paste as
// plain text" in exactly the apps people demo.
const VIEW_SWITCH: &[ShortcutDef] = &[def("view-switch", "Alt+Shift+V")];
// Cut cameras on the live display from another app: 1-9 one camera, 0 all, L next layout.
const PRESENTATION: &[ShortcutDef] = &[
    def("presentation-cut-1", "Alt+Shift+1"),
    def("presentation-cut-2", "Alt+Shift+2"),
    def("presentation-cut-3", "Alt+Shift+3"),
    def("presentation-cut-4", "Alt+Shift+4"),
    def("presentation-cut-5", "Alt+Shift+5"),
    def("presentation-cut-6", "Alt+Shift+6"),
    def("presentation-cut-7", "Alt+Shift+7"),
    def("presentation-cut-8", "Alt+Shift+8"),
    def("presentation-cut-9", "Alt+Shift+9"),
    def("presentation-all", "Alt+Shift+0"),
    def("presentation-layout", "Alt+Shift+L"),
];

impl Group {
    pub fn shortcuts(self) -> &'static [ShortcutDef] {
        match self {
            Group::Always => ALWAYS,
            Group::Annotation => ANNOTATION,
            Group::Recording => RECORDING,
            Group::ViewSwitch => VIEW_SWITCH,
            Group::Presentation => PRESENTATION,
        }
    }

    pub const ALL: [Group; 5] = [Group::Always, Group::Annotation, Group::Recording, Group::ViewSwitch, Group::Presentation];
}

/// Payload of the `global-shortcut` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutPressed {
    pub action: &'static str,
}

/// A shortcut another app already holds. Kept so a page that loads later can still tell the user
/// (an event fired before its listener existed would be lost).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutFailure {
    pub action: &'static str,
    pub accelerator: &'static str,
    pub reason: String,
}

pub const PRESSED_EVENT: &str = "global-shortcut";
pub const FAILED_EVENT: &str = "global-shortcut-failed";

#[cfg(desktop)]
mod imp {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;
    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    #[derive(Default)]
    pub struct ShortcutsState {
        inner: Mutex<Inner>,
    }

    #[derive(Default)]
    struct Inner {
        active: HashSet<Group>,
        // Keyed by action so re-enabling a group that failed before replaces the stale entry.
        failures: HashMap<&'static str, ShortcutFailure>,
    }

    fn on_press(app: &AppHandle, action: &'static str) {
        log::debug!("shortcut: {}", action);
        // With no main window (released to the tray, or a `--tray` launch), the recording shortcuts
        // are handled in Rust; the rest act on UI that doesn't exist without it.
        if !crate::services::main_window::exists(app) {
            use crate::services::recording_session::{handle, Request};
            match action {
                "record-toggle" => handle(app, Request::Toggle(None)),
                "overlay-toggle" => handle(app, Request::OverlayToggle),
                "view-switch" => handle(app, Request::ViewToggle),
                "snip" => handle(app, Request::Screenshot),
                _ => log::debug!("shortcut {} needs the main window; ignored while it is closed", action),
            }
            return;
        }
        // Broadcast: the record toggle is handled by the main window, presentation cuts by the
        // presentation service, and so on - each listener picks its own actions.
        let _ = app.emit(PRESSED_EVENT, ShortcutPressed { action });
    }

    /// Switches a group on or off. Idempotent, and the lock is held for the whole change, so two
    /// callers racing (a recording starting while settings change) cannot interleave half-applied.
    pub fn set_group(app: &AppHandle, group: Group, on: bool) {
        let state = app.state::<ShortcutsState>();
        let mut inner = state.inner.lock().unwrap_or_else(|p| p.into_inner());
        if inner.active.contains(&group) == on {
            return;
        }
        let gs = app.global_shortcut();
        let mut new_failures = Vec::new();
        for sc in group.shortcuts() {
            if on {
                let action = sc.action;
                // A leftover registration (e.g. from a crashed earlier page that registered it
                // through the JS API) would make this fail as "already registered" by ourselves.
                if gs.is_registered(sc.accelerator) {
                    let _ = gs.unregister(sc.accelerator);
                }
                let result = gs.on_shortcut(sc.accelerator, move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        on_press(app, action);
                    }
                });
                match result {
                    Ok(()) => {
                        inner.failures.remove(sc.action);
                    }
                    Err(e) => {
                        // Most likely another running app holds this combination.
                        log::warn!("shortcut {} ({}) could not be registered: {}", sc.action, sc.accelerator, e);
                        let failure = ShortcutFailure { action: sc.action, accelerator: sc.accelerator, reason: e.to_string() };
                        inner.failures.insert(sc.action, failure.clone());
                        new_failures.push(failure);
                    }
                }
            } else {
                let _ = gs.unregister(sc.accelerator);
                inner.failures.remove(sc.action);
            }
        }
        if on {
            inner.active.insert(group);
        } else {
            inner.active.remove(&group);
        }
        drop(inner);
        for failure in new_failures {
            let _ = app.emit(FAILED_EVENT, failure);
        }
    }

    pub fn failures(app: &AppHandle) -> Vec<ShortcutFailure> {
        let state = app.state::<ShortcutsState>();
        let inner = state.inner.lock().unwrap_or_else(|p| p.into_inner());
        let mut list: Vec<_> = inner.failures.values().cloned().collect();
        list.sort_by_key(|f| f.action);
        list
    }
}

#[cfg(mobile)]
mod imp {
    use super::*;

    #[derive(Default)]
    pub struct ShortcutsState;

    pub fn set_group(_app: &AppHandle, _group: Group, _on: bool) {}

    pub fn failures(_app: &AppHandle) -> Vec<ShortcutFailure> {
        Vec::new()
    }
}

pub use imp::{failures, set_group, ShortcutsState};

/// Startup: the always-on group, plus annotation if the settings file has it on.
pub fn install(app: &AppHandle) {
    set_group(app, Group::Always, true);
    sync_with_settings(app);
}

/// Groups that follow a setting. Called at startup and after every settings write, so a toggle in
/// Settings takes effect at once with no window involved.
pub fn sync_with_settings(app: &AppHandle) {
    let settings = crate::services::settings_store::current(app);
    let annotation = crate::services::settings_store::get_bool(&settings, "enableAnnotationTool", true);
    set_group(app, Group::Annotation, annotation);
}

/// For the groups that follow app state rather than a setting: recording, view-switch and
/// presentation. (The recording ones move to the Rust-side recording start in a later step; until
/// then the main window switches them as recordings start and stop.)
#[tauri::command]
pub async fn set_shortcut_group(app: AppHandle, group: Group, active: bool) -> Result<(), String> {
    if matches!(group, Group::Always | Group::Annotation) {
        return Err(format!("The {:?} shortcuts are managed by the app, not switched by hand.", group));
    }
    crate::services::responsiveness::blocking(move || set_group(&app, group, active)).await
}

/// Every shortcut and what it does - the single source for labels and hints in the UI.
#[tauri::command]
pub async fn list_shortcuts() -> Vec<(Group, &'static [ShortcutDef])> {
    Group::ALL.iter().map(|g| (*g, g.shortcuts())).collect()
}

/// Shortcuts another app holds, for a page that loaded after the failure was announced.
///
/// Async, never on the UI thread: set_group holds the same lock while it waits for the UI thread
/// to register a key, so reading it from the UI thread could deadlock the app.
#[tauri::command]
pub async fn shortcut_failures(app: AppHandle) -> Vec<ShortcutFailure> {
    failures(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn no_accelerator_or_action_is_claimed_twice() {
        let all: Vec<_> = Group::ALL.iter().flat_map(|g| g.shortcuts()).collect();
        let accels: HashSet<_> = all.iter().map(|s| s.accelerator).collect();
        let actions: HashSet<_> = all.iter().map(|s| s.action).collect();
        assert_eq!(accels.len(), all.len(), "an accelerator is in two groups");
        assert_eq!(actions.len(), all.len(), "an action name is used twice");
    }

    #[test]
    fn every_accelerator_parses() {
        // Catches a typo at test time instead of as a registration failure on a user's machine.
        for s in Group::ALL.iter().flat_map(|g| g.shortcuts()) {
            #[cfg(desktop)]
            s.accelerator
                .parse::<tauri_plugin_global_shortcut::Shortcut>()
                .unwrap_or_else(|e| panic!("{} does not parse: {}", s.accelerator, e));
            #[cfg(mobile)]
            let _ = s;
        }
    }

    #[test]
    fn groups_serialize_as_the_frontend_spells_them() {
        assert_eq!(serde_json::to_string(&Group::ViewSwitch).unwrap(), "\"view-switch\"");
        assert_eq!(serde_json::from_str::<Group>("\"presentation\"").unwrap(), Group::Presentation);
    }
}
