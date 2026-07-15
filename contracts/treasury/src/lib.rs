#![no_std]

pub mod contract;
#[cfg(test)]
mod test;

pub use contract::{Allowance, Treasury, TreasuryClient, TreasuryError};
