//! One connection to the X server for queries from any thread (x11rb's connection is thread-safe),
//! and the atoms the other modules ask about. The input thread opens its own, so waiting for
//! events never holds up a query.

use std::sync::OnceLock;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, ConnectionExt as _, Window};
use x11rb::rust_connection::RustConnection;

use crate::{Error, Result};

/// Atoms looked up once per connection.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Atoms {
    pub net_active_window: Atom,
    pub net_client_list_stacking: Atom,
    pub net_client_list: Atom,
    pub net_wm_name: Atom,
    pub net_wm_pid: Atom,
    pub net_wm_state: Atom,
    pub net_wm_state_hidden: Atom,
    pub net_wm_window_type: Atom,
    pub net_wm_window_type_dock: Atom,
    pub net_wm_window_type_desktop: Atom,
    pub net_wm_window_type_toolbar: Atom,
    pub net_wm_window_type_notification: Atom,
    pub net_frame_extents: Atom,
    pub resource_manager: Atom,
}

impl Atoms {
    fn intern(connection: &RustConnection) -> Result<Self> {
        let atom = |name: &str| -> Result<Atom> {
            Ok(connection
                .intern_atom(false, name.as_bytes())?
                .reply()?
                .atom)
        };
        Ok(Self {
            net_active_window: atom("_NET_ACTIVE_WINDOW")?,
            net_client_list_stacking: atom("_NET_CLIENT_LIST_STACKING")?,
            net_client_list: atom("_NET_CLIENT_LIST")?,
            net_wm_name: atom("_NET_WM_NAME")?,
            net_wm_pid: atom("_NET_WM_PID")?,
            net_wm_state: atom("_NET_WM_STATE")?,
            net_wm_state_hidden: atom("_NET_WM_STATE_HIDDEN")?,
            net_wm_window_type: atom("_NET_WM_WINDOW_TYPE")?,
            net_wm_window_type_dock: atom("_NET_WM_WINDOW_TYPE_DOCK")?,
            net_wm_window_type_desktop: atom("_NET_WM_WINDOW_TYPE_DESKTOP")?,
            net_wm_window_type_toolbar: atom("_NET_WM_WINDOW_TYPE_TOOLBAR")?,
            net_wm_window_type_notification: atom("_NET_WM_WINDOW_TYPE_NOTIFICATION")?,
            net_frame_extents: atom("_NET_FRAME_EXTENTS")?,
            resource_manager: atom("RESOURCE_MANAGER")?,
        })
    }
}

/// A connection with its screen's root window and atoms.
pub(crate) struct Display {
    pub connection: RustConnection,
    pub root: Window,
    pub atoms: Atoms,
}

impl Display {
    /// Opens a new connection to `DISPLAY`.
    pub fn open() -> Result<Self> {
        let (connection, screen) = x11rb::connect(None)?;
        let root = connection
            .setup()
            .roots
            .get(screen)
            .map(|screen| screen.root)
            .ok_or_else(|| Error::NoDisplay("the X server has no such screen".into()))?;
        let atoms = Atoms::intern(&connection)?;
        Ok(Self {
            connection,
            root,
            atoms,
        })
    }
}

/// The shared connection, opened on first use. `None` when there's no X server (a Wayland-only
/// session, or none at all).
pub(crate) fn shared() -> Option<&'static Display> {
    static SHARED: OnceLock<Option<Display>> = OnceLock::new();
    SHARED.get_or_init(|| Display::open().ok()).as_ref()
}
