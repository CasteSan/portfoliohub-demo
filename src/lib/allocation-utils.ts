/**
 * Utilidades de Distribución de Activos (Asset Allocation)
 *
 * Funciones puras que calculan la distribución de una cartera
 * por tipo de instrumento, clase de activo, divisa, país e instrumento individual.
 *
 * MODO PROFESOR — Funciones puras:
 * Una función pura NO tiene efectos secundarios (no llama a APIs, no modifica estado).
 * Recibe datos de entrada → devuelve datos de salida. Siempre el mismo resultado
 * para los mismos inputs. Esto las hace fáciles de testear y de reusar.
 *
 * Es como una función de pandas: df.groupby("type").sum()
 * — recibe datos, devuelve agrupación.
 */

// ============================================
// TIPOS
// ============================================

/**
 * Datos mínimos de una posición para calcular allocation.
 * El Server Component extrae estos campos de las posiciones de Prisma
 * y los pasa como props serializables al Client Component.
 */
export type PositionForAllocation = {
  instrumentName: string;
  instrumentTicker: string | null;
  instrumentTypeName: string; // "Acción", "ETF", "Fondo de inversión"...
  instrumentTypeId: string;   // "STOCK", "ETF", "FUND", "BOND"...
  instrumentCurrency: string; // "EUR", "USD", "GBP"...
  instrumentIsin: string | null; // "ES0113900J37", "LU0996182563"...
  value: number; // Valor de mercado: shares × currentPrice
  /**
   * Distribución geográfica real del fondo/ETF.
   * Viene de FundDetails.countryAllocation.
   * Formato: { "US": 60, "EU": 25, "JP": 8 } — porcentajes (0-100).
   * Si es null, se usa el fallback basado en ISIN/ticker.
   */
  countryAllocation?: Record<string, number> | null;
  /**
   * Categoría Morningstar del fondo (ej: "RV Global Grande", "RF EUR Diversificada").
   * Se usa para inferir la clase de activo real de fondos/ETFs.
   * Sin esto, todos los fondos se clasifican como "Renta variable" por defecto.
   */
  fundCategory?: string | null;
};

/** Una porción del gráfico donut */
export type AllocationSlice = {
  name: string;
  value: number; // Valor en moneda base
  percent: number; // Porcentaje del total (0-100)
};

/** Vista activa del selector */
export type AllocationView = "type" | "assetClass" | "currency" | "country" | "instrument";

/** Resultado completo con las 5 distribuciones */
export type AllocationData = {
  byType: AllocationSlice[];
  byAssetClass: AllocationSlice[];
  byCurrency: AllocationSlice[];
  byCountry: AllocationSlice[];
  byInstrument: AllocationSlice[];
  totalValue: number;
};

// ============================================
// CONSTANTES
// ============================================

/** Máximo de slices antes de agrupar en "Otros" */
const MAX_INSTRUMENT_SLICES = 7;

/**
 * Mapeo de tipo de instrumento → clase de activo.
 *
 * MODO PROFESOR — Renta fija vs variable:
 * - Renta variable: acciones, ETFs (la mayoría son de renta variable),
 *   REITs (inmobiliario cotizado), cripto
 * - Renta fija: bonos, efectivo/monetarios
 * - Alternativo: materias primas
 * - Fondos de inversión: pueden ser de cualquier tipo. Los clasificamos
 *   como "variable" por defecto porque la mayoría de fondos minoristas
 *   europeos son de renta variable o mixtos. Sin metadata adicional
 *   (como la categoría Morningstar) no podemos distinguir automáticamente.
 */
const ASSET_CLASS_MAP: Record<string, string> = {
  STOCK: "Renta variable",
  ETF: "Renta variable",
  FUND: "Renta variable",
  REIT: "Renta variable",
  CRYPTO: "Renta variable",
  BOND: "Renta fija",
  CASH: "Renta fija",
  COMMODITY: "Alternativo",
};

