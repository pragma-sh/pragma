//! Expo push notifications for paired phones.
//!
//! Registration lives in [`crate::devices`] (a push token is one more field on
//! an authenticated device); [`worker`] watches the host's agent stream and
//! delivers; [`text`] renders the same wording the desktop toast uses.

pub mod expo;
pub mod presence;
pub mod text;
pub mod worker;
pub mod workspace;

pub use presence::DesktopPresence;
pub use worker::PushWorker;
