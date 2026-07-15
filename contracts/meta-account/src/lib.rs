#![no_std]

pub mod contract;
pub mod recovery;
#[cfg(test)]
mod test;

pub use contract::{MetaAccount, MetaAccountClient};
pub use recovery::{RecoveryError, RecoveryPolicy, RecoveryState};
