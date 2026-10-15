// Reputation strength: a rating weighted by how many reviews back it up (a Bayesian average).
// A 4.9 from 50 reviews is less trustworthy than a 4.8 from 2,500, so it should not outrank it.
// Keep PRIOR_REVIEWS and PRIOR_RATING in sync with the copy in public/report.html.
export const PRIOR_REVIEWS = 150;   // how many reviews it takes before a restaurant's own rating counts for most
export const PRIOR_RATING = 4.3;    // what we assume for a restaurant with no reviews
export const FEW_REVIEWS = 100;     // under this, flag the restaurant as "few reviews, may be new"

export const weightedRating = (rating, reviews) => {
  if (rating == null) return 0;
  const v = reviews || 0;
  return (v / (v + PRIOR_REVIEWS)) * rating + (PRIOR_REVIEWS / (v + PRIOR_REVIEWS)) * PRIOR_RATING;
};
export const looksNew = (c) => (c.reviews || 0) < FEW_REVIEWS || /opening soon|coming soon|grand opening/i.test(c.name || '');
