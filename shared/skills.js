// Sections. A section is a department x kind of garment ("Men's shirts"). The admin gives each team member
// primary and secondary sections (see staffing.js); a request's section comes from its garment.
import { styleKind } from './events.js';

export const SKILLS = [
  { key: 'Men|shirt', label: "Men's shirts" },
  { key: 'Men|polo', label: "Men's polos" },
  { key: 'Men|trousers', label: "Men's trousers" },
  { key: 'Women|shirt', label: "Women's shirts" },
  { key: 'Women|polo', label: "Women's polos" },
  { key: 'Women|trousers', label: "Women's trousers" },
];
export const ALL_SKILLS = SKILLS.map((s) => s.key);
export const skillLabel = (key) => SKILLS.find((s) => s.key === key)?.label ?? key;

/** The skill a garment calls for. Rows without a department are from the original (men's) range. */
export const skillOf = (sku) => `${sku.department ?? 'Men'}|${styleKind(sku.category)}`;
