// Illustrative sample data — not Tommy Hilfiger specifications. Measurements in cm.
//
// The catalogue is generated from product lines (style variants) and a few explicit size grids, so every number is
// consistent:
//   - a LINE is one design: garment + collar/pattern/fabric (shirts), neckline/pattern (polos) or front/fabric
//     (trousers). All sizes, cuts and colours of a line share its attributes.
//   - bigger sizes are bigger, and Slim is trimmer than Regular at the same size
//   - colour variants of one style share measurements (only stock differs)
//   - every line + colour has the full size x cut grid, so any combination a customer picks exists
// Stock for the original demo lines is explicit; newer lines use a fixed, deterministic pattern with realistic gaps.
export const CATALOGUE_LABEL = 'Illustrative sample data — not Tommy Hilfiger specifications';

const r1 = (n) => Math.round(n * 10) / 10;

/** Shirts and polos: Regular measurements at the base size, a step per size, and a Slim offset. */
const tops = (regular, step, slim) => (_size, i, cut) =>
  Object.fromEntries(Object.keys(regular).map((k) => [k, r1(regular[k] + step[k] * i + (cut === 'Slim' ? slim[k] : 0))]));

/** Trousers: waist grows 2.5 cm per inch of size; leg length depends on the cut. A pleated front adds room at the hip. */
const trousers = ({ waist32, hip, inseam }, extraHip = 0) => (size, _i, cut) => {
  const d = Number(size) - 32;
  return { waist: r1(waist32 + 2.5 * d), hip: r1(hip[cut] + 2.5 * d + extraHip), inseam: inseam[cut] };
};

const TOP_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const BOTTOM_SIZES = ['28', '30', '32', '34', '36', '38'];
const W_TOP_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const W_BOTTOM_SIZES = ['26', '28', '30', '32', '34'];

const OXFORD = tops(
  { chest: 110, waist: 104, shoulder: 46, sleeve: 64, length: 75 },
  { chest: 5, waist: 4, shoulder: 1.5, sleeve: 2, length: 2 },
  { chest: -3, waist: -10, shoulder: -0.5, sleeve: 0, length: 0 },
);
const POPLIN = tops(
  { chest: 108, waist: 102, shoulder: 45.5, sleeve: 64, length: 74 },
  { chest: 5, waist: 4, shoulder: 1.5, sleeve: 2, length: 2 },
  { chest: -3, waist: -9, shoulder: -0.5, sleeve: 0, length: 0 },
);
const PIQUE = tops(
  { chest: 108, waist: 102, shoulder: 45, sleeve: 23, length: 70 },
  { chest: 5, waist: 5, shoulder: 1.5, sleeve: 1, length: 2 },
  { chest: -3, waist: -11, shoulder: -0.5, sleeve: 0, length: 0 },
);
const CHINO = { waist32: 82, hip: { Slim: 98, Regular: 102 }, inseam: { Slim: 79, Regular: 82 } };
// Women's range (department 'Women'): its own grading. "chest" is the bust measurement.
const W_STEP = { chest: 4, waist: 4, shoulder: 1.2, sleeve: 1.5, length: 1.5 };
const W_OXFORD = tops({ chest: 94, waist: 78, shoulder: 38, sleeve: 59, length: 66 }, W_STEP, { chest: -2, waist: -5, shoulder: -0.4, sleeve: 0, length: 0 });
const W_POPLIN = tops({ chest: 92, waist: 76, shoulder: 37.5, sleeve: 58, length: 65 }, W_STEP, { chest: -2, waist: -5, shoulder: -0.4, sleeve: 0, length: 0 });
const W_PIQUE = tops({ chest: 92, waist: 80, shoulder: 37, sleeve: 20, length: 60 }, { ...W_STEP, sleeve: 0.8 }, { chest: -2, waist: -6, shoulder: -0.4, sleeve: 0, length: 0 });
const W_JEAN = { waist32: 80, hip: { Slim: 102, Regular: 106 }, inseam: { Slim: 76, Regular: 79 } };
const W_CHINO = { waist32: 80, hip: { Slim: 101, Regular: 105 }, inseam: { Slim: 74, Regular: 77 } };
const JEAN = { waist32: 81, hip: { Slim: 96, Regular: 101 }, inseam: { Slim: 81, Regular: 83 } };

