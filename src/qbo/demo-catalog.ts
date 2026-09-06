// The demo dataset itself: 9 part categories, ~95 parts and 16 customers, shaped like a
// real karting operation's QuickBooks company rather than Intuit's stock landscaping demo.
//
// Data only — no I/O. `src/scripts/seed-qbo-catalog.ts` turns this into QuickBooks records
// and `src/qbo/catalog.ts` validates the names and SKUs on the way through.
//
// Conventions this file exists to demonstrate end to end:
//  - Every part carries a SKU. The SKU is the permanent technical identifier (design doc
//    §9/§10) and the only thing both languages agree on.
//  - Every name follows `English Name - Nombre Español` (§10), so one substring match finds
//    the part in either language.
//  - Spanish names deliberately carry accents (Piñón, Neumáticos, Dirección, Cigüeñal,
//    Líquido, Bujía, Carrocería…) so the accent-folding search in src/search.ts is exercised
//    against the real catalog and not just its unit test (§12.2).
//  - Nothing is priced $0. A $0 part makes the manager's review screen unreadable and hides
//    exactly the mistake the review exists to catch.

/** The nine part categories. Order is the order they are created in. */
export const DEMO_CATEGORIES = [
  'Tires',
  'Axles',
  'Sprockets',
  'Chains',
  'Brakes',
  'Bodywork',
  'Engine',
  'Hardware',
  'Other',
] as const;

export type DemoCategory = (typeof DEMO_CATEGORIES)[number];

export interface DemoPart {
  sku: string;
  category: DemoCategory;
  /** English half of the bilingual `Name`. */
  en: string;
  /** Spanish half of the bilingual `Name`. */
  es: string;
  /** English half of the bilingual `Description`. */
  descEn: string;
  /** Spanish half of the bilingual `Description`. */
  descEs: string;
  unitPrice: number;
}

