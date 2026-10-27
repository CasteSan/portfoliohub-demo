/**
 * Parsers del proveedor BCE — Fase E.2, con respuestas REALES guardadas en
 * la sonda E.0.5 (src/lib/__fixtures__/):
 * - ecb-daily.xml: XML diario del 2026-10-07 (29 divisas)
 * - ecb-sdmx-dataonly.csv: USD+CAD+GBP desde 2026-09-01 con detail=dataonly
 * - ecb-sdmx-full-sample.csv: 3 filas del CSV COMPLETO (32 columnas, campos
 *   entrecomillados con comas dentro)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEcbDailyXml, parseEcbSdmxCsv, ecbHistoryUrl } from "./ecb-provider";

const fixture = (name: string) => readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");

describe("parseEcbDailyXml", () => {
  const rates = parseEcbDailyXml(fixture("ecb-daily.xml"));

  it("lee las 29 divisas con la fecha del cubo (2026-10-07)", () => {
    expect(rates).toHaveLength(29);
    expect(new Set(rates.map((r) => r.date))).toEqual(new Set(["2026-10-07"]));
  });

  it("USD 1,1177 y GBP 0,84645 (valores del XML)", () => {
    expect(rates.find((r) => r.quote === "USD")?.rate).toBe(1.1177);
    expect(rates.find((r) => r.quote === "GBP")?.rate).toBe(0.84645);
  });

  it("XML sin fecha o vacío → []", () => {
    expect(parseEcbDailyXml("<Cube><Cube currency='USD' rate='1.1'/></Cube>")).toEqual([]);
    expect(parseEcbDailyXml("")).toEqual([]);
  });
});

describe("parseEcbSdmxCsv", () => {
  it("dataonly: 27 días por divisa, del 01-sep al 07-oct", () => {
    const rates = parseEcbSdmxCsv(fixture("ecb-sdmx-dataonly.csv"));
    expect(rates).toHaveLength(81);
    const usd = rates.filter((r) => r.quote === "USD");
    expect(usd).toHaveLength(27);
    expect(usd[0]).toEqual({ date: "2026-09-01", quote: "USD", rate: 1.159 });
    expect(usd.at(-1)).toEqual({ date: "2026-10-07", quote: "USD", rate: 1.1177 });
    expect(rates.filter((r) => r.quote === "CAD").at(-1)?.rate).toBe(1.5931);
  });

  it("CSV completo con campos entrecomillados: localiza columnas por nombre", () => {
    const rates = parseEcbSdmxCsv(fixture("ecb-sdmx-full-sample.csv"));
    expect(rates).toEqual([
      { date: "2021-01-04", quote: "CAD", rate: 1.5621 },
      { date: "2021-01-05", quote: "CAD", rate: 1.5651 },
      { date: "2021-01-06", quote: "CAD", rate: 1.564 },
    ]);
  });

  it("descarta observaciones vacías, NaN o con fecha mal formada; cabecera sin columnas → []", () => {
    const csv = [
      "KEY,CURRENCY,TIME_PERIOD,OBS_VALUE",
      "k,USD,2026-10-05,",
      "k,USD,2026-10-06,NaN",
      "k,USD,06/10/2026,1.1",
      "k,USD,2026-10-07,1.1177",
    ].join("\n");
    expect(parseEcbSdmxCsv(csv)).toEqual([{ date: "2026-10-07", quote: "USD", rate: 1.1177 }]);
    expect(parseEcbSdmxCsv("A,B,C\n1,2,3")).toEqual([]);
    expect(parseEcbSdmxCsv("")).toEqual([]);
  });
});

describe("ecbHistoryUrl", () => {
  it("clave SDMX con las divisas unidas por + y formato dataonly", () => {
    expect(ecbHistoryUrl(["USD", "CAD"], "2021-01-01")).toBe(
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD+CAD.EUR.SP00.A?startPeriod=2021-01-01&format=csvdata&detail=dataonly"
    );
    expect(ecbHistoryUrl(["GBP"], "2026-01-01", "2026-02-01")).toContain("endPeriod=2026-02-01");
  });
});
