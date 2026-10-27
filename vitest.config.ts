/**
 * Configuración de Vitest — Fase A.1
 *
 * Solo lógica pura (environment: node, sin jsdom): el objetivo es testear
 * src/lib sin montar componentes React ni mocks de base de datos.
 *
 * Los thresholds codifican el criterio de aceptación de la fase A:
 * ≥90% de cobertura en el motor fiscal y en metrics-utils. Si una futura
 * edición baja la cobertura, `npm run test:coverage` falla — el criterio
 * queda vigilado por la propia suite, no por memoria.
 */
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/lib/tax/fifo-engine.ts",
        "src/lib/tax/loss-carryforward.ts",
        "src/lib/tax/irpf-calculator.ts",
        "src/lib/metrics-utils.ts",
        "src/lib/import/parsers/**/*.ts",
        // Fase E: registro de proveedores y capa FX (criterio ≥90% del plan)
        "src/lib/price-providers/registry.ts",
        "src/lib/fx-utils.ts",
      ],
      thresholds: {
        "src/lib/tax/**/*.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/lib/metrics-utils.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/lib/price-providers/registry.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "src/lib/fx-utils.ts": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
  resolve: {
    // Mismo alias que tsconfig.json ("@/*" → "./src/*")
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
