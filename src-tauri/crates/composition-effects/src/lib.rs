//! Direct2D effects usable from Windows.UI.Composition without Win2D.
//!
//! Composition takes effects as `IGraphicsEffect` objects. Win2D normally supplies them; without
//! it, an effect describes itself through `IGraphicsEffectD2D1Interop` - the D2D effect's CLSID
//! plus its property values - which is all this crate implements.
#![cfg(windows)]

use windows::core::{implement, Interface, Result, GUID, HSTRING, PCWSTR};
use windows::Foundation::{IPropertyValue, PropertyValue};
use windows::Graphics::Effects::{IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectSource_Impl, IGraphicsEffect_Impl};
use windows::Win32::Foundation::E_INVALIDARG;
use windows::Win32::System::WinRT::Graphics::Direct2D::{IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl, GRAPHICS_EFFECT_PROPERTY_MAPPING};

// d2d1effects.h - by value rather than pulling in all of the Direct2D bindings.
const CLSID_D2D1_GAUSSIAN_BLUR: GUID = GUID::from_u128(0x1feb6d69_2fe6_4ac9_8c58_1d7f93e7a6a5);

/// A Gaussian blur of `source` (e.g. a `CompositionEffectSourceParameter`), `deviation` in DIPs.
/// Hard border mode, so no dark fade creeps in from the edges of whatever it's painted on.
pub fn gaussian_blur(deviation: f32, source: IGraphicsEffectSource) -> IGraphicsEffect {
    GaussianBlur { deviation, source }.into()
}

#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
struct GaussianBlur {
    deviation: f32,
    source: IGraphicsEffectSource,
}

#[allow(non_snake_case)]
impl IGraphicsEffect_Impl for GaussianBlur {
    fn Name(&self) -> Result<HSTRING> {
        Ok(HSTRING::from("Blur"))
    }
    fn SetName(&self, _name: &HSTRING) -> Result<()> {
        Ok(())
    }
}

impl IGraphicsEffectSource_Impl for GaussianBlur {}

#[allow(non_snake_case)]
impl IGraphicsEffectD2D1Interop_Impl for GaussianBlur {
    fn GetEffectId(&self) -> Result<GUID> {
        Ok(CLSID_D2D1_GAUSSIAN_BLUR)
    }
    fn GetNamedPropertyMapping(&self, _name: &PCWSTR, _index: *mut u32, _mapping: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING) -> Result<()> {
        // No animatable properties - a new strength builds a new brush.
        Err(E_INVALIDARG.into())
    }
    fn GetPropertyCount(&self) -> Result<u32> {
        Ok(3)
    }
    fn GetProperty(&self, index: u32) -> Result<IPropertyValue> {
        match index {
            // D2D1_GAUSSIANBLUR_PROP_STANDARD_DEVIATION
            0 => PropertyValue::CreateSingle(self.deviation)?.cast(),
            // D2D1_GAUSSIANBLUR_PROP_OPTIMIZATION: balanced
            1 => PropertyValue::CreateUInt32(1)?.cast(),
            // D2D1_GAUSSIANBLUR_PROP_BORDER_MODE: hard
            _ => PropertyValue::CreateUInt32(1)?.cast(),
        }
    }
    fn GetSource(&self, _index: u32) -> Result<IGraphicsEffectSource> {
        Ok(self.source.clone())
    }
    fn GetSourceCount(&self) -> Result<u32> {
        Ok(1)
    }
}
