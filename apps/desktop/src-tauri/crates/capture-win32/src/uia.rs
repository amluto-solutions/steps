//! How long UI Automation waits for an app to answer (#119). Its client waits 2 seconds for an
//! app to connect and 20 for each answer by default, so one hung app can hold up the thread that
//! asks for seconds. The `uiautomation` crate makes the client object these limits can't be set
//! on (`CUIAutomation`), so the one that can (`CUIAutomation8`) is made here.

use std::time::Duration;

use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::UI::Accessibility::{CUIAutomation8, IUIAutomation, IUIAutomation2};
use windows::core::Interface;

/// A UI Automation client that gives up on an app that hasn't connected, or answered a call,
/// within `wait`: the call fails as a timeout, as any failed call does. `None` when it can't be
/// made. Called on a thread where COM is set up; it stays on that thread, as any client does.
#[must_use]
pub fn client_waiting(wait: Duration) -> Option<IUIAutomation> {
    let ms = u32::try_from(wait.as_millis()).unwrap_or(u32::MAX);
    // SAFETY: creates UI Automation's client, an in-process COM object, with its documented
    // class id; COM is set up on this thread by the caller.
    let client: IUIAutomation2 =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.ok()?;
    // SAFETY: calls on the live interface just created, with plain numbers.
    unsafe {
        client.SetConnectionTimeout(ms).ok()?;
        client.SetTransactionTimeout(ms).ok()?;
    }
    client.cast().ok()
}

/// How long a UI Automation client waits for an app to connect, and to answer a call. `None`
/// when it can't say (a client made as `CUIAutomation`).
#[must_use]
pub fn waits(client: &IUIAutomation) -> Option<(Duration, Duration)> {
    let client: IUIAutomation2 = client.cast().ok()?;
    // SAFETY: calls on a live interface the caller holds, reading two numbers.
    let (connection, transaction) = unsafe {
        (
            client.ConnectionTimeout().ok()?,
            client.TransactionTimeout().ok()?,
        )
    };
    Some((
        Duration::from_millis(u64::from(connection)),
        Duration::from_millis(u64::from(transaction)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};

    #[test]
    fn a_client_waits_only_as_long_as_it_is_told() {
        // SAFETY: sets up COM on this test's own thread, undone below.
        let set_up = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let client = client_waiting(Duration::from_millis(500)).expect("a UI Automation client");
        assert_eq!(
            waits(&client),
            Some((Duration::from_millis(500), Duration::from_millis(500)))
        );
        drop(client);
        if set_up {
            // SAFETY: balances the call above, on the same thread, with no COM object left.
            unsafe { CoUninitialize() };
        }
    }
}
