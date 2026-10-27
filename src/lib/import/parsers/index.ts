/**
 * Registry de parsers de brokers
 *
 * Punto de entrada para obtener el parser adecuado según el formato seleccionado.
 * Cada parser convierte datos crudos (arrays de arrays) a ParsedRow[].
 */

export { parseGenericCSV, parseLocalNumber, parseLocalDate, detectDecimalSeparator } from "./generic";
export { parseMyInvestor } from "./myinvestor";
export { parseInteractiveBrokers } from "./interactive-brokers";

// Tipos re-exportados para conveniencia
export type { BrokerFormat } from "../types";
