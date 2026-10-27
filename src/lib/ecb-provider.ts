/**
 * Proveedor de tipos de cambio del BCE — Fase E.2
 *
 * Dos fuentes oficiales, gratuitas y sin clave (verificadas en la sonda E.0.5):
 * - XML diario: los ~30 tipos del último día publicado (~16:00 CET)
 *   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 * - SDMX REST: histórico por divisa desde la fecha que se pida
 *   https://data-api.ecb.europa.eu/service/data/EXR/D.USD+CAD.EUR.SP00.A
 *   `format=csvdata&detail=dataonly` → 8 columnas sin comillas (el CSV
 *   completo trae 32 columnas con comas DENTRO de campos entrecomillados)
 *
 * Convención: `rate` = unidades de la divisa por 1 EUR (como la tabla fx_rates).
 * Parsers PUROS (testeados con las respuestas reales guardadas en E.0);
 * los fetch usan fetchWithRetry y devuelven null ante fallo, nunca lanzan.
 */

import { fetchWithRetry } from "@/lib/price-providers/fetch-retry";

export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_SDMX_BASE = "https://data-api.ecb.europa.eu/service/data/EXR";

/** Un tipo del BCE: divisa por 1 EUR en `date` (yyyy-mm-dd) */
export type EcbRate = { date: string; quote: string; rate: number };

/**
 * XML diario → tipos de su fecha. Sin dependencias: el formato es estable
 * desde hace dos décadas (`<Cube time='…'>` con `<Cube currency='…' rate='…'/>`).
 */
export function parseEcbDailyXml(xml: string): EcbRate[] {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  if (!date) return [];
  const rates: EcbRate[] = [];
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates.push({ date, quote: m[1], rate });
  }
  return rates;
}

/** Divide una línea CSV respetando comillas (por si llega el formato completo) */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * CSV SDMX (`csvdata`, con o sin `detail=dataonly`) → tipos. Localiza las
 * columnas por nombre (CURRENCY, TIME_PERIOD, OBS_VALUE), no por posición,
 * y descarta observaciones vacías o no numéricas.
 */
export function parseEcbSdmxCsv(csv: string): EcbRate[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const iCur = header.indexOf("CURRENCY");
  const iDate = header.indexOf("TIME_PERIOD");
  const iVal = header.indexOf("OBS_VALUE");
  if (iCur < 0 || iDate < 0 || iVal < 0) return [];

  const rates: EcbRate[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const rate = Number(cols[iVal]);
    const date = cols[iDate];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(rate) || rate <= 0) continue;
    rates.push({ date, quote: cols[iCur], rate });
  }
  return rates;
}

/** URL del histórico SDMX de varias divisas frente al EUR */
export function ecbHistoryUrl(currencies: string[], since: string, until?: string): string {
  const key = `D.${currencies.join("+")}.EUR.SP00.A`;
  const params = new URLSearchParams({ startPeriod: since, format: "csvdata", detail: "dataonly" });
  if (until) params.set("endPeriod", until);
  return `${ECB_SDMX_BASE}/${key}?${params.toString()}`;
}

/** Tipos del último día publicado (XML diario), o null si falla */
export async function fetchEcbDaily(): Promise<EcbRate[] | null> {
  try {
    const response = await fetchWithRetry(ECB_DAILY_URL);
    if (!response.ok) {
      console.warn(`BCE diario: HTTP ${response.status}`);
      return null;
    }
    const rates = parseEcbDailyXml(await response.text());
    return rates.length > 0 ? rates : null;
  } catch (error) {
    console.error("BCE diario: error", error);
    return null;
  }
}

/** Histórico SDMX de las divisas dadas desde `since` (yyyy-mm-dd), o null */
export async function fetchEcbHistory(
  currencies: string[],
  since: string,
  until?: string
): Promise<EcbRate[] | null> {
  if (currencies.length === 0) return [];
  try {
    const response = await fetchWithRetry(ecbHistoryUrl(currencies, since, until));
    if (!response.ok) {
      console.warn(`BCE histórico: HTTP ${response.status}`);
      return null;
    }
    return parseEcbSdmxCsv(await response.text());
  } catch (error) {
    console.error("BCE histórico: error", error);
    return null;
  }
}