// The first colour of each line is its primary colour (it keeps the short SKU id and is the default in the picker).
// A colour without `stock` uses the deterministic pattern below.
const LINES = [
  // ---- Oxford shirts ----
  {
    code: 'OX', name: 'Oxford Shirt', category: 'shirt', fabric: 'oxford', aisle: 'A', rackBase: 0, sizes: TOP_SIZES, base: 'M', measures: OXFORD,
    styleName: 'Button-down · Solid', attrs: { collar: 'Button-down', pattern: 'Solid', fabric: 'Oxford' },
    colours: [
      { name: 'White', code: 'WHT', stock: { Slim: [1, 2, 2, 1, 0], Regular: [2, 3, 3, 1, 1] } },
      { name: 'Light Blue', code: 'LBL', stock: { Slim: [2, 1, 0, 2, 1], Regular: [1, 2, 2, 0, 2] } },
      { name: 'Navy', code: 'NVY', stock: { Slim: [0, 1, 2, 1, 0], Regular: [1, 2, 1, 2, 0] } },
    ],
  },
  {
    code: 'OS', name: 'Oxford Shirt', category: 'shirt', fabric: 'oxford', aisle: 'A', rackBase: 20, sizes: TOP_SIZES, base: 'M', measures: OXFORD,
    styleName: 'Spread · Solid', attrs: { collar: 'Spread', pattern: 'Solid', fabric: 'Oxford' },
    colours: [{ name: 'White', code: 'WHT' }, { name: 'Navy', code: 'NVY' }],
  },
  {
    code: 'OT', name: 'Oxford Shirt', category: 'shirt', fabric: 'oxford', aisle: 'A', rackBase: 40, sizes: TOP_SIZES, base: 'M', measures: OXFORD,
    styleName: 'Button-down · Stripe', attrs: { collar: 'Button-down', pattern: 'Stripe', fabric: 'Oxford' },
    colours: [{ name: 'Blue', code: 'BLU' }, { name: 'Navy', code: 'NVY' }],
  },
  // ---- Poplin shirts ----
  {
    code: 'PL', name: 'Poplin Shirt', category: 'shirt', fabric: 'poplin', aisle: 'D', rackBase: 0, sizes: TOP_SIZES, base: 'M', measures: POPLIN,
    styleName: 'Spread · Solid', attrs: { collar: 'Spread', pattern: 'Solid', fabric: 'Poplin' },
    colours: [
      { name: 'Sky Blue', code: 'SKY', stock: { Slim: [1, 3, 2, 2, 1], Regular: [2, 2, 3, 2, 1] } },
      { name: 'White', code: 'WHT', stock: { Slim: [2, 2, 1, 1, 0], Regular: [1, 3, 2, 1, 1] } },
    ],
  },
  {
    code: 'PB', name: 'Poplin Shirt', category: 'shirt', fabric: 'poplin', aisle: 'D', rackBase: 20, sizes: TOP_SIZES, base: 'M', measures: POPLIN,
    styleName: 'Button-down · Solid', attrs: { collar: 'Button-down', pattern: 'Solid', fabric: 'Poplin' },
    colours: [{ name: 'Sky Blue', code: 'SKY' }, { name: 'White', code: 'WHT' }],
  },
  {
    code: 'PC', name: 'Poplin Shirt', category: 'shirt', fabric: 'poplin', aisle: 'D', rackBase: 40, sizes: TOP_SIZES, base: 'M', measures: POPLIN,
    styleName: 'Spread · Check', attrs: { collar: 'Spread', pattern: 'Check', fabric: 'Poplin' },
    colours: [{ name: 'Blue', code: 'BLU' }, { name: 'Red', code: 'RED' }],
  },
  // ---- Polos ----
  {
    code: 'PO', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'B', rackBase: 0, sizes: TOP_SIZES, base: 'M', measures: PIQUE,
    styleName: 'Classic collar · Solid', attrs: { neckline: 'Classic collar', pattern: 'Solid' },
    colours: [
      { name: 'Navy', code: 'NVY', stock: { Slim: [2, 3, 4, 2, 1], Regular: [3, 2, 3, 2, 0] } },
      { name: 'White', code: 'WHT', stock: { Slim: [1, 2, 2, 0, 1], Regular: [2, 3, 1, 2, 1] } },
      { name: 'Red', code: 'RED', stock: { Slim: [0, 1, 2, 1, 0], Regular: [1, 2, 2, 1, 0] } },
    ],
  },
  {
    code: 'PS', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'B', rackBase: 20, sizes: TOP_SIZES, base: 'M', measures: PIQUE,
    styleName: 'Classic collar · Stripe', attrs: { neckline: 'Classic collar', pattern: 'Stripe' },
    colours: [{ name: 'Navy', code: 'NVY' }, { name: 'Red', code: 'RED' }],
  },
  {
    code: 'PM', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'B', rackBase: 40, sizes: TOP_SIZES, base: 'M', measures: PIQUE,
    styleName: 'Mock neck · Solid', attrs: { neckline: 'Mock neck', pattern: 'Solid' },
    colours: [{ name: 'Navy', code: 'NVY' }, { name: 'White', code: 'WHT' }],
  },
  // ---- Chinos ----
  {
    code: 'CH', name: 'Chinos', category: 'chinos', fabric: 'twill', aisle: 'C', rackBase: 0, sizes: BOTTOM_SIZES, base: '32', measures: trousers(CHINO),
    styleName: 'Flat front', attrs: { front: 'Flat', fabric: 'Twill' },
    colours: [
      // 30 Slim has a shorter leg (77 cm) but is out of stock: it is what makes the "no shorter inseam in stock" demo honest.
      { name: 'Khaki', code: 'KHK', stock: { Slim: [1, 0, 2, 2, 1, 0], Regular: [1, 2, 3, 2, 2, 1] } },
      { name: 'Navy', code: 'NVY', stock: { Slim: [0, 1, 1, 2, 1, 1], Regular: [1, 1, 2, 1, 0, 1] } },
    ],
    overrides: { 'CH-30-SLIM': { inseam: 77 } },
  },
  {
    code: 'CP', name: 'Chinos', category: 'chinos', fabric: 'twill', aisle: 'C', rackBase: 20, sizes: BOTTOM_SIZES, base: '32', measures: trousers(CHINO, 2),
    styleName: 'Pleated front', attrs: { front: 'Pleated', fabric: 'Twill' },
    colours: [{ name: 'Khaki', code: 'KHK' }, { name: 'Navy', code: 'NVY' }],
  },
  // ---- Jeans ----
  {
    code: 'JN', name: 'Jeans', category: 'jeans', fabric: 'denim', aisle: 'E', rackBase: 0, sizes: BOTTOM_SIZES, base: '32', measures: trousers(JEAN),
    styleName: 'Flat front', attrs: { front: 'Flat', fabric: 'Denim' },
    colours: [
      { name: 'Dark Indigo', code: 'IND', stock: { Slim: [2, 3, 3, 2, 1, 0], Regular: [1, 2, 3, 2, 2, 1] } },
      { name: 'Light Wash', code: 'LWS', stock: { Slim: [1, 2, 2, 1, 0, 1], Regular: [0, 1, 2, 2, 1, 0] } },
    ],
  },
  // ================= Women's range =================
  // ---- Women's shirts ----
  {
    code: 'WX', department: 'Women', name: 'Oxford Shirt', category: 'shirt', fabric: 'oxford', aisle: 'F', rackBase: 0, sizes: W_TOP_SIZES, base: 'M', measures: W_OXFORD,
    styleName: 'Button-down · Solid', attrs: { collar: 'Button-down', pattern: 'Solid', fabric: 'Oxford' },
    colours: [{ name: 'White', code: 'WHT' }, { name: 'Light Blue', code: 'LBL' }],
  },
  {
    code: 'WY', department: 'Women', name: 'Oxford Shirt', category: 'shirt', fabric: 'oxford', aisle: 'F', rackBase: 20, sizes: W_TOP_SIZES, base: 'M', measures: W_OXFORD,
    styleName: 'Spread · Solid', attrs: { collar: 'Spread', pattern: 'Solid', fabric: 'Oxford' },
    colours: [{ name: 'White', code: 'WHT' }, { name: 'Navy', code: 'NVY' }],
  },
  {
    code: 'WP', department: 'Women', name: 'Poplin Shirt', category: 'shirt', fabric: 'poplin', aisle: 'F', rackBase: 40, sizes: W_TOP_SIZES, base: 'M', measures: W_POPLIN,
    styleName: 'Spread · Solid', attrs: { collar: 'Spread', pattern: 'Solid', fabric: 'Poplin' },
    colours: [{ name: 'Sky Blue', code: 'SKY' }, { name: 'White', code: 'WHT' }],
  },
  {
    code: 'WS', department: 'Women', name: 'Poplin Shirt', category: 'shirt', fabric: 'poplin', aisle: 'F', rackBase: 60, sizes: W_TOP_SIZES, base: 'M', measures: W_POPLIN,
    styleName: 'Spread · Stripe', attrs: { collar: 'Spread', pattern: 'Stripe', fabric: 'Poplin' },
    colours: [{ name: 'Blue', code: 'BLU' }, { name: 'Navy', code: 'NVY' }],
  },
  // ---- Women's polos ----
  {
    code: 'WL', department: 'Women', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'G', rackBase: 0, sizes: W_TOP_SIZES, base: 'M', measures: W_PIQUE,
    styleName: 'Classic collar · Solid', attrs: { neckline: 'Classic collar', pattern: 'Solid' },
    colours: [{ name: 'Navy', code: 'NVY' }, { name: 'White', code: 'WHT' }],
  },
  {
    code: 'WM', department: 'Women', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'G', rackBase: 20, sizes: W_TOP_SIZES, base: 'M', measures: W_PIQUE,
    styleName: 'Classic collar · Stripe', attrs: { neckline: 'Classic collar', pattern: 'Stripe' },
    colours: [{ name: 'Navy', code: 'NVY' }, { name: 'Red', code: 'RED' }],
  },
  {
    code: 'WN', department: 'Women', name: 'Polo', category: 'polo', fabric: 'pique', aisle: 'G', rackBase: 40, sizes: W_TOP_SIZES, base: 'M', measures: W_PIQUE,
    styleName: 'Mock neck · Solid', attrs: { neckline: 'Mock neck', pattern: 'Solid' },
    colours: [{ name: 'Navy', code: 'NVY' }, { name: 'White', code: 'WHT' }],
  },
  // ---- Women's trousers ----
  {
    code: 'WJ', department: 'Women', name: 'Jeans', category: 'jeans', fabric: 'denim', aisle: 'H', rackBase: 0, sizes: W_BOTTOM_SIZES, base: '30', measures: trousers(W_JEAN),
    styleName: 'Flat front', attrs: { front: 'Flat', fabric: 'Denim' },
    colours: [{ name: 'Dark Indigo', code: 'IND' }, { name: 'Light Wash', code: 'LWS' }],
  },
  {
    code: 'WC', department: 'Women', name: 'Chinos', category: 'chinos', fabric: 'twill', aisle: 'H', rackBase: 20, sizes: W_BOTTOM_SIZES, base: '30', measures: trousers(W_CHINO),
    styleName: 'Flat front', attrs: { front: 'Flat', fabric: 'Twill' },
    colours: [{ name: 'Khaki', code: 'KHK' }, { name: 'Navy', code: 'NVY' }],
  },
  {
    code: 'WQ', department: 'Women', name: 'Chinos', category: 'chinos', fabric: 'twill', aisle: 'H', rackBase: 40, sizes: W_BOTTOM_SIZES, base: '30', measures: trousers(W_CHINO, 2),
    styleName: 'Pleated front', attrs: { front: 'Pleated', fabric: 'Twill' },
    colours: [{ name: 'Khaki', code: 'KHK' }, { name: 'Navy', code: 'NVY' }],
  },
];

