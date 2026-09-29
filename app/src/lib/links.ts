// $WELL trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_WELL_TRADE_URL overrides.
export const tradeUrl = (token?: string) =>
  process.env.NEXT_PUBLIC_WELL_TRADE_URL || `https://www.ponsfamily.com/launchpad${token ? `/${token}` : ""}`;
