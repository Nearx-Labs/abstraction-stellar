import { AccountCard } from '@/components/AccountCard';
import { FaucetCard } from '@/components/FaucetCard';
import { SponsorshipMeter } from '@/components/SponsorshipMeter';
import { TransferCard } from '@/components/TransferCard';

export function WalletPage({ address }: { address: string }) {
  return (
    <>
      <AccountCard address={address} />
      <SponsorshipMeter address={address} />
      <FaucetCard address={address} />
      <TransferCard address={address} />
    </>
  );
}
