// How prices read, and the one rule that depends on them. Prices are sample prices in rupees (see the catalogue).
import { priceLabel } from './catalogue.js';

export const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

/** "₹4,999 (Same price)", "₹5,299 (+₹300)" or "₹4,699 (−₹300)": a price, and how it compares with what the customer has. */
export function priceWithDelta(candidate, original) {
  if (!Number.isFinite(candidate?.price)) return '';
  if (!Number.isFinite(original?.price)) return priceLabel(candidate);
  const d = candidate.price - original.price;
  if (d === 0) return `${rupees(candidate.price)} (Same price)`;
  return `${rupees(candidate.price)} (${d > 0 ? '+' : '−'}${rupees(Math.abs(d))})`;
}

/** The same, in two parts: the figure, and how it compares ("Same price", "+₹300", "−₹300"). For chips that stack them. */
export function priceParts(candidate, original) {
  if (!Number.isFinite(candidate?.price)) return { price: '', delta: '' };
  const price = rupees(candidate.price);
  if (!Number.isFinite(original?.price)) return { price, delta: '' };
  const d = candidate.price - original.price;
  return { price, delta: d === 0 ? 'Same price' : `${d > 0 ? '+' : '−'}${rupees(Math.abs(d))}` };
}

/**
 * Did the customer decline an alternative that cost more than what it was brought for? Each declined item is compared
 * with the item of theirs it was chosen for (else the one they asked about). `get` looks an article up by id.
 */
export function declinedPricier(request, get) {
  return (request.declinedIds || []).some((id) => {
    const alt = get(id);
    const from = get(request.baseOf?.[id]) || get(request.skuId);
    return Number.isFinite(alt?.price) && Number.isFinite(from?.price) && alt.price > from.price;
  });
}
