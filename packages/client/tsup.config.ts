import { defineConfig } from 'tsup';

// Saída dupla: o consumidor imediato (NestJS) é CommonJS com moduleResolution
// nodenext, então um pacote só-ESM só seria importável por dynamic import.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
});
