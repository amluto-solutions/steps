//! Touch screens and pens (docs/spec/02-capture.md#touch-and-pen): the contacts in a digitizer's
//! Raw Input reports, read with the device's own description (`HidP_*` on its preparsed data) and
//! placed on the screen it is mapped to (`GetPointerDeviceRects`). Which of them were taps is
//! `taps.rs`.
//!
//! No mouse source sees a tap: Windows turns touch into mouse input inside the app it lands on,
//! not for everyone. The digitizer's reports are the only place a recorder can see one.

use windows::Win32::Devices::HumanInterfaceDevice::{
    HIDP_BUTTON_CAPS, HIDP_CAPS, HIDP_STATUS_SUCCESS, HIDP_VALUE_CAPS, HidP_GetButtonCaps,
    HidP_GetCaps, HidP_GetUsageValue, HidP_GetUsages, HidP_GetValueCaps, HidP_Input,
    PHIDP_PREPARSED_DATA,
};
use windows::Win32::Foundation::{HANDLE, RECT};
use windows::Win32::UI::Controls::POINTER_DEVICE_INFO;
use windows::Win32::UI::Input::Pointer::{GetPointerDevice, GetPointerDeviceRects};
use windows::Win32::UI::Input::{GetRawInputDeviceInfoW, RIDI_PREPARSEDDATA};

use crate::taps::{Contact, Range, Rotation, Screen, to_screen};

const PAGE_GENERIC: u16 = 0x01;
const USAGE_X: u16 = 0x30;
const USAGE_Y: u16 = 0x31;
const PAGE_DIGITIZER: u16 = 0x0D;
const USAGE_TIP_SWITCH: u16 = 0x42;
const USAGE_CONTACT_ID: u16 = 0x51;

/// One contact in a report: a link collection with a position and a tip switch.
#[derive(Debug, Clone, Copy)]
struct Slot {
    link: u16,
    x: Range,
    y: Range,
    /// Signed values (a negative logical minimum): sign-extended from this many bits.
    x_bits: Option<u16>,
    y_bits: Option<u16>,
    /// The slot reports a contact id (multi-touch); without one, the slot is the contact.
    has_id: bool,
}

/// A digitizer's description: its preparsed data and the contact slots in its reports.
#[derive(Debug)]
pub struct Digitizer {
    /// The preparsed data, in 8-byte words for its alignment.
    preparsed: Vec<u64>,
    slots: Vec<Slot>,
}

/// A value's range from its capability, and the bits to sign-extend it from when it's signed.
fn range_of(cap: &HIDP_VALUE_CAPS) -> (Range, Option<u16>) {
    let bits = cap.BitSize.min(31);
    if cap.LogicalMax > cap.LogicalMin {
        let signed = cap.LogicalMin < 0;
        return (
            Range {
                min: cap.LogicalMin,
                max: cap.LogicalMax,
            },
            signed.then_some(bits),
        );
    }
    // A maximum read as negative is an unsigned field with its top bit set: the whole field.
    (
        Range {
            min: 0,
            max: (1_i32 << bits) - 1,
        },
        None,
    )
}

/// A raw field as a value: sign-extended when the field is signed.
fn value_of(raw: u32, bits: Option<u16>) -> i32 {
    match bits {
        Some(bits) if (1..32).contains(&bits) => {
            let shift = 32 - u32::from(bits);
            (raw << shift).cast_signed() >> shift
        }
        _ => i32::try_from(raw).unwrap_or(i32::MAX),
    }
}

/// Which usage a value or button capability is for: one usage, or a range of them.
fn covers(is_range: bool, range: (u16, u16), single: u16, usage: u16) -> bool {
    if is_range {
        (range.0..=range.1).contains(&usage)
    } else {
        single == usage
    }
}

fn value_covers(cap: &HIDP_VALUE_CAPS, usage: u16) -> bool {
    // SAFETY: `IsRange` says which member of the union is the live one; only that one is read.
    let (range, single) = unsafe {
        if cap.IsRange {
            (
                (cap.Anonymous.Range.UsageMin, cap.Anonymous.Range.UsageMax),
                0,
            )
        } else {
            ((0, 0), cap.Anonymous.NotRange.Usage)
        }
    };
    covers(cap.IsRange, range, single, usage)
}

fn button_covers(cap: &HIDP_BUTTON_CAPS, usage: u16) -> bool {
    // SAFETY: `IsRange` says which member of the union is the live one; only that one is read.
    let (range, single) = unsafe {
        if cap.IsRange {
            (
                (cap.Anonymous.Range.UsageMin, cap.Anonymous.Range.UsageMax),
                0,
            )
        } else {
            ((0, 0), cap.Anonymous.NotRange.Usage)
        }
    };
    covers(cap.IsRange, range, single, usage)
}

