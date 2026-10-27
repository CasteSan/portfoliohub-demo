/**
 * Utilidades para cálculo de Matriz de Correlación
 *
 * MODO PROFESOR — Correlación de Pearson:
 *
 * La correlación mide cuánto se mueven juntos dos activos:
 *   +1 = se mueven exactamente igual (suben/bajan juntos)
 *    0 = no hay relación
 *   -1 = se mueven exactamente opuesto (uno sube cuando el otro baja)
 *
 * ¿Por qué usamos retornos diarios en vez de precios?
 * Los precios son "no estacionarios" (suben con el tiempo).
 * Si Apple cotiza a $200 y Santander a $5, los precios brutos no son
 * comparables. Los retornos diarios (variación %) normalizan todo.
 *
 * Equivalente Python: df.pct_change().corr()
 *
 * ¿Por qué intersección de fechas?
 * Madrid y NYSE tienen festivos distintos. Si el 4 de julio NYSE
 * no cotiza pero Madrid sí, ese día no tiene datos para Apple.
 * Solo usamos días donde AMBOS instrumentos tienen precio.
 *
 * Fórmula:
 *         Σ[(xᵢ - x̄)(yᵢ - ȳ)]
 *   r = ─────────────────────────────────
 *       √[Σ(xᵢ - x̄)²] × √[Σ(yᵢ - ȳ)²]
 */

// Mínimo de días comunes para que la correlación sea significativa
const MIN_COMMON_DAYS = 20;

/** Información de un instrumento en la matriz de correlación */
export type CorrelationInstrument = {
  instrumentId: string;
  name: string;
  ticker: string | null;
};

/** Resultado completo de la matriz de correlación */
export type CorrelationResult = {
  instruments: CorrelationInstrument[];
  matrix: number[][];
  dataPoints: number;
  skippedInstruments: string[];
};

/**
 * Calcula la correlación de Pearson entre dos vectores de números.
 * Ambos vectores deben tener la misma longitud.
 *
 * @returns Coeficiente de correlación entre -1 y +1, o 0 si hay varianza cero
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;

  // Medias
  const xMean = x.reduce((s, v) => s + v, 0) / n;
  const yMean = y.reduce((s, v) => s + v, 0) / n;

  // Numerador: Σ[(xᵢ - x̄)(yᵢ - ȳ)]
  let numerator = 0;
  let xVariance = 0;
  let yVariance = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - xMean;
    const dy = y[i] - yMean;
    numerator += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }

  // Denominador: √(Σ(xᵢ-x̄)²) × √(Σ(yᵢ-ȳ)²)
  const denominator = Math.sqrt(xVariance) * Math.sqrt(yVariance);

  // Guard: varianza cero (precio constante) → correlación indefinida, devolvemos 0
  if (denominator === 0) return 0;

  const r = numerator / denominator;

  // Clamp por posibles errores de punto flotante
  return Math.max(-1, Math.min(1, r));
}

/**
 * Calcula la matriz de correlación completa entre instrumentos.
 *
 * @param priceHistories - Map de instrumentId → Map de fecha (YYYY-MM-DD) → precio
 * @param instruments - Metadata de cada instrumento (id, nombre, ticker)
 * @returns CorrelationResult o null si no hay suficientes datos
 */
export function calculateCorrelationMatrix(
  priceHistories: Map<string, Map<string, number>>,
  instruments: CorrelationInstrument[]
): CorrelationResult | null {
  // Filtrar instrumentos que tienen datos de precio
  const withData: CorrelationInstrument[] = [];
  const skippedInstruments: string[] = [];

  for (const inst of instruments) {
    const prices = priceHistories.get(inst.instrumentId);
    if (prices && prices.size >= 2) {
      withData.push(inst);
    } else {
      skippedInstruments.push(inst.name);
    }
  }

  // Necesitamos al menos 2 instrumentos con datos
  if (withData.length < 2) return null;

  // Calcular retornos diarios para cada instrumento
  // retorno = (precio_hoy / precio_ayer) - 1
  const dailyReturns = new Map<string, Map<string, number>>();

  for (const inst of withData) {
    const prices = priceHistories.get(inst.instrumentId)!;
    // Ordenar fechas cronológicamente
    const sortedDates = [...prices.keys()].sort();
    const returns = new Map<string, number>();

    for (let i = 1; i < sortedDates.length; i++) {
      const prevPrice = prices.get(sortedDates[i - 1])!;
      const currPrice = prices.get(sortedDates[i])!;
      if (prevPrice > 0) {
        returns.set(sortedDates[i], (currPrice / prevPrice) - 1);
      }
    }

    dailyReturns.set(inst.instrumentId, returns);
  }

  // Calcular correlación POR PARES — cada par usa sus propias fechas comunes.
  // No usamos intersección global porque con 15+ instrumentos de mercados
  // diferentes (Madrid, NYSE, fondos Morningstar...) la intersección global
  // puede quedar vacía. Es como en pandas: df[['A','B']].dropna().corr()
  // calcula solo con las filas donde ambos tienen dato.
  const n = withData.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  let maxCommonDays = 0;

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0;
    const returnsI = dailyReturns.get(withData[i].instrumentId)!;

    for (let j = i + 1; j < n; j++) {
      const returnsJ = dailyReturns.get(withData[j].instrumentId)!;

      // Fechas comunes entre este par
      const commonDates: string[] = [];
      for (const date of returnsI.keys()) {
        if (returnsJ.has(date)) commonDates.push(date);
      }

      if (commonDates.length < MIN_COMMON_DAYS) {
        // Insuficientes datos para este par → NaN representado como 0
        matrix[i][j] = 0;
        matrix[j][i] = 0;
        continue;
      }

      if (commonDates.length > maxCommonDays) maxCommonDays = commonDates.length;

      // Construir vectores alineados
      const vecI = commonDates.map((d) => returnsI.get(d) || 0);
      const vecJ = commonDates.map((d) => returnsJ.get(d) || 0);

      const corr = pearsonCorrelation(vecI, vecJ);
      const rounded = Math.round(corr * 100) / 100;
      matrix[i][j] = rounded;
      matrix[j][i] = rounded;
    }
  }

  // Si ningún par tuvo suficientes datos comunes, retornar null
  if (maxCommonDays < MIN_COMMON_DAYS) return null;

  return {
    instruments: withData,
    matrix,
    dataPoints: maxCommonDays,
    skippedInstruments,
  };
}

/**
 * Abrevia un nombre largo para labels del heatmap.
 * Ej: "iShares Core MSCI World UCITS ETF" → "iShares Co…"
 */
export function abbreviateName(name: string, maxLen: number = 10): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + "\u2026"; // Unicode ellipsis
}
