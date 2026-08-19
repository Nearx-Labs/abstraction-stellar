// Instrumentação: registra quem dispara uma cerimônia WebAuthn.
//
// Rastrear isso pelo comportamento é chute — vários caminhos do kit podem cair
// na passkey, e o erro que chega (`NotAllowedError`) não diz de onde veio.
// Aqui o próprio navegador denuncia: cada `credentials.get/create` sai no
// console com a pilha de chamada.
//
// Só roda em desenvolvimento, e não altera o comportamento — apenas observa.
let installed = false;

export function traceWebAuthn(): void {
  if (installed || !import.meta.env.DEV) return;
  if (typeof navigator === 'undefined' || !navigator.credentials) return;
  installed = true;

  const original = {
    get: navigator.credentials.get.bind(navigator.credentials),
    create: navigator.credentials.create.bind(navigator.credentials),
  };

  const wrap =
    <T extends 'get' | 'create'>(kind: T) =>
    (options?: CredentialRequestOptions & CredentialCreationOptions) => {
      const stack = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 9)
        .map((line) => line.trim())
        .join('\n  ');

      // eslint-disable-next-line no-console
      console.warn(
        `[webauthn] navigator.credentials.${kind}() chamado\n  ${stack}`,
        options,
      );
      return (original[kind] as (o?: unknown) => Promise<Credential | null>)(options);
    };

  navigator.credentials.get = wrap('get') as typeof navigator.credentials.get;
  navigator.credentials.create = wrap('create') as typeof navigator.credentials.create;
}
