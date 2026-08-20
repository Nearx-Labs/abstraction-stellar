import { pino } from 'pino';
import { env, isDev } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // bigint (stroops) atravessa todo o domínio; sem isso o pino quebra ao
  // serializar o log.
  serializers: {},
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev
    ? { transport: { target: 'pino/file', options: { destination: 1 } } }
    : {}),
});

// JSON.stringify não sabe serializar bigint. Como praticamente todo valor de
// domínio aqui é stroop, registramos o hook uma vez em vez de espalhar
// .toString() por todo lado.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function toJSON(this: bigint) {
  return this.toString();
};