/**
 * Mapeo de código ISO de país (2 letras) → nombre en español.
 *
 * MODO PROFESOR — ISIN y códigos de país:
 * Los primeros 2 caracteres de un ISIN son SIEMPRE el código del país
 * donde fue emitido el instrumento (estándar ISO 3166-1 alpha-2).
 * Ej: ES0113900J37 → España, LU0996182563 → Luxemburgo, US0378331005 → EEUU.
 * Nota: muchos fondos europeos están domiciliados en Luxemburgo o Irlanda
 * por ventajas fiscales, aunque inviertan globalmente.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  ES: "España",
  US: "Estados Unidos",
  LU: "Luxemburgo",
  IE: "Irlanda",
  DE: "Alemania",
  FR: "Francia",
  GB: "Reino Unido",
  NL: "Países Bajos",
  IT: "Italia",
  CH: "Suiza",
  JP: "Japón",
  CA: "Canadá",
  AU: "Australia",
  SE: "Suecia",
  NO: "Noruega",
  DK: "Dinamarca",
  FI: "Finlandia",
  BE: "Bélgica",
  AT: "Austria",
  PT: "Portugal",
  HK: "Hong Kong",
  SG: "Singapur",
  KR: "Corea del Sur",
  TW: "Taiwán",
  BR: "Brasil",
  MX: "México",
  CN: "China",
  IN: "India",
  ZA: "Sudáfrica",
  // Sureste asiático y emergentes
  ID: "Indonesia",
  TH: "Tailandia",
  MY: "Malasia",
  PH: "Filipinas",
  VN: "Vietnam",
  // Latinoamérica
  CL: "Chile",
  CO: "Colombia",
  PE: "Perú",
  AR: "Argentina",
  // Oriente Medio
  IL: "Israel",
  SA: "Arabia Saudí",
  AE: "Emiratos Árabes",
  // Oceanía
  NZ: "Nueva Zelanda",
  // Código especial que aparece en datos de fondos globales
  EU: "Eurozona",
};

/**
 * Mapeo de sufijo de ticker → código de país.
 * Fallback cuando no hay ISIN disponible.
 */
const TICKER_SUFFIX_COUNTRY: Record<string, string> = {
  ".MC": "ES",
  ".MA": "ES",
  ".DE": "DE",
  ".F": "DE",
  ".L": "GB",
  ".AS": "NL",
  ".PA": "FR",
  ".MI": "IT",
  ".SW": "CH",
  ".TO": "CA",
  ".AX": "AU",
  ".T": "JP",
  ".HK": "HK",
  ".SI": "SG",
  ".KS": "KR",
  ".TW": "TW",
};

// ============================================
// FUNCIONES
// ============================================

/**
 * Calcula las 5 distribuciones a partir de un array de posiciones.
 *
 * MODO PROFESOR — Patrón de cálculo:
 * 1. Agrupar por clave (tipo, clase, divisa, país, nombre)
 * 2. Sumar valores dentro de cada grupo
 * 3. Ordenar de mayor a menor
 * 4. Calcular porcentajes
 * 5. Opcionalmente colapsar los más pequeños en "Otros"
 *
 * En Python sería:
 *   df.groupby("type")["value"].sum().sort_values(ascending=False)
 */
export function calculateAllocation(
  positions: PositionForAllocation[]
): AllocationData {
  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);

  if (totalValue === 0) {
    return {
      byType: [], byAssetClass: [], byCurrency: [],
      byCountry: [], byInstrument: [], totalValue: 0,
    };
  }

  const byType = groupAndSort(
    positions,
    (p) => p.instrumentTypeName,
    totalValue
  );

  const byAssetClass = groupAndSort(
    positions,
    (p) => getAssetClass(p.instrumentTypeId, p.fundCategory, p.instrumentName),
    totalValue
  );

  const byCurrency = groupAndSort(
    positions,
    (p) => p.instrumentCurrency,
    totalValue
  );

  const byCountry = groupByCountry(positions, totalValue);

  const byInstrument = groupAndSort(
    positions,
    (p) => p.instrumentTicker
      ? `${p.instrumentName} (${p.instrumentTicker})`
      : p.instrumentName,
    totalValue,
    MAX_INSTRUMENT_SLICES
  );

  return { byType, byAssetClass, byCurrency, byCountry, byInstrument, totalValue };
}

/**
 * Determina la clase de activo a partir del typeId, la categoría Morningstar
 * del fondo, y opcionalmente el nombre del instrumento como último fallback.
 *
 * MODO PROFESOR — Cadena de clasificación (3 niveles):
 * 1. typeId: para acciones, bonos, cash, commodities → clasificación directa
 * 2. fundCategory (de BD): si la categoría Morningstar está poblada
 * 3. instrumentName: si no hay categoría, inferimos de palabras clave del nombre
 *
 * Ejemplo con categoría: "RF EUR Diversificada" → Renta fija
 * Ejemplo sin categoría: "Neuberger Short Dur Bond" → Renta fija (por "Bond" y "Short")
 */
