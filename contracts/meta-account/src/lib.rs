#![no_std]

pub mod contract;
#[cfg(test)]
mod test;

pub use contract::{MetaAccount, MetaAccountClient};
