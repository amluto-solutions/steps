//! Excel's own UI Automation properties (12/10/2026, #70). UI Automation answers one only once
//! it's registered in this process by its GUID, which gives it a property id; the `uiautomation`
//! crate can only ask for the standard ones, so it's done here.
//!
//! Microsoft documents them at <https://learn.microsoft.com/office/uia/excel/excelcustomproperties>.

use std::sync::OnceLock;

use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Variant::{VARIANT, VT_BOOL, VariantClear};
use windows::Win32::UI::Accessibility::{
    CUIAutomationRegistrar, IUIAutomationElement, IUIAutomationRegistrar, UIA_PROPERTY_ID,
    UIAutomationPropertyInfo, UIAutomationType_Bool,
};
use windows::core::{GUID, w};

/// `HasFilterDropdown`: a cell has a filter drop-down (Microsoft 365 version 2302 and later).
const HAS_FILTER_DROPDOWN: GUID = GUID::from_u128(0x0097_284b_3573_4aab_8e22_6092_b87f_8fdd);

/// Its property id in this process, once registered. A failed registration isn't kept, so a
/// later read tries again.
static HAS_FILTER_DROPDOWN_ID: OnceLock<UIA_PROPERTY_ID> = OnceLock::new();

/// The id UI Automation gives `HasFilterDropdown` in this process. Called on a UI Automation
/// thread, where COM is already set up.
fn has_filter_dropdown_id() -> Option<UIA_PROPERTY_ID> {
    if let Some(id) = HAS_FILTER_DROPDOWN_ID.get() {
        return Some(*id);
    }
    // SAFETY: creates UI Automation's registrar, an in-process COM object, with its documented
    // class id; the interface is released when it drops at the end of this function.
    let registrar: IUIAutomationRegistrar =
        unsafe { CoCreateInstance(&CUIAutomationRegistrar, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let info = UIAutomationPropertyInfo {
        guid: HAS_FILTER_DROPDOWN,
        pProgrammaticName: w!("HasFilterDropdown"),
        r#type: UIAutomationType_Bool,
    };
    // SAFETY: `info` outlives the call, and its name is a static wide string. Registering a
    // property UI Automation already knows by its GUID gives back the same id.
    let id = unsafe { registrar.RegisterProperty(&raw const info) }.ok()?;
    Some(*HAS_FILTER_DROPDOWN_ID.get_or_init(|| UIA_PROPERTY_ID(id)))
}

/// Whether Excel says `element`, a cell, has a filter drop-down (`HasFilterDropdown`). `None`
/// when it doesn't say: an Excel older than version 2302, an element that isn't Excel's, or a
/// call that failed.
#[must_use]
pub fn has_filter_dropdown(element: &IUIAutomationElement) -> Option<bool> {
    let id = has_filter_dropdown_id()?;
    // SAFETY: a call on a live interface the caller holds. The VARIANT it gives back is owned
    // here and cleared below.
    let mut value: VARIANT = unsafe { element.GetCurrentPropertyValue(id) }.ok()?;
    // SAFETY: `vt` is the tag at the start of every VARIANT, and `boolVal` is the member it says
    // holds the value when it's `VT_BOOL`.
    let answer = unsafe {
        let tagged = &value.Anonymous.Anonymous;
        (tagged.vt == VT_BOOL).then(|| tagged.Anonymous.boolVal.0 != 0)
    };
    // SAFETY: frees whatever the VARIANT holds (UI Automation's "not supported" answer is an
    // object), once; it isn't read again.
    let _ = unsafe { VariantClear(&raw mut value) };
    answer
}