function getAssetClass(typeId: string, fundCategory?: string | null, instrumentName?: string): string {
  // Para acciones, bonos y commodities, el typeId es suficiente
  if (typeId === "STOCK") return "Renta variable";
  if (typeId === "BOND") return "Renta fija";
  if (typeId === "CASH") return "Efectivo";
  if (typeId === "COMMODITY") return "Alternativo";

  // Para fondos y ETFs: usar categoría Morningstar si disponible
  if (fundCategory && (typeId === "FUND" || typeId === "ETF" || typeId === "REIT")) {
    return classifyByCategory(fundCategory);
  }

  // Fallback: inferir de nombre del instrumento (cuando no hay categoría)
  if (instrumentName && (typeId === "FUND" || typeId === "ETF" || typeId === "REIT")) {
    return classifyByName(instrumentName);
  }

  // Fallback por typeId
  return ASSET_CLASS_MAP[typeId] || "Otros";
}

/** Clasifica por categoría Morningstar (nivel 2) */
function classifyByCategory(fundCategory: string): string {
  const cat = fundCategory.toLowerCase();

  // Renta fija / bonos
  if (cat.includes("rf ") || cat.includes("renta fija") || cat.includes("bond")
      || cat.includes("fixed income") || cat.includes("obligacion")
      || cat.includes("deuda") || cat.includes("gobierno")
      || cat.includes("corporativ")) {
    return "Renta fija";
  }

  // Monetario / efectivo
  if (cat.includes("monetario") || cat.includes("money market")
      || cat.includes("ultra short") || cat.includes("liquidez")) {
    return "Efectivo";
  }

  // Mixto / allocation
  if (cat.includes("mixto") || cat.includes("mixed") || cat.includes("allocation")
      || cat.includes("balanced") || cat.includes("multi-asset")
      || cat.includes("flexible")) {
    return "Mixto";
  }

  // Alternativo
  if (cat.includes("alternativ") || cat.includes("commodit")
      || cat.includes("materia") || cat.includes("inmobiliar")
      || cat.includes("real estate") || cat.includes("cripto")
      || cat.includes("apalancado")) {
    return "Alternativo";
  }

  // Si tiene categoría pero no matchea, sigue como RV (mayoría de fondos)
  return "Renta variable";
}

/**
 * Fallback: clasifica por palabras clave en el nombre del instrumento (nivel 3).
 *
 * MODO PROFESOR — ¿Por qué un fallback por nombre?
 * Muchos fondos europeos (especialmente los que se importan por primera vez)
 * no tienen categoría Morningstar en la BD. Pero su nombre casi siempre
 * contiene pistas: "Bond", "Credit", "Gold", "Trésorerie", etc.
 * Este fallback evita que TODO se clasifique como "Renta variable".
 */
function classifyByName(name: string): string {
  const n = name.toLowerCase();

  // Renta fija: palabras clave de bonos
  if (n.includes("bond") || n.includes("bd ") || n.includes("credit")
      || n.includes("float") || n.includes("dur ")
      || n.includes("treasury") || n.includes("trs ")
      || n.includes("renta fija") || n.includes("obligacion")) {
    return "Renta fija";
  }

  // Monetario / efectivo
  if (n.includes("trésorerie") || n.includes("tresorerie")
      || n.includes("money market") || n.includes("monetar")
      || n.includes("liquidez") || n.includes("sécurité")) {
    return "Efectivo";
  }

  // Alternativo
  if (n.includes("gold") || n.includes("silver") || n.includes("bitcoin")
      || n.includes("crypto") || n.includes("leverage") || n.includes("absolute")
      || n.includes("absrt") || n.includes("commodity") || n.includes("materia")) {
    return "Alternativo";
  }

  // Default: renta variable (mayoría de fondos)
  return "Renta variable";
}

/**
 * Determina el país a partir del ISIN (primeros 2 caracteres)
 * o del sufijo del ticker como fallback.
 *
 * MODO PROFESOR — Cadena de fallbacks:
 * 1. Si hay ISIN → usar las 2 primeras letras (estándar ISO)
 * 2. Si no hay ISIN pero hay ticker → buscar sufijo (.MC, .DE, .L...)
 * 3. Si el ticker no tiene sufijo → asumir Estados Unidos (convención de mercado)
 * 4. Si no hay nada → "Desconocido"
 */
function getCountryName(isin: string | null, ticker: string | null): string {
  // 1. Intentar ISIN (más fiable)
  if (isin && isin.length >= 2) {
    const code = isin.substring(0, 2).toUpperCase();
    return COUNTRY_NAMES[code] || code;
  }

  // 2. Intentar sufijo del ticker
  if (ticker) {
    for (const [suffix, code] of Object.entries(TICKER_SUFFIX_COUNTRY)) {
      if (ticker.endsWith(suffix)) {
        return COUNTRY_NAMES[code] || code;
      }
    }
    // Sin sufijo → probablemente US
    if (!ticker.includes(".")) {
      return "Estados Unidos";
    }
  }

  return "Desconocido";
}

