import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // O vitest põe NODE_ENV=test, e env.ts só afrouxa a exigência de segredos
    // em 'development' — de propósito, para que um deploy com NODE_ENV vazio
    // não suba com as chaves de dev. Nos testes, declaramos dev explicitamente.
    env: {
      NODE_ENV: 'development',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://abstraction:abstraction@localhost:5434/abstraction',
    },
    // Os testes de banco compartilham tabelas; rodar em série evita que um
    // limpe as linhas do outro.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