/// A device's preparsed data, in 8-byte words for its alignment.
fn preparsed_data(device: HANDLE) -> Option<Vec<u64>> {
    let mut size = 0_u32;
    // SAFETY: asks only for the size: no buffer is passed.
    let _ =
        unsafe { GetRawInputDeviceInfoW(Some(device), RIDI_PREPARSEDDATA, None, &raw mut size) };
    if size == 0 || size > 1 << 20 {
        return None;
    }
    let mut preparsed = vec![0_u64; (size as usize).div_ceil(8)];
    // SAFETY: `preparsed` holds at least `size` bytes, as `size` says.
    let copied = unsafe {
        GetRawInputDeviceInfoW(
            Some(device),
            RIDI_PREPARSEDDATA,
            Some(preparsed.as_mut_ptr().cast()),
            &raw mut size,
        )
    };
    (copied != u32::MAX && copied != 0).then_some(preparsed)
}

/// The input values and buttons a device's reports carry.
fn capabilities(
    data: PHIDP_PREPARSED_DATA,
) -> Option<(Vec<HIDP_VALUE_CAPS>, Vec<HIDP_BUTTON_CAPS>)> {
    let mut caps = HIDP_CAPS::default();
    // SAFETY: `data` is a device's preparsed data, kept alive by the caller.
    if unsafe { HidP_GetCaps(data, &raw mut caps) } != HIDP_STATUS_SUCCESS {
        return None;
    }
    let mut values = vec![HIDP_VALUE_CAPS::default(); usize::from(caps.NumberInputValueCaps)];
    let mut value_count = caps.NumberInputValueCaps;
    if value_count > 0 {
        // SAFETY: `values` has room for `value_count` entries; `data` is alive.
        let status = unsafe {
            HidP_GetValueCaps(HidP_Input, values.as_mut_ptr(), &raw mut value_count, data)
        };
        if status != HIDP_STATUS_SUCCESS {
            return None;
        }
    }
    values.truncate(usize::from(value_count));
    let mut buttons = vec![HIDP_BUTTON_CAPS::default(); usize::from(caps.NumberInputButtonCaps)];
    let mut button_count = caps.NumberInputButtonCaps;
    if button_count > 0 {
        // SAFETY: `buttons` has room for `button_count` entries; `data` is alive.
        let status = unsafe {
            HidP_GetButtonCaps(
                HidP_Input,
                buttons.as_mut_ptr(),
                &raw mut button_count,
                data,
            )
        };
        if status != HIDP_STATUS_SUCCESS {
            return None;
        }
    }
    buttons.truncate(usize::from(button_count));
    Some((values, buttons))
}

/// The contacts in a device's reports: each link collection with a position and a tip switch.
fn slots(values: &[HIDP_VALUE_CAPS], buttons: &[HIDP_BUTTON_CAPS]) -> Vec<Slot> {
    let find = |page: u16, usage: u16, link: u16| {
        values.iter().find(|cap| {
            cap.UsagePage == page && cap.LinkCollection == link && value_covers(cap, usage)
        })
    };
    let mut links: Vec<u16> = values
        .iter()
        .filter(|cap| cap.UsagePage == PAGE_GENERIC && value_covers(cap, USAGE_X))
        .map(|cap| cap.LinkCollection)
        .collect();
    links.sort_unstable();
    links.dedup();
    links
        .into_iter()
        .filter_map(|link| {
            let x = find(PAGE_GENERIC, USAGE_X, link)?;
            let y = find(PAGE_GENERIC, USAGE_Y, link)?;
            let tip = buttons.iter().any(|cap| {
                cap.UsagePage == PAGE_DIGITIZER
                    && cap.LinkCollection == link
                    && button_covers(cap, USAGE_TIP_SWITCH)
            });
            if !tip {
                return None;
            }
            let (x_range, x_bits) = range_of(x);
            let (y_range, y_bits) = range_of(y);
            Some(Slot {
                link,
                x: x_range,
                y: y_range,
                x_bits,
                y_bits,
                has_id: find(PAGE_DIGITIZER, USAGE_CONTACT_ID, link).is_some(),
            })
        })
        .collect()
}

impl Digitizer {
    /// Reads a device's description; `None` when it can't be read, or has no contact with a
    /// position and a tip switch (then its reports are only counted, as before).
    #[must_use]
    pub fn open(device: HANDLE) -> Option<Self> {
        let preparsed = preparsed_data(device)?;
        let (values, buttons) = capabilities(PHIDP_PREPARSED_DATA(preparsed.as_ptr() as isize))?;
        let slots = slots(&values, &buttons);
        (!slots.is_empty()).then_some(Self { preparsed, slots })
    }