/**
 * Agrupa posiciones por país con "look-through" en fondos/ETFs.
 *
 * MODO PROFESOR — Look-through en fondos:
 * Para una acción individual (ej: Apple), todo su valor va a un solo país (EEUU).
 * Pero para un fondo (ej: Vanguard MSCI World), el valor se REPARTE entre
 * los países donde realmente invierte, usando countryAllocation.
 *
 * Ejemplo: Si tienes 10.000€ en un fondo con countryAllocation = {"US": 60, "JP": 10}:
 *   - 6.000€ van a "Estados Unidos"
 *   - 1.000€ van a "Japón"
 *   - 3.000€ restantes (100 - 60 - 10 = 30%) van a "Otros países"
 *
 * Esto es equivalente a hacer un join + explode en pandas:
 *   df.merge(allocations).assign(value=lambda x: x.value * x.weight / 100)
 */
function groupByCountry(
  positions: PositionForAllocation[],
  totalValue: number
): AllocationSlice[] {
  const grouped: Record<string, number> = {};

  for (const pos of positions) {
    if (pos.countryAllocation && Object.keys(pos.countryAllocation).length > 0) {
      // Look-through: distribuir valor entre países del fondo
      let allocatedPercent = 0;
      for (const [code, percent] of Object.entries(pos.countryAllocation)) {
        if (typeof percent !== "number" || percent <= 0) continue;
        const countryName = COUNTRY_NAMES[code] || code;
        const allocatedValue = pos.value * (percent / 100);
        grouped[countryName] = (grouped[countryName] || 0) + allocatedValue;
        allocatedPercent += percent;
      }
      // Si la suma de porcentajes < 100, el resto va a "Otros países"
      if (allocatedPercent < 100) {
        const restValue = pos.value * ((100 - allocatedPercent) / 100);
        grouped["Otros países"] = (grouped["Otros países"] || 0) + restValue;
      }
    } else {
      // Fallback: usar ISIN o ticker para determinar un solo país
      const country = getCountryName(pos.instrumentIsin, pos.instrumentTicker);
      grouped[country] = (grouped[country] || 0) + pos.value;
    }
  }

  // Convertir a slices, ordenar desc, calcular porcentajes
  const slices: AllocationSlice[] = Object.entries(grouped)
    .map(([name, value]) => ({
      name,
      value: Math.round(value * 100) / 100,
      percent: Math.round((value / totalValue) * 10000) / 100,
    }))
    .sort((a, b) => b.value - a.value);

  return slices;
}

/**
 * Agrupa posiciones por una clave, ordena por valor desc, y opcionalmente
 * colapsa los más pequeños en "Otros".
 *
 * MODO PROFESOR — Record como acumulador:
 * En Python usarías defaultdict(float). En TypeScript usamos Record<string, number>.
 * Es un diccionario donde la clave es string y el valor es number.
 * Con `grouped[key] = (grouped[key] || 0) + value` acumulamos.
 */
function groupAndSort(
  positions: PositionForAllocation[],
  keyFn: (p: PositionForAllocation) => string,
  totalValue: number,
  maxSlices?: number
): AllocationSlice[] {
  // 1. Agrupar: acumular valor por clave
  const grouped: Record<string, number> = {};
  for (const pos of positions) {
    const key = keyFn(pos);
    grouped[key] = (grouped[key] || 0) + pos.value;
  }

  // 2. Convertir a array y ordenar por valor descendente
  let slices: AllocationSlice[] = Object.entries(grouped)
    .map(([name, value]) => ({
      name,
      value: Math.round(value * 100) / 100,
      percent: Math.round((value / totalValue) * 10000) / 100,
    }))
    .sort((a, b) => b.value - a.value);

  // 3. Si hay maxSlices, agrupar los pequeños en "Otros"
  if (maxSlices && slices.length > maxSlices) {
    const top = slices.slice(0, maxSlices - 1);
    const rest = slices.slice(maxSlices - 1);
    const othersValue = rest.reduce((sum, s) => sum + s.value, 0);
    const othersPercent = rest.reduce((sum, s) => sum + s.percent, 0);
    top.push({
      name: `Otros (${rest.length})`,
      value: Math.round(othersValue * 100) / 100,
      percent: Math.round(othersPercent * 100) / 100,
    });
    slices = top;
  }

  return slices;
}