export const DEMO_PARTS: DemoPart[] = [
  // --- Tires -------------------------------------------------------------
  { sku: 'MG-YEL', category: 'Tires', en: 'MG Yellow Tire', es: 'Neumático MG Amarillo', descEn: 'MG Yellow compound slick, single tire', descEs: 'Slick de compuesto MG Amarillo, neumático individual', unitPrice: 52.5 },
  { sku: 'MG-RED', category: 'Tires', en: 'MG Red Tire', es: 'Neumático MG Rojo', descEn: 'MG Red compound slick, single tire', descEs: 'Slick de compuesto MG Rojo, neumático individual', unitPrice: 55 },
  { sku: 'MG-WHT', category: 'Tires', en: 'MG White Tire', es: 'Neumático MG Blanco', descEn: 'MG White compound slick, single tire', descEs: 'Slick de compuesto MG Blanco, neumático individual', unitPrice: 54 },
  { sku: 'MG-HZ', category: 'Tires', en: 'MG HZ Tire', es: 'Neumático MG HZ', descEn: 'MG HZ hard compound slick, single tire', descEs: 'Slick de compuesto duro MG HZ, neumático individual', unitPrice: 53 },
  { sku: 'MG-WT', category: 'Tires', en: 'MG Wet Tire', es: 'Neumático MG de Lluvia', descEn: 'MG WT rain tire, single tire', descEs: 'Neumático de lluvia MG WT, individual', unitPrice: 58 },
  { sku: 'VEGA-XM', category: 'Tires', en: 'Vega XM Tire', es: 'Neumático Vega XM', descEn: 'Vega XM compound slick, single tire', descEs: 'Slick de compuesto Vega XM, neumático individual', unitPrice: 51 },
  { sku: 'VEGA-SL4', category: 'Tires', en: 'Vega SL4 Tire', es: 'Neumático Vega SL4', descEn: 'Vega SL4 compound slick, single tire', descEs: 'Slick de compuesto Vega SL4, neumático individual', unitPrice: 56 },
  { sku: 'BST-YLB', category: 'Tires', en: 'Bridgestone YLB Tire', es: 'Neumático Bridgestone YLB', descEn: 'Bridgestone YLB slick, single tire', descEs: 'Slick Bridgestone YLB, neumático individual', unitPrice: 57.5 },
  { sku: 'HOOS-R60', category: 'Tires', en: 'Hoosier R60 Tire', es: 'Neumático Hoosier R60', descEn: 'Hoosier R60 slick, single tire', descEs: 'Slick Hoosier R60, neumático individual', unitPrice: 62 },
  { sku: 'TIRE-SET-MG', category: 'Tires', en: 'MG Yellow Tire Set', es: 'Juego de Neumáticos MG Amarillos', descEn: 'Set of four MG Yellow slicks, two front two rear', descEs: 'Juego de cuatro slicks MG Amarillos, dos delanteros dos traseros', unitPrice: 210 },
  { sku: 'TIRE-SET-VEGA', category: 'Tires', en: 'Vega XM Tire Set', es: 'Juego de Neumáticos Vega XM', descEn: 'Set of four Vega XM slicks, two front two rear', descEs: 'Juego de cuatro slicks Vega XM, dos delanteros dos traseros', unitPrice: 204 },
  { sku: 'TIRE-SET-RAIN', category: 'Tires', en: 'Rain Tire Set', es: 'Juego de Neumáticos de Lluvia', descEn: 'Set of four wet-weather tires', descEs: 'Juego de cuatro neumáticos de lluvia', unitPrice: 232 },

  // --- Axles -------------------------------------------------------------
  { sku: 'AX50-S', category: 'Axles', en: '50mm Soft Axle', es: 'Eje blando 50mm', descEn: '50mm soft-flex rear axle, 1040mm', descEs: 'Eje trasero de flexión blanda 50mm, 1040mm', unitPrice: 175 },
  { sku: 'AX50-M', category: 'Axles', en: '50mm Medium Axle', es: 'Eje medio 50mm', descEn: '50mm medium-flex rear axle, 1040mm', descEs: 'Eje trasero de flexión media 50mm, 1040mm', unitPrice: 178 },
  { sku: 'AX50-H', category: 'Axles', en: '50mm Hard Axle', es: 'Eje duro 50mm', descEn: '50mm hard-flex rear axle, 1040mm', descEs: 'Eje trasero de flexión dura 50mm, 1040mm', unitPrice: 182 },
  { sku: 'AX50-XH', category: 'Axles', en: '50mm Extra Hard Axle', es: 'Eje extra duro 50mm', descEn: '50mm extra-hard rear axle, 1040mm', descEs: 'Eje trasero extra duro 50mm, 1040mm', unitPrice: 188 },
  { sku: 'AX40-M', category: 'Axles', en: '40mm Medium Axle', es: 'Eje medio 40mm', descEn: '40mm medium-flex rear axle for cadet chassis', descEs: 'Eje trasero de flexión media 40mm para chasis cadete', unitPrice: 165 },
  { sku: 'AX30-M', category: 'Axles', en: '30mm Medium Axle', es: 'Eje medio 30mm', descEn: '30mm medium-flex rear axle for baby kart', descEs: 'Eje trasero de flexión media 30mm para baby kart', unitPrice: 152 },
  { sku: 'AX-KEY', category: 'Axles', en: 'Axle Key 8mm', es: 'Chaveta de eje 8mm', descEn: '8mm square axle key, 40mm long', descEs: 'Chaveta cuadrada de eje 8mm, 40mm de largo', unitPrice: 6.5 },
  { sku: 'AX-BRG', category: 'Axles', en: 'Axle Bearing 50mm', es: 'Rodamiento de eje 50mm', descEn: 'Sealed 50mm axle bearing', descEs: 'Rodamiento de eje 50mm sellado', unitPrice: 34 },
  { sku: 'AX-COLLAR', category: 'Axles', en: 'Axle Collar 50mm', es: 'Collarín de eje 50mm', descEn: 'Clamping axle collar, 50mm', descEs: 'Collarín de apriete para eje, 50mm', unitPrice: 18 },
  { sku: 'AX-CASS', category: 'Axles', en: 'Axle Bearing Cassette', es: 'Casete de rodamiento de eje', descEn: 'Aluminium bearing cassette with hardware', descEs: 'Casete de rodamiento de aluminio con tornillería', unitPrice: 46 },

  // --- Sprockets ---------------------------------------------------------
  { sku: 'SPR-11T', category: 'Sprockets', en: '11T Front Sprocket', es: 'Piñón delantero 11T', descEn: '11-tooth #219 front sprocket', descEs: 'Piñón delantero #219 de 11 dientes', unitPrice: 32 },
  { sku: 'SPR-12T', category: 'Sprockets', en: '12T Front Sprocket', es: 'Piñón delantero 12T', descEn: '12-tooth #219 front sprocket', descEs: 'Piñón delantero #219 de 12 dientes', unitPrice: 33 },
  { sku: 'SPR-13T', category: 'Sprockets', en: '13T Front Sprocket', es: 'Piñón delantero 13T', descEn: '13-tooth #219 front sprocket', descEs: 'Piñón delantero #219 de 13 dientes', unitPrice: 34 },
  { sku: 'SPR-72T', category: 'Sprockets', en: '72T Rear Sprocket', es: 'Corona trasera 72T', descEn: '72-tooth #219 rear sprocket, 6-hole', descEs: 'Corona trasera #219 de 72 dientes, 6 agujeros', unitPrice: 38 },
  { sku: 'SPR-76T', category: 'Sprockets', en: '76T Rear Sprocket', es: 'Corona trasera 76T', descEn: '76-tooth #219 rear sprocket, 6-hole', descEs: 'Corona trasera #219 de 76 dientes, 6 agujeros', unitPrice: 39.5 },
  { sku: 'SPR-80T', category: 'Sprockets', en: '80T Rear Sprocket', es: 'Corona trasera 80T', descEn: '80-tooth #219 rear sprocket, 6-hole', descEs: 'Corona trasera #219 de 80 dientes, 6 agujeros', unitPrice: 41 },
  { sku: 'SPR-84T', category: 'Sprockets', en: '84T Rear Sprocket', es: 'Corona trasera 84T', descEn: '84-tooth #219 rear sprocket, 6-hole', descEs: 'Corona trasera #219 de 84 dientes, 6 agujeros', unitPrice: 43 },
  { sku: 'SPR-88T', category: 'Sprockets', en: '88T Rear Sprocket', es: 'Corona trasera 88T', descEn: '88-tooth #219 rear sprocket, 6-hole', descEs: 'Corona trasera #219 de 88 dientes, 6 agujeros', unitPrice: 45 },
  { sku: 'SPR-CARR', category: 'Sprockets', en: 'Sprocket Carrier 50mm', es: 'Portacorona 50mm', descEn: 'Split aluminium sprocket carrier for 50mm axle', descEs: 'Portacorona de aluminio partido para eje de 50mm', unitPrice: 88 },
  { sku: 'SPR-GRD', category: 'Sprockets', en: 'Sprocket Guard', es: 'Protector de corona', descEn: 'CIK-compliant rear sprocket guard', descEs: 'Protector de corona trasera homologado CIK', unitPrice: 26 },
  { sku: 'SPR-HUB', category: 'Sprockets', en: 'Sprocket Bolt Kit', es: 'Kit de tornillos de corona', descEn: 'Six-bolt sprocket mounting kit', descEs: 'Kit de montaje de corona de seis tornillos', unitPrice: 15 },
  { sku: 'SPR-ALIGN', category: 'Sprockets', en: 'Sprocket Alignment Tool', es: 'Herramienta de alineación de corona', descEn: 'Laser sprocket and chain alignment tool', descEs: 'Herramienta láser de alineación de corona y cadena', unitPrice: 42 },

  // --- Chains ------------------------------------------------------------
  { sku: 'CH219-L', category: 'Chains', en: '#219 Chain 106 Link', es: 'Cadena #219 de 106 eslabones', descEn: '#219 pitch racing chain, 106 links', descEs: 'Cadena de competición paso #219, 106 eslabones', unitPrice: 48 },
  { sku: 'CH219-S', category: 'Chains', en: '#219 Chain 98 Link', es: 'Cadena #219 de 98 eslabones', descEn: '#219 pitch racing chain, 98 links', descEs: 'Cadena de competición paso #219, 98 eslabones', unitPrice: 45 },
  { sku: 'CH35-L', category: 'Chains', en: '#35 Chain 110 Link', es: 'Cadena #35 de 110 eslabones', descEn: '#35 pitch chain, 110 links, for four-cycle', descEs: 'Cadena paso #35, 110 eslabones, para motor de cuatro tiempos', unitPrice: 42 },
  { sku: 'CH-LINK-219', category: 'Chains', en: '#219 Master Link', es: 'Eslabón maestro #219', descEn: 'Single #219 master link, clip type', descEs: 'Eslabón maestro #219 individual, tipo clip', unitPrice: 8 },
  { sku: 'CH-LINK-35', category: 'Chains', en: '#35 Master Link', es: 'Eslabón maestro #35', descEn: 'Single #35 master link, clip type', descEs: 'Eslabón maestro #35 individual, tipo clip', unitPrice: 7.5 },
  { sku: 'CH-LUBE', category: 'Chains', en: 'Chain Lubricant Spray', es: 'Lubricante de cadena en aerosol', descEn: 'High-temperature chain lube, 400ml aerosol', descEs: 'Lubricante de cadena de alta temperatura, aerosol de 400ml', unitPrice: 16.5 },
  { sku: 'CH-BRK', category: 'Chains', en: 'Chain Breaker Tool', es: 'Herramienta cortacadenas', descEn: 'Chain breaker for #219 and #35 pitch', descEs: 'Cortacadenas para paso #219 y #35', unitPrice: 38 },
  { sku: 'CH-GRD', category: 'Chains', en: 'Chain Guard', es: 'Protector de cadena', descEn: 'Plastic chain guard with mounting bracket', descEs: 'Protector de cadena de plástico con soporte', unitPrice: 29 },

  // --- Brakes ------------------------------------------------------------
  { sku: 'BRK-PAD-F', category: 'Brakes', en: 'Front Brake Pads', es: 'Pastillas de freno delanteras', descEn: 'Front brake pad pair, sintered', descEs: 'Par de pastillas de freno delanteras, sinterizadas', unitPrice: 45 },
  { sku: 'BRK-PAD-R', category: 'Brakes', en: 'Rear Brake Pads', es: 'Pastillas de freno traseras', descEn: 'Rear brake pad pair, sintered', descEs: 'Par de pastillas de freno traseras, sinterizadas', unitPrice: 48 },
  { sku: 'BRK-DISC-R', category: 'Brakes', en: 'Rear Brake Disc', es: 'Disco de freno trasero', descEn: 'Ventilated rear brake disc, 195mm', descEs: 'Disco de freno trasero ventilado, 195mm', unitPrice: 128 },
  { sku: 'BRK-DISC-F', category: 'Brakes', en: 'Front Brake Disc', es: 'Disco de freno delantero', descEn: 'Front brake disc, 165mm', descEs: 'Disco de freno delantero, 165mm', unitPrice: 118 },
  { sku: 'BRK-FLUID', category: 'Brakes', en: 'Brake Fluid DOT 4', es: 'Líquido de frenos DOT 4', descEn: 'DOT 4 racing brake fluid, 500ml', descEs: 'Líquido de frenos de competición DOT 4, 500ml', unitPrice: 14 },
  { sku: 'BRK-CAL-SEAL', category: 'Brakes', en: 'Caliper Seal Kit', es: 'Kit de juntas de pinza de freno', descEn: 'Brake caliper piston seal rebuild kit', descEs: 'Kit de reparación de juntas de pistón de pinza de freno', unitPrice: 36 },
  { sku: 'BRK-LINE', category: 'Brakes', en: 'Brake Line 1m', es: 'Manguera de freno 1m', descEn: 'Braided brake line, one metre, with fittings', descEs: 'Manguera de freno trenzada, un metro, con racores', unitPrice: 22 },
  { sku: 'BRK-MC', category: 'Brakes', en: 'Brake Master Cylinder', es: 'Bomba de freno', descEn: 'Rear brake master cylinder assembly', descEs: 'Conjunto de bomba de freno trasero', unitPrice: 165 },
  { sku: 'BRK-PEDAL', category: 'Brakes', en: 'Brake Pedal Assembly', es: 'Conjunto de pedal de freno', descEn: 'Adjustable brake pedal with pushrod', descEs: 'Pedal de freno ajustable con varilla de empuje', unitPrice: 92 },
  { sku: 'BRK-BLEED', category: 'Brakes', en: 'Brake Bleed Kit', es: 'Kit de purga de frenos', descEn: 'Vacuum brake bleeding kit', descEs: 'Kit de purga de frenos por vacío', unitPrice: 27.5 },

  // --- Bodywork ----------------------------------------------------------
  { sku: 'BOD-KIT-CIK', category: 'Bodywork', en: 'CIK Bodywork Kit', es: 'Kit de carrocería CIK', descEn: 'Full CIK-homologated bodywork kit, unpainted', descEs: 'Kit completo de carrocería homologado CIK, sin pintar', unitPrice: 320 },
  { sku: 'BOD-NOSE', category: 'Bodywork', en: 'Nose Cone', es: 'Cono delantero', descEn: 'CIK nose cone, front fairing not included', descEs: 'Cono delantero CIK, carenado no incluido', unitPrice: 78 },
  { sku: 'BOD-NOSE-MNT', category: 'Bodywork', en: 'Nose Cone Mount Kit', es: 'Kit de soporte de cono delantero', descEn: 'Nose cone mounting bracket and hardware', descEs: 'Soporte y tornillería de montaje del cono delantero', unitPrice: 34 },
  { sku: 'BOD-SIDE-L', category: 'Bodywork', en: 'Left Side Pod', es: 'Pontón izquierdo', descEn: 'Left-hand CIK side pod', descEs: 'Pontón izquierdo CIK', unitPrice: 62 },
  { sku: 'BOD-SIDE-R', category: 'Bodywork', en: 'Right Side Pod', es: 'Pontón derecho', descEn: 'Right-hand CIK side pod', descEs: 'Pontón derecho CIK', unitPrice: 62 },
  { sku: 'BOD-FLOOR', category: 'Bodywork', en: 'Floor Tray', es: 'Bandeja de piso', descEn: 'CIK floor tray with mounting hardware', descEs: 'Bandeja de piso CIK con tornillería de montaje', unitPrice: 96 },
  { sku: 'BOD-FAIR', category: 'Bodywork', en: 'Front Fairing', es: 'Carenado delantero', descEn: 'Front fairing panel, CIK homologated', descEs: 'Panel de carenado delantero, homologado CIK', unitPrice: 58 },
  { sku: 'BOD-SEAT', category: 'Bodywork', en: 'Racing Seat', es: 'Asiento de competición', descEn: 'Fibreglass racing seat, standard size', descEs: 'Asiento de competición de fibra de vidrio, talla estándar', unitPrice: 145 },
  { sku: 'BOD-SEAT-STRUT', category: 'Bodywork', en: 'Seat Strut Kit', es: 'Kit de tirantes de asiento', descEn: 'Adjustable seat strut pair with hardware', descEs: 'Par de tirantes de asiento ajustables con tornillería', unitPrice: 41 },
  { sku: 'BOD-NUMBER', category: 'Bodywork', en: 'Number Panel Set', es: 'Juego de paneles de número', descEn: 'Number panel set with vinyl digits', descEs: 'Juego de paneles de número con dígitos de vinilo', unitPrice: 24 },

  // --- Engine ------------------------------------------------------------
  { sku: 'ENG-PIST-IAME', category: 'Engine', en: 'IAME X30 Piston Kit', es: 'Kit de pistón IAME X30', descEn: 'X30 piston, rings, pin and clips', descEs: 'Pistón X30, aros, bulón y clips', unitPrice: 148 },
  { sku: 'ENG-CYL-IAME', category: 'Engine', en: 'IAME X30 Cylinder', es: 'Cilindro IAME X30', descEn: 'X30 cylinder, sealed and unmodified', descEs: 'Cilindro X30, sellado y sin modificar', unitPrice: 650 },
  { sku: 'ENG-HEAD-IAME', category: 'Engine', en: 'IAME X30 Cylinder Head', es: 'Culata IAME X30', descEn: 'X30 cylinder head with insert', descEs: 'Culata X30 con inserto', unitPrice: 285 },
  { sku: 'ENG-CRANK', category: 'Engine', en: 'Crankshaft Assembly', es: 'Conjunto de cigüeñal', descEn: 'Balanced crankshaft assembly with bearings', descEs: 'Conjunto de cigüeñal equilibrado con rodamientos', unitPrice: 495 },
  { sku: 'ENG-CONROD', category: 'Engine', en: 'Connecting Rod', es: 'Biela', descEn: 'Connecting rod with big-end bearing', descEs: 'Biela con rodamiento de cabeza', unitPrice: 132 },
  { sku: 'ENG-GASKET', category: 'Engine', en: 'Engine Gasket Set', es: 'Juego de juntas de motor', descEn: 'Complete engine gasket and seal set', descEs: 'Juego completo de juntas y retenes de motor', unitPrice: 38 },
  { sku: 'ENG-CARB-TILL', category: 'Engine', en: 'Tillotson HL-334 Carburetor', es: 'Carburador Tillotson HL-334', descEn: 'Tillotson HL-334 carburetor, race prepared', descEs: 'Carburador Tillotson HL-334, preparado para competición', unitPrice: 340 },
  { sku: 'ENG-CARB-KIT', category: 'Engine', en: 'Carburetor Rebuild Kit', es: 'Kit de reparación de carburador', descEn: 'Diaphragm, gaskets and needle rebuild kit', descEs: 'Kit de reparación de diafragma, juntas y aguja', unitPrice: 46 },
  { sku: 'ENG-SPARK', category: 'Engine', en: 'Spark Plug', es: 'Bujía', descEn: 'Racing spark plug, single', descEs: 'Bujía de competición, individual', unitPrice: 12.5 },
  { sku: 'ENG-CLUTCH', category: 'Engine', en: 'Centrifugal Clutch', es: 'Embrague centrífugo', descEn: 'Centrifugal clutch assembly with drum', descEs: 'Conjunto de embrague centrífugo con campana', unitPrice: 415 },
  { sku: 'ENG-EXH', category: 'Engine', en: 'Exhaust Pipe', es: 'Tubo de escape', descEn: 'Tuned exhaust pipe with springs', descEs: 'Tubo de escape sintonizado con muelles', unitPrice: 265 },
  { sku: 'ENG-MOUNT', category: 'Engine', en: 'Engine Mount', es: 'Soporte de motor', descEn: 'Aluminium engine mount, 30mm rail', descEs: 'Soporte de motor de aluminio, riel de 30mm', unitPrice: 118 },

  // --- Hardware ----------------------------------------------------------
  { sku: 'HW-BOLT-M8', category: 'Hardware', en: 'M8 Bolt Kit', es: 'Kit de tornillos M8', descEn: 'Assorted M8 bolts, 20 pieces', descEs: 'Tornillos M8 surtidos, 20 piezas', unitPrice: 14 },
  { sku: 'HW-BOLT-M6', category: 'Hardware', en: 'M6 Bolt Kit', es: 'Kit de tornillos M6', descEn: 'Assorted M6 bolts, 20 pieces', descEs: 'Tornillos M6 surtidos, 20 piezas', unitPrice: 11 },
  { sku: 'HW-NUT-M8', category: 'Hardware', en: 'M8 Lock Nut 10-Pack', es: 'Tuercas M8 autoblocantes, 10 unidades', descEn: 'M8 nylon-insert lock nuts, ten per pack', descEs: 'Tuercas M8 con inserto de nylon, diez por paquete', unitPrice: 8.5 },
  { sku: 'HW-WASH', category: 'Hardware', en: 'Washer Assortment', es: 'Surtido de arandelas', descEn: 'M6 and M8 washer assortment', descEs: 'Surtido de arandelas M6 y M8', unitPrice: 9.5 },
  { sku: 'HW-ZIP', category: 'Hardware', en: 'Zip Tie Pack', es: 'Paquete de bridas', descEn: 'Nylon zip ties, 100 per pack', descEs: 'Bridas de nylon, 100 por paquete', unitPrice: 7 },
  { sku: 'HW-BRG-KING', category: 'Hardware', en: 'Kingpin Bearing', es: 'Rodamiento de mangueta', descEn: 'Kingpin needle bearing, single', descEs: 'Rodamiento de agujas de mangueta, individual', unitPrice: 22 },
  { sku: 'HW-TIEROD', category: 'Hardware', en: 'Adjustable Tie Rod', es: 'Barra de dirección ajustable', descEn: 'Adjustable steering tie rod, 200mm', descEs: 'Barra de dirección ajustable, 200mm', unitPrice: 44 },
  { sku: 'HW-TIEROD-END', category: 'Hardware', en: 'Tie Rod End', es: 'Terminal de barra de dirección', descEn: 'M8 tie rod end, single', descEs: 'Terminal de barra de dirección M8, individual', unitPrice: 19.5 },
  { sku: 'HW-STEER-WHL', category: 'Hardware', en: 'Steering Wheel', es: 'Volante de dirección', descEn: 'Flat-top racing steering wheel, 320mm', descEs: 'Volante de dirección de competición, 320mm', unitPrice: 135 },
  { sku: 'HW-STEER-COL', category: 'Hardware', en: 'Steering Column', es: 'Columna de dirección', descEn: 'Steering column with bushings', descEs: 'Columna de dirección con casquillos', unitPrice: 168 },
  { sku: 'HW-HUB-F', category: 'Hardware', en: 'Front Wheel Hub', es: 'Buje de rueda delantera', descEn: 'Aluminium front wheel hub, single', descEs: 'Buje de rueda delantera de aluminio, individual', unitPrice: 72 },
  { sku: 'HW-HUB-R', category: 'Hardware', en: 'Rear Wheel Hub', es: 'Buje de rueda trasera', descEn: 'Aluminium rear wheel hub for 50mm axle', descEs: 'Buje de rueda trasera de aluminio para eje de 50mm', unitPrice: 84 },

  // --- Other -------------------------------------------------------------
  { sku: 'OTH-SEAL-TAPE', category: 'Other', en: 'Tire Sealing Tape', es: 'Cinta selladora de neumáticos', descEn: 'Bead sealing tape for tubeless kart tires', descEs: 'Cinta selladora de talón para neumáticos sin cámara', unitPrice: 11 },
  { sku: 'OTH-FUEL-JUG', category: 'Other', en: 'Fuel Jug 5 Gallon', es: 'Bidón de combustible 5 galones', descEn: 'Five-gallon fuel jug with fast-fill spout', descEs: 'Bidón de combustible de cinco galones con boquilla rápida', unitPrice: 34 },
  { sku: 'OTH-FUEL-FLTR', category: 'Other', en: 'Fuel Filter', es: 'Filtro de combustible', descEn: 'In-line fuel filter, single', descEs: 'Filtro de combustible en línea, individual', unitPrice: 9 },
  { sku: 'OTH-AIR-FLTR', category: 'Other', en: 'Air Filter Element', es: 'Elemento de filtro de aire', descEn: 'Replacement air box filter element', descEs: 'Elemento de filtro de aire de repuesto', unitPrice: 26 },
  { sku: 'OTH-RADIATOR', category: 'Other', en: 'Radiator with Hoses', es: 'Radiador con manguitos', descEn: 'Aluminium radiator with hose set and clamps', descEs: 'Radiador de aluminio con juego de manguitos y bridas', unitPrice: 245 },
  { sku: 'OTH-COOL', category: 'Other', en: 'Engine Coolant 1L', es: 'Refrigerante de motor 1L', descEn: 'Racing engine coolant, one litre', descEs: 'Refrigerante de motor de competición, un litro', unitPrice: 15.5 },
  { sku: 'OTH-TIRE-GAUGE', category: 'Other', en: 'Tire Pressure Gauge', es: 'Manómetro de presión de neumáticos', descEn: 'Digital kart tire pressure gauge', descEs: 'Manómetro digital de presión de neumáticos de kart', unitPrice: 48 },
  { sku: 'OTH-STAND', category: 'Other', en: 'Kart Stand', es: 'Caballete para kart', descEn: 'Rolling hydraulic kart stand', descEs: 'Caballete hidráulico rodante para kart', unitPrice: 185 },
  { sku: 'OTH-LABOR', category: 'Other', en: 'Trackside Labor Hour', es: 'Hora de mano de obra en pista', descEn: 'One hour of trackside mechanic labor', descEs: 'Una hora de mano de obra de mecánico en pista', unitPrice: 95 },
];

