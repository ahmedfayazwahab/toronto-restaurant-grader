/**
 * A rough, clearly-labelled estimate of monthly revenue left on the table.
 * It is built from public data (review count, price range) and typical industry
 * assumptions. It is NOT a measurement of the restaurant's real sales.
 */
export const ASSUMPTIONS = {
  reviewRate: 0.02,          // about 2% of guests leave a Google review
  historyMonths: 36,         // reviews were collected over roughly 3 years
  minMonthlyGuests: 150,
  onlineShare: 0.4,          // share of guests who found or chose the place online
  maxUplift: 0.3,            // fixing everything could lift online-driven guests by up to 30%
  rangeSpread: 0.5,          // shown as +/- 50%
  defaultSpend: 30,          // CAD per guest when no price info
  spendByLevel: { PRICE_LEVEL_INEXPENSIVE: 15, PRICE_LEVEL_MODERATE: 30, PRICE_LEVEL_EXPENSIVE: 60, PRICE_LEVEL_VERY_EXPENSIVE: 100 },
};

export function estimateLoss({ score, reviews, priceRange, priceLevel, problems }) {
  if (score == null) return null;
  const A = ASSUMPTIONS;
  let spend = A.defaultSpend, spendBasis = 'a typical default';
  const lo = Number(priceRange?.startPrice?.units), hi = Number(priceRange?.endPrice?.units);
  if (lo && hi) { spend = (lo + hi) / 2; spendBasis = `the middle of your Google price range ($${lo}–$${hi})`; }
  else if (lo) { spend = lo; spendBasis = `your Google price range (from $${lo})`; }
  else if (A.spendByLevel[priceLevel]) { spend = A.spendByLevel[priceLevel]; spendBasis = `your Google price level`; }
  const monthlyGuests = Math.max(A.minMonthlyGuests, (reviews || 0) / A.reviewRate / A.historyMonths);
  const gap = Math.max(0, 1 - score / 100);
  const mid = monthlyGuests * A.onlineShare * A.maxUplift * gap * spend;
  const round = (n) => Math.round(n / 50) * 50;
  return {
    low: round(mid * (1 - A.rangeSpread)), mid: round(mid), high: round(mid * (1 + A.rangeSpread)), problems,
    monthlyGuests: Math.round(monthlyGuests), spend: Math.round(spend), spendBasis,
    assumptions: [
      `About ${Math.round(A.reviewRate * 100)}% of guests leave a Google review, so ${reviews || 0} reviews over ~${A.historyMonths} months suggests about ${Math.round(monthlyGuests)} guests a month.`,
      `Roughly ${Math.round(A.onlineShare * 100)}% of guests find or choose a restaurant online.`,
      `Fixing everything could win back up to ${Math.round(A.maxUplift * 100)}% more of those guests. We scale that by how far your score is from 100 (${score}/100).`,
      `Average spend per guest is $${Math.round(spend)}, based on ${spendBasis}.`,
    ],
  };
}
