#![no_std]

pub mod contract;
#[cfg(test)]
mod test;

pub use contract::{
    attestation_message, EmailAttestation, EmailAttestationError, EmailAttestationVerifierContract,
    EmailAttestationVerifierContractClient, DOMAIN_SEPARATOR,
};