// Racks of the original eight demo SKUs are kept; every other SKU gets a rack from its aisle, line, colour, cut and size band.
const RACK_OVERRIDES = {
  'OX-L-SLIM': 'A3', 'OX-M-REG': 'A4', 'OX-XL-REG': 'A5', 'PO-L-SLIM': 'B1', 'PO-M-REG': 'B2',
  'CH-32-SLIM': 'C2', 'CH-32-REG': 'C3', 'CH-30-SLIM': 'C1',
};

// Deterministic stock for lines without an explicit table: 0-4 units, with about one in nine out of stock.
const PATTERN = [0, 1, 1, 2, 2, 2, 3, 3, 4];
function patternStock(code, ci, cutIdx, si) {
  let h = 7;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return PATTERN[(h + ci * 17 + cutIdx * 29 + si * 43) % 9];
}

function build() {
  const out = [];
  for (const f of LINES) {
    const baseIdx = f.sizes.indexOf(f.base);
    f.colours.forEach((col, ci) => {
      ['Slim', 'Regular'].forEach((cut, cutIdx) => {
        f.sizes.forEach((size, si) => {
          const id = `${f.code}-${size}-${cut === 'Slim' ? 'SLIM' : 'REG'}${ci === 0 ? '' : `-${col.code}`}`;
          const band = Math.min(2, Math.floor((si * 3) / f.sizes.length));
          out.push({
            id, line: f.code, department: f.department || 'Men', name: f.name, category: f.category, fabric: f.fabric, styleName: f.styleName, attrs: { ...f.attrs },
            size, cut, colour: col.name,
            m: { ...f.measures(size, si - baseIdx, cut), ...(f.overrides?.[id] || {}) },
            stock: col.stock ? col.stock[cut][si] : patternStock(f.code, ci, cutIdx, si),
            rack: RACK_OVERRIDES[id] || `${f.aisle}${f.rackBase + ci * 6 + cutIdx * 3 + band + 1}`,
          });
        });
      });
    });
  }
  return out;
}

export const CATALOGUE = build();

export const MEASURE_LABELS = {
  chest: 'Chest', waist: 'Waist', shoulder: 'Shoulder', sleeve: 'Sleeve',
  length: 'Body length', hip: 'Hip', inseam: 'Inseam',
};

export const getSku = (id, catalogue = CATALOGUE) => catalogue.find((s) => s.id === id) || null;
/** The style variant is part of the name, so two Oxford shirts are never ambiguous. */
export const skuLabel = (s) => `${s.department === 'Women' ? "Women's " : ''}${s.name}${s.styleName ? ` (${s.styleName})` : ''} · ${s.colour} · ${s.size} ${s.cut}`;
export const garments = (catalogue = CATALOGUE, department = null) => [...new Set(catalogue.filter((s) => !department || s.department === department).map((s) => s.name))];
/** The style variants of one garment, primary first. */
export const stylesFor = (name, catalogue = CATALOGUE, department = null) => [...new Set(catalogue.filter((s) => s.name === name && (!department || s.department === department)).map((s) => s.styleName))];
