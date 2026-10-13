// Especificação OpenAPI da API.
//
// Escrita à mão de propósito: o Hono não tem decorators, então gerar a partir
// do código exigiria uma camada de schema em cada rota. O que impede o
// apodrecimento é o teste em test/openapi.test.ts, que compara este documento
// com as rotas REALMENTE registradas no app (`app.routes`) — rota nova sem
// documentação, ou documentação de rota que não existe mais, quebra o CI.
import { version } from './version.js';

const ERROR_RESPONSE = {
  description: 'Falha. `errorCode` é estável e serve para o cliente decidir.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
};

const ADDRESS_PARAM = {
  name: 'address',
  in: 'path',
  required: true,
  description: 'C-address da smart account.',
  schema: { type: 'string', pattern: '^C[A-Z2-7]{55}$' },
};

/** Autenticação aceita por endpoint. */
const PANEL_OR_SERVICE = [{ sessionCookie: [] }, { secretKey: [] }];
const SERVICE_ONLY = [{ secretKey: [] }];

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Abstraction API',
    version,
    license: { name: 'MIT', identifier: 'MIT' },
    description: [
      'Smart accounts na Stellar com taxas patrocinadas.\n\n' +
      'Dois modelos de custódia, e a escolha é de quem integra:\n\n' +
      '· **Custodial** (`POST /v1/master/provision`) — a plataforma provisiona a ' +
      'conta e as permissões com chaves derivadas. O tenant faz login no portal e ' +
      'já encontra tudo pronto: não registra digital, não guarda seed, não assina ' +
      'nada. É o caminho para quem quer a chain invisível.\n\n' +
      '· **Auto-custódia** (painel + passkey) — o dono cria a conta com passkey e ' +
      'concede as permissões ele mesmo. Ninguém além dele assina.',
      '',
      '## Autenticação',
      '',
      'Três modos, e qual vale depende do endpoint:',
      '',
      '- **publishable key** (`pk_…`) — pública por construção. Vai no PATH do',
      '  relay porque o `RelayerClient` do smart-account-kit não manda header',
      '  nenhum além de `Content-Type` e `X-Client-*`. Identifica o app; quem',
      '  segura o gasto é a policy, não a chave.',
      '- **cookie de sessão** — o dono da conta, depois de provar posse da',
      '  passkey em `/v1/authn/verify`.',
      '- **secret key** (`sk_…`) — chamada servidor-a-servidor, em',
      '  `Authorization: Bearer`. Fala por qualquer conta do app.',
      '',
      '## Erros',
      '',
      'Toda falha responde `{success:false, error, errorCode}`. O `errorCode` é',
      'o contrato estável; a mensagem é para humano.',
    ].join('\n'),
  },
  servers: [
    { url: 'http://localhost:8080', description: 'desenvolvimento' },
    {
      url: '{host}',
      description: 'outro ambiente',
      variables: { host: { default: 'https://api.abstraction.local', description: 'host do deploy' } },
    },
  ],
  tags: [
    { name: 'health', description: 'Liveness e readiness.' },
    { name: 'relay', description: 'Submissão patrocinada — o endpoint que o kit chama.' },
    { name: 'authn', description: 'Sessão do painel por passkey.' },
    { name: 'accounts', description: 'Registry de smart accounts, saldo e cota.' },
    { name: 'faucet', description: 'XLM de testnet e ativação da cota.' },
    { name: 'sessions', description: 'Grants que a conta concede a um app.' },
    { name: 'master', description: 'Conta mestre do tenant e a permissão do serviço.' },
    { name: 'ledger', description: 'Inventário de itens por UUID.' },
    { name: 'email', description: 'Attestations de email (sem UI).' },
  ],

  paths: {
    // ── health ──────────────────────────────────────────────────────────────
    '/health': {
      get: {
        operationId: 'healthLive',
        tags: ['health'],
        summary: 'Liveness',
        security: [],
        responses: {
          200: {
            description: 'O processo está de pé.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' }, network: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'healthReady',
        tags: ['health'],
        summary: 'Readiness',
        description: 'Confere banco e RPC. Job morto no outbox é reportado, mas não derruba.',
        security: [],
        responses: {
          200: { description: 'Pronto para servir tráfego.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Readiness' } } } },
          503: { description: 'Banco ou RPC indisponível.' },
        },
      },
    },

    // ── relay ───────────────────────────────────────────────────────────────
    '/v1/relay/{publishableKey}': {
      post: {
        operationId: 'relaySubmit',
        tags: ['relay'],
        summary: 'Submete uma transação patrocinada',
        description: [
          'O endpoint que o smart-account-kit chama. A chave vai no path porque',
          'o `RelayerClient` não expõe gancho para header de autenticação.',
          '',
          'Aceita `{func, auth}` (o proxy monta e paga) ou `{xdr}` (envelopa em',
          'fee-bump). Antes de pagar aplica allowlist de alvos, teto por',
          'transação e reserva atômica da quota diária.',
          '',
          'Desligado com `RELAY_ENABLED=false` (padrão fora de development): a rota',
          'responde 404.',
        ].join('\n'),
        security: [],
        parameters: [
          {
            name: 'publishableKey',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'pk_test_dev' },
          },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Repetir a mesma chave devolve o resultado anterior em vez de pagar de novo.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['func'],
                    properties: {
                      func: { type: 'string', description: 'HostFunction em XDR base64.' },
                      auth: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'SorobanAuthorizationEntry em XDR base64.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    required: ['xdr'],
                    properties: {
                      xdr: { type: 'string', description: 'Transação assinada em XDR base64.' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Submetida e confirmada.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    hash: { type: 'string' },
                    status: { type: 'string', example: 'SUCCESS' },
                  },
                },
              },
            },
          },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: {
            ...ERROR_RESPONSE,
            description:
              'Recusada pela policy: `UNAUTHORIZED` (alvo fora da allowlist), ' +
              '`FEE_LIMIT_EXCEEDED` (teto por tx ou cota diária), `ALLOWLIST_EMPTY`.',
          },
          429: ERROR_RESPONSE,
          502: { ...ERROR_RESPONSE, description: 'A transação não confirmou on-chain.' },
          503: { ...ERROR_RESPONSE, description: 'Nenhuma conta pagadora livre. Tente de novo.' },
        },
      },
    },

    // ── authn ───────────────────────────────────────────────────────────────
    '/v1/authn/challenge': {
      post: {
        operationId: 'authnChallenge',
        tags: ['authn'],
        summary: 'Nonce para a assertion de passkey',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contractId', 'publishableKey'],
                properties: {
                  contractId: { type: 'string' },
                  publishableKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Nonce e credenciais aceitas.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    challenge: { type: 'string', description: 'base64url' },
                    rpId: { type: 'string' },
                    allowCredentials: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'string' } } },
                    },
                  },
                },
              },
            },
          },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/authn/verify': {
      post: {
        operationId: 'authnVerify',
        tags: ['authn'],
        summary: 'Troca a assertion por um cookie de sessão',
        description:
          'Assertion WebAuthn comum, verificada contra a chave P-256 registrada. ' +
          'Não autoriza transação — só prova ao painel quem está pedindo.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature', 'challenge'],
                properties: {
                  credentialId: { type: 'string' },
                  authenticatorData: { type: 'string', description: 'base64url' },
                  clientDataJSON: { type: 'string', description: 'base64url' },
                  signature: { type: 'string', description: 'DER em base64url' },
                  challenge: { type: 'string', description: 'o nonce recebido' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Sessão aberta; o cookie vem no `Set-Cookie`.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthnVerified' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
        },
      },
    },
    '/v1/authn/password': {
      post: {
        operationId: 'authnPassword',
        tags: ['authn'],
        summary: 'Sessão do painel por e-mail e senha',
        description: [
          'Para a conta mestre **custodial**, que não tem passkey registrada — ela',
          'é provisionada pelo serviço com chave derivada, e sem este caminho o dono',
          'não conseguiria abrir o próprio painel.',
          '',
          'Prova quem é o humano, não quem controla a chave. A sessão dá leitura e',
          'as operações que o SERVIÇO executa em nome da conta; assinar no browser',
          'continua exigindo passkey, e no modelo custodial ninguém assina no browser.',
          '',
          'E-mail inexistente e senha errada devolvem a mesma coisa, de propósito.',
        ].join('\n'),
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Sessão aberta; o cookie httpOnly vai no Set-Cookie.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    contractId: { type: 'string' },
                    custodial: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          429: ERROR_RESPONSE,
        },
      },
    },
    '/v1/authn/session': {
      get: {
        operationId: 'authnSession',
        tags: ['authn'],
        summary: 'Quem está logado nesta sessão',
        description:
          'O painel usa para sobreviver a um reload. Com passkey a conta vem do ' +
          'IndexedDB do kit; numa sessão custodial o browser não guarda nada, e o ' +
          'cookie httpOnly não é legível por JS. `custodial` é derivado da ausência ' +
          'de passkey na conta.',
        security: [{ sessionCookie: [] }],
        responses: {
          200: {
            description: 'A conta desta sessão.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    contractId: { type: 'string' },
                    custodial: { type: 'boolean' },
                  },
                },
              },
            },
          },
          401: ERROR_RESPONSE,
        },
      },
    },
    '/v1/authn/logout': {
      post: {
        operationId: 'authnLogout',
        tags: ['authn'],
        summary: 'Encerra a sessão do painel',
        security: [{ sessionCookie: [] }],
        responses: { 200: { description: 'Encerrada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } } },
      },
    },

    // ── accounts ────────────────────────────────────────────────────────────
    '/v1/accounts': {
      post: {
        operationId: 'registerAccount',
        tags: ['accounts'],
        summary: 'Registra uma smart account',
        description:
          'Aceita publishable key no body (browser, logo após o deploy) ou secret ' +
          'key no header (backend registrando em nome de um usuário). Confere ' +
          'on-chain que o contrato existe antes de gravar.',
        security: [{}, { secretKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contractId'],
                properties: {
                  contractId: { type: 'string', pattern: '^C[A-Z2-7]{55}$' },
                  credentialId: { type: 'string' },
                  publicKeyHex: {
                    type: 'string',
                    description: 'Chave P-256 não comprimida, 65 bytes em hex.',
                  },
                  externalId: {
                    type: 'string',
                    description: 'Id do usuário no sistema consumidor. É o que amarra os dois lados.',
                  },
                  label: { type: 'string' },
                  deployTxHash: { type: 'string' },
                  publishableKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Registrada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisteredAccount' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: {
            ...ERROR_RESPONSE,
            description:
              '`FORBIDDEN`: registro com publishable key desligado (`ACCOUNT_SELF_REGISTRATION`).',
          },
          409: {
            ...ERROR_RESPONSE,
            description:
              '`ACCOUNT_NOT_DEPLOYED`: a conta ainda não existe on-chain. `ACCOUNT_EXISTS`: com ' +
              'publishable key só se registra conta nova — credencial em conta existente, só ' +
              'com secret key.',
          },
          429: ERROR_RESPONSE,
        },
      },
      get: {
        operationId: 'findAccountByExternalId',
        tags: ['accounts'],
        summary: 'Busca a conta pelo id externo',
        security: SERVICE_ONLY,
        parameters: [
          { name: 'externalId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Encontrada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisteredAccount' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/accounts/{address}': {
      get: {
        operationId: 'getAccount',
        tags: ['accounts'],
        summary: 'Estado da conta',
        description: 'Saldo lido do SAC e allowance lida do Treasury, ambos por simulação.',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: {
            description: 'Estado atual.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AccountState' },
              },
            },
          },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/accounts/{address}/usage': {
      get: {
        operationId: 'getAccountUsage',
        tags: ['accounts'],
        summary: 'Cota de taxas patrocinadas do dia',
        description:
          '`reserved` é o que está comprometido por transações em voo — contar só ' +
          'o liquidado faria o número mentir por alguns segundos.',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: {
            description: 'Consumo do dia, off-chain e on-chain.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Usage' } },
            },
          },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/accounts/{address}/sponsorships': {
      get: {
        operationId: 'listSponsorships',
        tags: ['accounts'],
        summary: 'Histórico de patrocínios',
        description: '`reservedStroops` é o teto; `chargedStroops` é o que a rede cobrou.',
        security: PANEL_OR_SERVICE,
        parameters: [
          ADDRESS_PARAM,
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Página do histórico.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SponsorshipPage' } } } },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },

    // ── faucet ──────────────────────────────────────────────────────────────
    '/v1/accounts/{address}/faucet': {
      get: {
        operationId: 'getFaucetStatus',
        tags: ['faucet'],
        summary: 'Estado do faucet e cooldown',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: { description: 'Disponibilidade e último claim.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FaucetStatus' } } } },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
      post: {
        operationId: 'claimFaucet',
        tags: ['faucet'],
        summary: 'Recebe XLM de testnet e ativa a cota',
        description: [
          'Duas pernas numa ação:',
          '',
          '1. XLM na smart account. O friendbot não financia contract address, então',
          '   a transferência sai da conta de faucet pelo SAC.',
          '2. Allowance no Treasury, pelo outbox — o cliente não espera dois blocos.',
          '',
          'Cooldown e claim em voo são garantidos por índice único no banco: duplo',
          'clique e dois pods caem no mesmo lugar.',
        ].join('\n'),
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: { description: 'XLM enviado; a cota conclui em segundos.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FaucetClaim' } } } },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
          409: { ...ERROR_RESPONSE, description: '`ACCOUNT_NOT_DEPLOYED` ou `FAUCET_IN_FLIGHT`.' },
          429: { ...ERROR_RESPONSE, description: '`FAUCET_COOLDOWN` ou `RATE_LIMITED`.' },
          502: { ...ERROR_RESPONSE, description: '`FAUCET_FAILED`: a transferência não passou.' },
          503: { ...ERROR_RESPONSE, description: '`FAUCET_DRY`: a conta de faucet está sem saldo.' },
        },
      },
    },
    '/v1/accounts/{address}/faucet/allowance': {
      post: {
        operationId: 'retryFaucetAllowance',
        tags: ['faucet'],
        summary: 'Reenvia só a ativação da cota',
        description: 'Para o caso em que o XLM chegou mas a allowance não fechou.',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: { description: 'Enfileirada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Queued' } } } },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
          409: ERROR_RESPONSE,
        },
      },
    },

    // ── sessions ────────────────────────────────────────────────────────────
    '/v1/accounts/{address}/sessions': {
      get: {
        operationId: 'listGrants',
        tags: ['sessions'],
        summary: 'Grants concedidos pela conta',
        description:
          'Inclui o orçamento restante, simulado na policy. `expiresInSeconds` é ' +
          'null quando o grant não tem prazo — o normal.',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        responses: {
          200: {
            description: 'Grants e ledger atual.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    currentLedger: { type: 'integer' },
                    items: { type: 'array', items: { $ref: '#/components/schemas/SessionGrant' } },
                  },
                },
              },
            },
          },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
      post: {
        operationId: 'registerGrant',
        tags: ['sessions'],
        summary: 'Registra um grant criado no browser',
        description: 'A regra é assinada com a passkey do dono; aqui só o metadado.',
        security: PANEL_OR_SERVICE,
        parameters: [ADDRESS_PARAM],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'targetContract', 'ed25519PublicKey', 'policyAddress', 'spendingLimitStroops', 'periodLedgers'],
                properties: {
                  contextRuleId: { type: ['integer', 'null'] },
                  name: { type: 'string', maxLength: 32 },
                  targetContract: { type: 'string', pattern: '^C[A-Z2-7]{55}$' },
                  ed25519PublicKey: { type: 'string', description: '32 bytes em hex' },
                  policyAddress: { type: 'string' },
                  spendingLimitStroops: { type: 'string' },
                  periodLedgers: { type: 'integer' },
                  validUntilLedger: { type: ['string', 'null'], description: 'null = sem prazo' },
                  grantTxHash: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Registrado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatedGrant' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/accounts/{address}/sessions/{ruleId}': {
      delete: {
        operationId: 'revokeGrant',
        tags: ['sessions'],
        summary: 'Marca um grant como revogado',
        description: 'A revogação on-chain é assinada no browser; aqui o registro acompanha.',
        security: PANEL_OR_SERVICE,
        parameters: [
          ADDRESS_PARAM,
          { name: 'ruleId', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'txHash', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Revogado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } },
          401: ERROR_RESPONSE,
          404: ERROR_RESPONSE,
        },
      },
    },

    // ── master ──────────────────────────────────────────────────────────────
    '/v1/master': {
      get: {
        operationId: 'getMaster',
        tags: ['master'],
        summary: 'Conta mestre, chave do serviço e cota consumida',
        description: 'A cota vem do contrato, não da nossa contabilidade.',
        security: PANEL_OR_SERVICE,
        responses: {
          200: {
            description: 'Estado da conta mestre.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MasterState' } } },
          },
          401: ERROR_RESPONSE,
          403: { ...ERROR_RESPONSE, description: '`FORBIDDEN`: sessão que não é da própria conta mestre.' },
        },
      },
      post: {
        operationId: 'setMasterAccount',
        tags: ['master'],
        summary: 'Define qual conta é a mestre do tenant',
        security: PANEL_OR_SERVICE,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contractId'],
                properties: { contractId: { type: 'string', pattern: '^C[A-Z2-7]{55}$' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Definida.', content: { 'application/json': { schema: { $ref: '#/components/schemas/MasterAccountSet' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: {
            ...ERROR_RESPONSE,
            description:
              '`FORBIDDEN`: com mestre já definida, só a secret key ou a sessão da própria ' +
              'mestre a trocam; sem mestre, sessão só com `PANEL_MASTER_ADMIN`.',
          },
          404: ERROR_RESPONSE,
        },
      },
    },
    '/v1/master/provision': {
      post: {
        operationId: 'provisionMaster',
        tags: ['master'],
        summary: 'Provisiona a conta mestre do tenant, sem passkey',
        description: [
          'O caminho do produto: o tenant faz login social e já encontra a conta',
          'pronta. Não registra digital, não guarda seed, não assina nada.',
          '',
          'Três transações patrocinadas: deploy da smart account com a chave de',
          'OWNER na regra `Default`, depois uma regra `CallContract` por alvo com a',
          'chave do SERVIÇO e a cota instalada.',
          '',
          'Duas chaves porque a cota precisa ser fronteira de verdade: a chave que',
          'minta todo dia não está na `Default`, então não consegue alterar a regra',
          'que a limita, adicionar signer nem mover fundos.',
          '',
          '**Idempotente.** O deployer é fixo (o primeiro channel configurado) e a',
          'mestre já existente é reaproveitada; regra que já existe on-chain não é',
          'recriada. Repetir completa só o que falta — útil quando a segunda regra',
          'falhou e a primeira não. Chamadas simultâneas do mesmo app recebem 409',
          '`PROVISION_IN_PROGRESS`.',
          '',
          'No fim, a mestre entra na allowlist dos dois ledgers (`set_minter` no',
          'inventário, `set_writer` na âncora), assinada pelo registrar do serviço.',
          '',
          'Sem mestre ainda, só a secret key provisiona.',
        ].join('\n'),
        security: PANEL_OR_SERVICE,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ledgerMaxItems: { type: 'integer', default: 10000, description: 'Teto de itens do inventário.' },
                  anchorMaxItems: { type: 'integer', default: 50000, description: 'Teto de eventos ancorados.' },
                  periodLedgers: { type: 'integer', default: 518400, description: 'Janela deslizante. Default: 30 dias.' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Provisionada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProvisionResult' } } } },
          401: ERROR_RESPONSE,
          403: ERROR_RESPONSE,
          409: { ...ERROR_RESPONSE, description: '`PROVISION_IN_PROGRESS` ou `NOT_CONFIGURED`.' },
          502: ERROR_RESPONSE,
          503: { ...ERROR_RESPONSE, description: '`FEE_CAP`, `NO_CHANNEL_AVAILABLE` ou `CONTRACT_BUSY` (fila de escrita do contrato cheia — ~1 escrita por ledger): temporário.' },
        },
      },
    },
    '/v1/master/grant': {
      post: {
        operationId: 'registerMasterGrant',
        tags: ['master'],
        summary: 'Registra a permissão concedida ao serviço',
        description:
          'A regra é criada no browser com a passkey do tenant — o serviço não ' +
          'pode conceder poder a si mesmo. Aqui só o metadado.',
        security: PANEL_OR_SERVICE,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['maxItems', 'periodLedgers'],
                properties: {
                  contextRuleId: { type: ['integer', 'null'] },
                  maxItems: { type: 'integer', description: 'Itens autorizados na janela.' },
                  periodLedgers: { type: 'integer' },
                  grantTxHash: { type: 'string' },
                  target: {
                    type: 'string',
                    enum: ['ledger', 'anchor'],
                    default: 'ledger',
                    description:
                      'Qual contrato a regra autoriza: `ledger` é o inventário de ' +
                      'itens, `anchor` é o histórico contábil. Cada um tem cota ' +
                      'própria — reconceder um não mexe no outro.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Registrada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatedGrant' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: ERROR_RESPONSE,
          409: ERROR_RESPONSE,
        },
      },
      delete: {
        operationId: 'revokeMasterGrant',
        tags: ['master'],
        summary: 'Revoga a permissão do serviço',
        security: PANEL_OR_SERVICE,
        parameters: [
          {
            name: 'target',
            in: 'query',
            schema: { type: 'string', enum: ['ledger', 'anchor'], default: 'ledger' },
            description: 'Qual grant revogar. Omitido, o do inventário.',
          },
        ],
        responses: { 200: { description: 'Revogada.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 401: ERROR_RESPONSE, 403: ERROR_RESPONSE },
      },
    },

    // ── ledger ──────────────────────────────────────────────────────────────
    '/v1/ledger/mint': {
      post: {
        operationId: 'mintBatch',
        tags: ['ledger'],
        summary: 'Minta um lote como a conta mestre',
        description: [
          'Até 10 UUIDs por chamada — é o limite de escritas de uma transação',
          'Soroban: cada item grava 3 entradas no contrato.',
          '',
          'A cota concedida pelo tenant conta ITENS: um lote de 10 desconta 10, e',
          'um lote maior que o teto é recusado inteiro.',
          '',
          '**Idempotente por UUID.** Repetir um lote já mintado devolve 200 com',
          '`alreadyMinted: true` e o hash original, sem nova transação. Um UUID cuja',
          'tentativa anterior falhou (ou travou) é conferido na chain: se o item já',
          'é da mestre, a linha é confirmada; se não existe, a tentativa é refeita',
          'reaproveitando a linha.',
        ].join('\n'),
        security: SERVICE_ONLY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['uuids', 'name'],
                properties: {
                  uuids: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 10,
                    items: { type: 'string' },
                    description: 'A mesma chave que o banco do sistema consumidor guarda.',
                  },
                  name: { type: 'string', maxLength: 64 },
                  fields: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                    description: 'Campos livres, até 16, gravados no contrato.',
                  },
                  metadata: {
                    type: 'object',
                    description: 'Vai para o payload off-chain do evento, não para a chain.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Lote mintado, ou já mintado antes (`alreadyMinted`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/MintResult' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: { ...ERROR_RESPONSE, description: '`QUOTA_EXCEEDED`: a cota concedida acabou.' },
          409: {
            ...ERROR_RESPONSE,
            description:
              '`NO_GRANT`; `UUID_TAKEN` (parte do lote já existe, ou o item é de outro dono); ' +
              '`UUID_PENDING` (tentativa anterior ainda em voo — repita em instantes).',
          },
          502: ERROR_RESPONSE,
          503: { ...ERROR_RESPONSE, description: '`FEE_CAP`, `NO_CHANNEL_AVAILABLE` ou `CONTRACT_BUSY` (fila de escrita do contrato cheia — ~1 escrita por ledger): temporário.' },
        },
      },
    },
    '/v1/ledger/transfer': {
      post: {
        operationId: 'transferItem',
        tags: ['ledger'],
        summary: 'Venda: passa a posse de um item',
        security: SERVICE_ONLY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['uuid', 'to'],
                properties: {
                  uuid: { type: 'string' },
                  to: { type: 'string', pattern: '^[GC][A-Z2-7]{55}$' },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Posse transferida.', content: { 'application/json': { schema: { $ref: '#/components/schemas/TransferResult' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          409: {
            ...ERROR_RESPONSE,
            description:
              '`NOT_OWNER`: depois da primeira venda quem autoriza é o comprador, ' +
              'não a conta mestre. Ou `NO_GRANT`.',
          },
          502: ERROR_RESPONSE,
          503: { ...ERROR_RESPONSE, description: '`FEE_CAP`, `NO_CHANNEL_AVAILABLE` ou `CONTRACT_BUSY` (fila de escrita do contrato cheia — ~1 escrita por ledger): temporário.' },
        },
      },
    },
    '/v1/ledger/record': {
      post: {
        operationId: 'recordAnchor',
        tags: ['ledger'],
        summary: 'Ancora um evento de negócio',
        description: [
          'Para o que **não** é item: compra de crédito, dedução, reembolso, split,',
          'cancelamento. Não tem dono, não entra no inventário e não gasta a cota de',
          'mint — o alvo é o contrato de âncora, com grant próprio.',
          '',
          'On-chain vai o indispensável (tenant, tipo, referência, valor e o sha256',
          'do payload). O JSON inteiro fica off-chain e o hash amarra os dois: dá',
          'para provar depois que o registro guardado não foi editado.',
          '',
          '**Não deduplica.** Dois `credit_lock` da mesma transação são dois eventos,',
          'e recusar o segundo apagaria histórico real. Quem deduplica é o consumidor,',
          'que tem o contexto.',
        ].join('\n'),
        security: SERVICE_ONLY,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tenantId', 'kind'],
                properties: {
                  tenantId: {
                    type: 'string',
                    maxLength: 64,
                    description: 'Tenant do sistema consumidor. Vai gravado no registro.',
                  },
                  kind: {
                    type: 'string',
                    pattern: '^[a-zA-Z0-9_]{1,32}$',
                    description:
                      'Tipo do evento. Vira `Symbol` on-chain, daí o alfabeto restrito.',
                    examples: ['credit_purchase', 'refund', 'marketplace_transfer'],
                  },
                  reference: {
                    type: 'string',
                    maxLength: 128,
                    description:
                      'Chave de negócio (transactionId / orderId / listingId) — é por ' +
                      'ela que se acha o registro do outro lado.',
                  },
                  payload: {
                    oneOf: [{ type: 'object' }, { type: 'string' }],
                    description: 'O evento completo. Fica off-chain; só o hash sobe.',
                  },
                  amount: {
                    type: ['string', 'integer'],
                    description:
                      'Inteiro na MENOR unidade (centavos). `i128` não aceita ' +
                      'fracionário — `19.90` é recusado, `1990` não. Default: 1.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Ancorado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnchorResult' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          403: { ...ERROR_RESPONSE, description: '`QUOTA_EXCEEDED`: a cota de âncoras acabou.' },
          409: { ...ERROR_RESPONSE, description: '`NO_GRANT`: o tenant não concedeu o grant de âncora.' },
          502: ERROR_RESPONSE,
          503: { ...ERROR_RESPONSE, description: '`FEE_CAP`, `NO_CHANNEL_AVAILABLE` ou `CONTRACT_BUSY` (fila de escrita do contrato cheia — ~1 escrita por ledger): temporário.' },
        },
      },
    },
    '/v1/ledger/records': {
      get: {
        operationId: 'listAnchors',
        tags: ['ledger'],
        summary: 'Histórico de âncoras, com o payload completo',
        security: PANEL_OR_SERVICE,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'kind', in: 'query', schema: { type: 'string' }, description: 'Filtra pelo tipo do evento.' },
          { name: 'reference', in: 'query', schema: { type: 'string' }, description: 'Filtra pela chave de negócio.' },
        ],
        responses: {
          200: { description: 'Âncoras, da mais recente para a mais antiga.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AnchorPage' } } } },
          401: ERROR_RESPONSE,
        },
      },
    },
    '/v1/ledger': {
      get: {
        operationId: 'listLedger',
        tags: ['ledger'],
        summary: 'Página do ledger, lida on-chain',
        description: 'Leitura pública: um ledger que só o dono enxerga não demonstra nada.',
        security: [],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'owner', in: 'query', schema: { type: 'string' }, description: 'Filtra a página por dono.' },
        ],
        responses: {
          200: {
            description: 'Itens, do mais recente para o mais antigo.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    items: { type: 'array', items: { $ref: '#/components/schemas/LedgerRecord' } },
                  },
                },
              },
            },
          },
          409: { ...ERROR_RESPONSE, description: '`NOT_CONFIGURED`: sem contrato de ledger.' },
        },
      },
    },
    '/v1/ledger/{uuid}': {
      get: {
        operationId: 'getLedgerItem',
        tags: ['ledger'],
        summary: 'Um item pelo UUID',
        security: [],
        parameters: [{ name: 'uuid', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'O item.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    record: {
                      allOf: [
                        { $ref: '#/components/schemas/LedgerRecord' },
                        {
                          type: 'object',
                          properties: {
                            mintTxHash: {
                              type: ['string', 'null'],
                              description:
                                'Transação que mintou, guardada pelo serviço (o contrato não ' +
                                'guarda). `null` quando o mint foi confirmado só pela leitura ' +
                                'on-chain.',
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: ERROR_RESPONSE,
          409: ERROR_RESPONSE,
        },
      },
    },
    '/v1/ledger/entries': {
      get: {
        operationId: 'listLedgerEntries',
        tags: ['ledger'],
        summary: 'Eventos do ledger com o payload completo',
        description:
          'On-chain fica o indispensável; o payload do evento de negócio fica aqui, ' +
          'com o hash que o commita.',
        security: PANEL_OR_SERVICE,
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Eventos.', content: { 'application/json': { schema: { $ref: '#/components/schemas/LedgerEntryPage' } } } },
          401: ERROR_RESPONSE,
          403: ERROR_RESPONSE,
        },
      },
    },
    '/v1/accounts/{address}/ledger': {
      get: {
        operationId: 'listAccountItems',
        tags: ['ledger'],
        summary: 'Itens em posse de uma conta',
        description: 'Paginado no contrato; a ordem da lista de um dono não é estável.',
        security: [],
        parameters: [
          ADDRESS_PARAM,
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Itens da conta.', content: { 'application/json': { schema: { $ref: '#/components/schemas/LedgerPage' } } } },
          409: ERROR_RESPONSE,
        },
      },
    },

    // ── email ───────────────────────────────────────────────────────────────
    '/v1/email/issuer': {
      get: {
        operationId: 'getEmailIssuer',
        tags: ['email'],
        summary: 'Chave pública do emissor',
        description: 'É o que o `email-attestation-verifier` confere on-chain.',
        security: [],
        responses: { 200: { description: 'Chave pública em hex.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailIssuer' } } } } },
      },
    },
    '/v1/email/request': {
      post: {
        operationId: 'requestEmailCode',
        tags: ['email'],
        summary: 'Envia o código por email',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
            },
          },
        },
        responses: {
          200: { description: 'Enviado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Accepted' } } } },
          400: ERROR_RESPONSE,
          429: ERROR_RESPONSE,
        },
      },
    },
    '/v1/email/verify': {
      post: {
        operationId: 'verifyEmailCode',
        tags: ['email'],
        summary: 'Troca o código por uma sessão de email',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'code'],
                properties: { email: { type: 'string' }, code: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Token, subjectHash e keyData para registrar o signer.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailSession' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          429: ERROR_RESPONSE,
        },
      },
    },
    '/v1/email/attest': {
      post: {
        operationId: 'issueEmailAttestation',
        tags: ['email'],
        summary: 'Emite a attestation de uma transação',
        description:
          'O `challenge` é o auth digest exato da transação — replay em outra ' +
          'transação, rede ou seleção de regra é inválido por construção. O mesmo ' +
          'par (subject, challenge) só é assinado uma vez.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'challenge'],
                properties: {
                  token: { type: 'string' },
                  challenge: { type: 'string', description: 'auth digest de 32 bytes em hex' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'sigDataXdr e expiração.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailAttestation' } } } },
          400: ERROR_RESPONSE,
          401: ERROR_RESPONSE,
          409: { ...ERROR_RESPONSE, description: '`ALREADY_ISSUED`: challenge já assinado.' },
          429: ERROR_RESPONSE,
        },
      },
    },
  },

  components: {
    securitySchemes: {
      secretKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'Secret key do app (`sk_…`). Fala por qualquer conta do app.',
      },
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'abstraction_session',
        description: 'Sessão do painel, aberta em `/v1/authn/verify`. Só fala pela própria conta.',
      },
    },
    schemas: {
      Ok: {
        type: 'object',
        properties: { success: { type: 'boolean', const: true } },
      },
      Accepted: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true } },
      },
      Queued: {
        type: 'object',
        properties: { success: { type: 'boolean' }, queued: { type: 'boolean' } },
      },
      Readiness: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          checks: {
            type: 'object',
            properties: {
              db: {},
              rpc: {},
              outboxDead: { description: 'Jobs que esgotaram as tentativas. Alerta, não indisponibilidade.' },
            },
          },
        },
      },
      AuthnVerified: {
        type: 'object',
        properties: { success: { type: 'boolean' }, contractId: { type: 'string' } },
      },
      AccountSummary: {
        type: 'object',
        properties: {
          contractId: { type: 'string' },
          externalId: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['pending', 'deployed', 'failed'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      RegisteredAccount: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          account: { $ref: '#/components/schemas/AccountSummary' },
        },
      },
      MasterAccountSet: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          masterAccount: { type: 'string' },
          signer: {
            type: 'object',
            properties: { publicKeyHex: { type: 'string' }, verifier: { type: 'string' } },
          },
        },
      },
      CreatedGrant: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          id: { type: 'string', format: 'uuid' },
          state: { type: 'string' },
        },
      },
      Sponsorship: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          mode: { type: 'string', enum: ['invoke', 'feebump'] },
          isDeploy: { type: 'boolean' },
          targets: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['reserved', 'submitted', 'succeeded', 'failed', 'released'] },
          txHash: { type: ['string', 'null'] },
          txStatus: { type: ['string', 'null'] },
          chargedStroops: { type: ['string', 'null'], description: 'O que a rede cobrou.' },
          errorCode: { type: ['string', 'null'] },
        },
      },
      SponsorshipPage: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          items: { type: 'array', items: { $ref: '#/components/schemas/Sponsorship' } },
        },
      },
      FaucetStatus: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          amountStroops: { type: 'string' },
          cooldownHours: { type: 'integer' },
          blocked: { type: 'boolean' },
          nextAvailableAt: { type: ['string', 'null'], format: 'date-time' },
          last: {
            type: ['object', 'null'],
            properties: {
              state: { type: 'string', enum: ['pending', 'xlm_sent', 'allowance_set', 'done', 'failed'] },
              xlmTxHash: { type: ['string', 'null'] },
              createdAt: { type: 'string', format: 'date-time' },
              error: { type: ['string', 'null'] },
            },
          },
        },
      },
      FaucetClaim: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          claimId: { type: 'string', format: 'uuid' },
          state: { type: 'string' },
          amountStroops: { type: 'string' },
          xlmTxHash: { type: ['string', 'null'] },
          allowancePending: { type: 'boolean', description: 'A cota fecha em segundos, pelo outbox.' },
          nextAvailableAt: { type: 'string', format: 'date-time' },
        },
      },
      MintResult: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          minted: { type: 'integer', description: '0 quando `alreadyMinted`.' },
          uuids: { type: 'array', items: { type: 'string' } },
          hash: {
            type: ['string', 'null'],
            description: '`null` só em `alreadyMinted`, quando o lote saiu em mais de uma transação ou o hash se perdeu.',
          },
          alreadyMinted: { type: 'boolean', description: 'O lote inteiro já estava mintado; nada foi submetido.' },
          hashes: {
            type: 'object',
            additionalProperties: { type: ['string', 'null'] },
            description: 'Em `alreadyMinted`: hash do mint de cada UUID.',
          },
        },
      },
      TransferResult: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          uuid: { type: 'string' },
          to: { type: 'string' },
          hash: { type: 'string' },
        },
      },
      LedgerPage: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          contractId: { type: 'string' },
          total: { type: 'integer' },
          items: { type: 'array', items: { $ref: '#/components/schemas/LedgerRecord' } },
        },
      },
      LedgerEntry: {
        type: 'object',
        description: 'Evento de negócio: on-chain vai o indispensável, o payload fica aqui.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          uuid: { type: 'string' },
          kind: { type: 'string', enum: ['mint', 'transfer'] },
          owner: { type: ['string', 'null'] },
          payload: { type: 'object' },
          payloadHash: { type: 'string', description: 'sha256 do payload, truncado — commita o conteúdo.' },
          state: { type: 'string', enum: ['pending', 'confirmed', 'failed'] },
          txHash: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      LedgerEntryPage: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          items: { type: 'array', items: { $ref: '#/components/schemas/LedgerEntry' } },
        },
      },
      EmailIssuer: {
        type: 'object',
        properties: { issuerPublicKey: { type: 'string' } },
      },
      EmailSession: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          subjectHash: { type: 'string' },
          keyData: { type: 'string', description: 'issuer pubkey (32B) || subject hash (32B), em hex.' },
        },
      },
      EmailAttestation: {
        type: 'object',
        properties: {
          sigDataXdr: { type: 'string' },
          expiresAt: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', const: false },
          error: { type: 'string', description: 'Mensagem para humano.' },
          errorCode: {
            type: 'string',
            description: 'Contrato estável para o cliente decidir.',
            examples: ['FEE_LIMIT_EXCEEDED', 'FAUCET_COOLDOWN', 'NO_GRANT', 'QUOTA_EXCEEDED'],
          },
        },
      },
      AccountState: {
        type: 'object',
        properties: {
          account: {
            type: 'object',
            properties: {
              contractId: { type: 'string' },
              externalId: { type: ['string', 'null'] },
              status: { type: 'string', enum: ['pending', 'deployed', 'failed'] },
              deployTxHash: { type: ['string', 'null'] },
            },
          },
          balanceStroops: { type: ['string', 'null'] },
          allowance: {
            type: ['object', 'null'],
            description: 'Limites gravados no Treasury. Sem eles o débito falha com NoAllowance.',
            properties: {
              maxPerTxStroops: { type: 'string' },
              maxPerDayStroops: { type: 'string' },
              expiresAt: { type: ['integer', 'null'] },
            },
          },
        },
      },
      Usage: {
        type: 'object',
        properties: {
          spentStroops: { type: 'string', description: 'Liquidado.' },
          reservedStroops: { type: 'string', description: 'Comprometido por transações em voo.' },
          maxPerDayStroops: { type: 'string' },
          maxPerTxStroops: { type: 'string' },
          txCount: { type: 'integer' },
          resetsAt: { type: 'string', format: 'date-time' },
          onchain: {
            type: 'object',
            properties: {
              usageToday: { type: ['string', 'null'] },
              hasAllowance: { type: 'boolean' },
            },
          },
        },
      },
      SessionGrant: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          contextRuleId: { type: ['integer', 'null'] },
          name: { type: 'string' },
          targetContract: { type: 'string' },
          publicKey: { type: 'string' },
          state: { type: 'string', enum: ['pending', 'active', 'expired', 'revoked', 'failed'] },
          spendingLimitStroops: { type: 'string' },
          remainingStroops: { type: ['string', 'null'] },
          validUntilLedger: { type: ['string', 'null'] },
          expiresInSeconds: { type: ['integer', 'null'], description: 'null = sem prazo.' },
        },
      },
      MasterState: {
        type: 'object',
        properties: {
          masterAccount: { type: ['string', 'null'] },
          signer: {
            type: 'object',
            description: 'Chave que o serviço usa. Derivada, nunca guardada.',
            properties: { publicKeyHex: { type: 'string' }, verifier: { type: 'string' } },
          },
          ledgerContract: { type: 'string' },
          anchorContract: { type: 'string' },
          policyContract: { type: 'string' },
          grant: {
            type: ['object', 'null'],
            description: 'O grant do INVENTÁRIO. Mantido no singular para o painel antigo; os dois alvos estão em `targets`.',
          },
          targets: {
            type: 'object',
            description: 'Grant e cota por alvo, indexados por `ledger` e `anchor`.',
            additionalProperties: {
              type: 'object',
              properties: {
                contract: { type: 'string' },
                grant: { type: ['object', 'null'] },
                quota: { type: ['object', 'null'] },
              },
            },
          },
          quota: {
            type: ['object', 'null'],
            description: 'Lida do contrato.',
            properties: {
              maxItems: { type: 'integer' },
              used: { type: 'integer' },
              remaining: { type: 'integer' },
              windowResetsAtLedger: { type: 'integer' },
            },
          },
        },
      },
      ProvisionResult: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          masterAccount: { type: 'string' },
          deployHash: {
            type: ['string', 'null'],
            description: '`null` quando a conta já existia — repetir não redeploya.',
          },
          owner: { type: 'string', description: 'Chave que administra a conta (regra Default).' },
          signer: {
            type: 'object',
            properties: { publicKeyHex: { type: 'string' }, verifier: { type: 'string' } },
          },
          granted: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['ledger', 'anchor'] },
                contextRuleId: { type: ['integer', 'null'] },
                hash: {
                  type: ['string', 'null'],
                  description: '`null` quando a regra já existia on-chain e foi reaproveitada.',
                },
              },
            },
          },
          roles: {
            type: 'array',
            description: 'A mestre na allowlist de cada ledger.',
            items: {
              type: 'object',
              properties: {
                contract: { type: 'string' },
                role: { type: 'string', enum: ['minter', 'writer'] },
                changed: { type: 'boolean', description: '`false` quando já estava habilitada.' },
                hash: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      AnchorResult: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          hash: { type: 'string', description: 'Transação Stellar que gravou o registro.' },
          contract: { type: 'string' },
          payloadHash: {
            type: 'string',
            description:
              'sha256 COMPLETO (64 hex) do payload gravado. É o que o contrato guarda ' +
              'em `BytesN<32>` e o que `verify` confere.',
          },
          entryId: { type: 'string', format: 'uuid' },
        },
      },
      Anchor: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference: { type: 'string' },
          payload: { type: 'object' },
          payloadHash: { type: 'string' },
          state: { type: 'string', enum: ['pending', 'confirmed', 'failed'] },
          txHash: { type: ['string', 'null'] },
          error: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AnchorPage: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          items: { type: 'array', items: { $ref: '#/components/schemas/Anchor' } },
        },
      },
      LedgerRecord: {
        type: 'object',
        properties: {
          uuid: { type: 'string', description: 'Chave gerada fora da chain.' },
          owner: { type: 'string', description: 'Dono atual; muda a cada venda.' },
          minter: { type: 'string', description: 'Quem mintou; não muda.' },
          name: { type: 'string' },
          uri: { type: 'string' },
          fields: { type: 'object', additionalProperties: { type: 'string' } },
          mintedAt: { type: 'integer' },
          mintedLedger: { type: 'integer' },
          transfers: { type: 'integer' },
        },
      },
    },
  },
} as const;
