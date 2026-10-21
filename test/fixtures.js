// The original 8-SKU sample catalogue, frozen. Unit tests for the matching rules use this so they do not
// depend on how much sample data the app ships with. Values are illustrative, in cm.
const sku = (id, name, category, fabric, size, cut, colour, m, stock, rack) =>
  ({ id, name, category, fabric, size, cut, colour, m, stock, rack });

export const SMALL_CATALOGUE = [
  sku('OX-L-SLIM', 'Oxford Shirt', 'shirt', 'oxford', 'L', 'Slim', 'White', { chest: 112, waist: 98, shoulder: 47, sleeve: 66, length: 77 }, 2, 'A3'),
  sku('OX-M-REG', 'Oxford Shirt', 'shirt', 'oxford', 'M', 'Regular', 'White', { chest: 110, waist: 104, shoulder: 46, sleeve: 64, length: 75 }, 3, 'A4'),
  sku('OX-XL-REG', 'Oxford Shirt', 'shirt', 'oxford', 'XL', 'Regular', 'White', { chest: 120, waist: 112, shoulder: 49, sleeve: 68, length: 79 }, 1, 'A5'),
  sku('PO-L-SLIM', 'Polo', 'polo', 'pique', 'L', 'Slim', 'Navy', { chest: 110, waist: 96, shoulder: 46, sleeve: 24, length: 72 }, 4, 'B1'),
  sku('PO-M-REG', 'Polo', 'polo', 'pique', 'M', 'Regular', 'White', { chest: 108, waist: 102, shoulder: 45, sleeve: 23, length: 70 }, 2, 'B2'),
  sku('CH-32-SLIM', 'Chinos', 'chinos', 'twill', '32', 'Slim', 'Khaki', { waist: 82, hip: 98, inseam: 79 }, 2, 'C2'),
  sku('CH-32-REG', 'Chinos', 'chinos', 'twill', '32', 'Regular', 'Khaki', { waist: 82, hip: 102, inseam: 80 }, 3, 'C3'),
  sku('CH-30-SLIM', 'Chinos', 'chinos', 'twill', '30', 'Slim', 'Khaki', { waist: 77, hip: 94, inseam: 77 }, 0, 'C1'),
];