/**
 * The customers. §7 models both organisations and individuals as plain QuickBooks
 * customers, so the demo set is a realistic mix of team accounts and driver/family accounts
 * — including accented display names, which the review and picker screens have to render.
 */
export interface DemoCustomer {
  displayName: string;
  /** Set for individuals; QuickBooks wants Given/Family names on a person. */
  person?: { given: string; family: string };
  email?: string;
  phone?: string;
}

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { displayName: 'Rolison Performance Group', email: 'billing@rolisonperformance.example', phone: '(559) 555-0111' },
  { displayName: 'Garcia Racing', email: 'accounts@garciaracing.example', phone: '(559) 555-0112' },
  { displayName: 'Miller Motorsports', email: 'ap@millermotorsports.example', phone: '(559) 555-0113' },
  { displayName: 'Chen Racing', email: 'billing@chenracing.example', phone: '(559) 555-0114' },
  { displayName: 'Martínez Karting', email: 'cuentas@martinezkarting.example', phone: '(559) 555-0115' },
  { displayName: 'Ibáñez Racing Team', email: 'cuentas@ibanezracing.example', phone: '(559) 555-0116' },
  { displayName: 'Nitro Kart Team', email: 'billing@nitrokartteam.example', phone: '(559) 555-0117' },
  { displayName: 'Apex Karting Group', email: 'ap@apexkarting.example', phone: '(559) 555-0118' },
  { displayName: 'Velocity Motorsports', email: 'billing@velocitymotorsports.example', phone: '(559) 555-0119' },
  { displayName: 'Dylan Reyes', person: { given: 'Dylan', family: 'Reyes' }, email: 'dylan.reyes@example.com', phone: '(559) 555-0201' },
  { displayName: 'Sophia Whitaker', person: { given: 'Sophia', family: 'Whitaker' }, email: 'sophia.whitaker@example.com', phone: '(559) 555-0202' },
  { displayName: 'Jack Lindstrom', person: { given: 'Jack', family: 'Lindstrom' }, email: 'jack.lindstrom@example.com', phone: '(559) 555-0203' },
  { displayName: 'Camila Sandoval', person: { given: 'Camila', family: 'Sandoval' }, email: 'camila.sandoval@example.com', phone: '(559) 555-0204' },
  { displayName: 'Owen Brennan', person: { given: 'Owen', family: 'Brennan' }, email: 'owen.brennan@example.com', phone: '(559) 555-0205' },
  { displayName: 'The Okafor Family', email: 'okafor.family@example.com', phone: '(559) 555-0206' },
  { displayName: 'The Nakamura Family', email: 'nakamura.family@example.com', phone: '(559) 555-0207' },
];