    fn data(&self) -> PHIDP_PREPARSED_DATA {
        PHIDP_PREPARSED_DATA(self.preparsed.as_ptr() as isize)
    }

    /// The contacts in one report, placed on `screen`. A slot that can't be read is left out.
    #[must_use]
    pub fn contacts(&self, report: &[u8], screen: Screen, rotation: Rotation) -> Vec<Contact> {
        let data = self.data();
        let mut writable = report.to_vec();
        self.slots
            .iter()
            .filter_map(|slot| {
                let value = |page: u16, usage: u16| {
                    let mut raw = 0_u32;
                    // SAFETY: the report came from this device, `data` is its preparsed data.
                    let status = unsafe {
                        HidP_GetUsageValue(
                            HidP_Input,
                            page,
                            Some(slot.link),
                            usage,
                            &raw mut raw,
                            data,
                            report,
                        )
                    };
                    (status == HIDP_STATUS_SUCCESS).then_some(raw)
                };
                let x = value_of(value(PAGE_GENERIC, USAGE_X)?, slot.x_bits);
                let y = value_of(value(PAGE_GENERIC, USAGE_Y)?, slot.y_bits);
                let id = if slot.has_id {
                    value(PAGE_DIGITIZER, USAGE_CONTACT_ID)?
                } else {
                    u32::from(slot.link)
                };
                // The buttons down in this slot: touching when the tip switch is among them.
                let mut usages = [0_u16; 16];
                let mut length = u32::try_from(usages.len()).unwrap_or(0);
                // SAFETY: `usages` has room for `length` entries; the report is this device's.
                let status = unsafe {
                    HidP_GetUsages(
                        HidP_Input,
                        PAGE_DIGITIZER,
                        Some(slot.link),
                        usages.as_mut_ptr(),
                        &raw mut length,
                        data,
                        &mut writable,
                    )
                };
                let touching = status == HIDP_STATUS_SUCCESS
                    && usages
                        .iter()
                        .take(length as usize)
                        .any(|usage| *usage == USAGE_TIP_SWITCH);
                let (sx, sy) = to_screen(screen, rotation, slot.x.fraction(x), slot.y.fraction(y));
                Some(Contact {
                    id,
                    touching,
                    x: sx,
                    y: sy,
                })
            })
            .collect()
    }
}

/// Where a device is mapped: the screen rectangle (physical pixels) and how the display is turned.
/// `None` when Windows doesn't know the device as a pointer device.
#[must_use]
pub fn mapping(device: HANDLE) -> Option<(Screen, Rotation)> {
    let mut physical = RECT::default();
    let mut display = RECT::default();
    // SAFETY: two RECTs owned by this frame for the results.
    unsafe { GetPointerDeviceRects(device, &raw mut physical, &raw mut display) }.ok()?;
    let mut info = POINTER_DEVICE_INFO::default();
    // SAFETY: a POINTER_DEVICE_INFO owned by this frame for the result.
    let rotation = if unsafe { GetPointerDevice(device, &raw mut info) }.is_ok() {
        Rotation::from_display_config(info.displayOrientation)
    } else {
        Rotation::None
    };
    (display.right > display.left && display.bottom > display.top).then_some((
        Screen {
            left: display.left,
            top: display.top,
            right: display.right,
            bottom: display.bottom,
        },
        rotation,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_fields_are_sign_extended_and_unsigned_ones_kept() {
        assert_eq!(value_of(0x0FFF, Some(12)), -1);
        assert_eq!(value_of(0x07FF, Some(12)), 2047);
        assert_eq!(value_of(40_000, None), 40_000);
    }

    #[test]
    fn a_range_read_as_negative_is_the_whole_unsigned_field() {
        let mut cap = HIDP_VALUE_CAPS {
            BitSize: 16,
            LogicalMin: 0,
            LogicalMax: -1,
            ..HIDP_VALUE_CAPS::default()
        };
        assert_eq!(
            range_of(&cap),
            (
                Range {
                    min: 0,
                    max: 65_535
                },
                None
            )
        );
        cap.LogicalMax = 32_767;
        assert_eq!(
            range_of(&cap),
            (
                Range {
                    min: 0,
                    max: 32_767
                },
                None
            )
        );
        cap.LogicalMin = -100;
        assert_eq!(
            range_of(&cap),
            (
                Range {
                    min: -100,
                    max: 32_767
                },
                Some(16)
            )
        );
    }
}
