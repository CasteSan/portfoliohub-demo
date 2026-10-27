/**
 * Transacciones en la divisa base para el módulo fiscal — Fase E.6 (PURA)
 *
 * MODO PROFESOR — La regla de la AEAT
 * Para valores en divisa extranjera, cada operación se valora en euros al
 * tipo de cambio de SU fecha: la compra al tipo del día de compra y la venta
 * al del día de venta. La plusvalía en euros incluye por tanto el efecto
 * divisa — comprar a 1,08 $/€ y vender a 1,146 $/€ con el mismo precio en
 * dólares es una PÉRDIDA en euros. No es una aproximación: es el cálculo
 * correcto. Por eso la conversión va ANTES del FIFO y el motor FIFO (y la
 * regla de los 2 meses, y el carryforward) no se tocan: reciben euros.
 *
 * - Convierte: pricePerShare, fees, grossAmount, withholdingTax y el coste
 *   fiscal arrastrado de los traspasos. Deja intactos shares y fechas.
 * - Traspasos: si el TRANSFER_IN guarda `fiscalCostDraggedBase` (desde E.2,
 *   el avgCostBase del origen), se usa tal cual — el coste fiscal se arrastra,
 *   no se revalúa. Si no, se convierte al tipo de la fecha del traspaso (exacto
 *   para fondos en la divisa base: todos los traspasos existentes lo son).
 * - Sin tipo → el importe queda en su divisa y se declara (`coverage`).
 */

import { convert, coverageReport, type FxCoverage, type FxTable } from "@/lib/fx-utils";

/** Campos que la conversión lee; el resto de la transacción pasa intacto */
export type FxTaxTransaction = {
  tradeDate: Date;
  /** Divisa del instrumento (los importes van en ella); sin ella, la base */
  currency?: string;
  pricePerShare: number;
  fees: number;
  grossAmount?: number | null;
  withholdingTax?: number | null;
  taxMetadata?: ({ fiscalCostDragged?: number; fiscalCostDraggedBase?: number } & Record<string, unknown>) | null;
  /** Para la cobertura */
  label?: string;
};

export function toBaseCurrencyTransactions<T extends FxTaxTransaction>(
  transactions: T[],
  fx: { base: string; table: FxTable }
): { transactions: T[]; coverage: FxCoverage } {
  const items: Array<{ label: string; currency: string; converted: boolean }> = [];

  const converted = transactions.map((tx) => {
    const from = tx.currency ?? fx.base;
    const date = tx.tradeDate.toISOString().slice(0, 10);
    let ok = true;
    const conv = (amount: number) => {
      const r = convert(amount, from, fx.base, date, fx.table);
      if (!r.converted) ok = false;
      return r.value;
    };

    const out: T = {
      ...tx,
      pricePerShare: conv(tx.pricePerShare),
      fees: conv(tx.fees),
    };
    if (tx.grossAmount !== null && tx.grossAmount !== undefined) out.grossAmount = conv(tx.grossAmount);
    if (tx.withholdingTax !== null && tx.withholdingTax !== undefined) out.withholdingTax = conv(tx.withholdingTax);

    const meta = tx.taxMetadata;
    if (meta && typeof meta.fiscalCostDragged === "number") {
      out.taxMetadata = {
        ...meta,
        fiscalCostDragged:
          typeof meta.fiscalCostDraggedBase === "number" ? meta.fiscalCostDraggedBase : conv(meta.fiscalCostDragged),
      };
    }

    items.push({ label: tx.label ?? from, currency: from, converted: ok });
    return out;
  });

  return { transactions: converted, coverage: coverageReport(items) };
}

/**
 * Divisa del módulo fiscal: el IRPF se liquida en euros, así que las
 * plusvalías se calculan SIEMPRE en EUR (aunque una cartera tuviera otra
 * divisa base; hoy todas son EUR).
 */
export const FISCAL_CURRENCY = "EUR";