/**
 * Intuit's stock landscaping demo records, as they exist in a fresh sandbox: the exact
 * (Id, Name) pairs, captured by probing the company before any racing data was created.
 *
 * Why an explicit allow-list rather than `synced_at`-based "everything older than now":
 * `synced_at` is rewritten by every `npm run sync`, so a single sync between seeding and
 * deactivating would make the whole catalog — racing parts included — look "pre-existing"
 * and deactivate all 100+ of them. The allow-list cannot make that mistake: it names 47
 * specific records, none of the racing names appear in it, and the deactivation requires
 * *both* the id and the name to match, so even an id collision is inert.
 */
export const STOCK_CUSTOMERS: { id: string; name: string }[] = [
  { id: '1', name: "Amy's Bird Sanctuary" },
  { id: '2', name: "Bill's Windsurf Shop" },
  { id: '3', name: 'Cool Cars' },
  { id: '4', name: 'Diego Rodriguez' },
  { id: '5', name: 'Dukes Basketball Camp' },
  { id: '6', name: 'Dylan Sollfrank' },
  { id: '7', name: 'Freeman Sporting Goods' },
  // Sub-customer address rows on Freeman Sporting Goods. These are the two rows that
  // pollute the worker customer picker, so they are deactivated like the rest.
  { id: '8', name: '0969 Ocean View Road' },
  { id: '9', name: '55 Twin Lane' },
  { id: '10', name: 'Geeta Kalapatapu' },
  { id: '11', name: 'Gevelber Photography' },
  { id: '12', name: "Jeff's Jalopies" },
  { id: '13', name: 'John Melton' },
  { id: '14', name: 'Kate Whelan' },
  { id: '15', name: "Pye's Cakes" },
  { id: '16', name: 'Kookies by Kathy' },
  { id: '17', name: 'Mark Cho' },
  { id: '18', name: 'Paulsen Medical Supplies' },
  { id: '19', name: 'Rago Travel Agency' },
  { id: '20', name: 'Red Rock Diner' },
  { id: '21', name: 'Rondonuwu Fruit and Vegi' },
  { id: '22', name: 'Shara Barnett' },
  { id: '23', name: 'Barnett Design' },
  { id: '24', name: 'Sonnenschein Family Store' },
  { id: '25', name: 'Sushi by Katsuyuki' },
  { id: '26', name: 'Travis Waldron' },
  { id: '27', name: 'Video Games by Dan' },
  { id: '28', name: 'Wedding Planning by Whitney' },
  { id: '29', name: 'Weiskopf Consulting' },
];

export const STOCK_ITEMS: { id: string; name: string }[] = [
  { id: '1', name: 'Services' },
  { id: '2', name: 'Hours' },
  { id: '3', name: 'Concrete' },
  { id: '4', name: 'Design' },
  { id: '5', name: 'Rock Fountain' },
  { id: '6', name: 'Gardening' },
  { id: '7', name: 'Installation' },
  { id: '8', name: 'Lighting' },
  { id: '9', name: 'Maintenance & Repair' },
  { id: '10', name: 'Pest Control' },
  { id: '11', name: 'Pump' },
  { id: '12', name: 'Refunds & Allowances' },
  { id: '13', name: 'Rocks' },
  { id: '14', name: 'Sod' },
  { id: '15', name: 'Soil' },
  { id: '16', name: 'Sprinkler Heads' },
  { id: '17', name: 'Sprinkler Pipes' },
  { id: '18', name: 'Trimming' },
];
